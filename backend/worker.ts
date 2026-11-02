// Background worker:
//   * retries queued operations (backlog with exponential backoff -> "dead" after max attempts)
//   * polls sent device commands until the device acknowledges / finishes
//   * expires unconfirmed destructive commands
//   * periodic Zoho -> Supabase sync per connected enterprise
//   * monitoring: security scan, location polling + geofences, admin-activity checks, location purge
// Run separately with `deno task worker`, or inline with RUN_WORKER_INLINE=true.
import { getConfig } from "./config.ts";
import { db, run } from "./lib/db.ts";
import { toAppError } from "./lib/errors.ts";
import { log } from "./lib/log.ts";
import { withLease } from "./lib/lease.ts";
import { claimDue, processEvent, updateEvent } from "./services/events.ts";
import { pollCommandStatus } from "./services/commands.ts";
import { syncEnterprise } from "./services/sync.ts";
import { checkAdminActivity, getSettings, scanAutomation } from "./services/monitoring.ts";
import { scanEnterprise } from "./services/security-scan.ts";
import { pollEnterpriseLocations } from "./services/locations.ts";
import "./services/groups.ts";
import "./services/profiles.ts";
import "./services/apps.ts";
import "./services/announcements.ts";
import { dailyTickAll } from "./services/bridge/automation.ts";

let ticking = false;

// Durable debounce state (migration 015). Previously these were module-level
// vars initialised to 0, which on Deno Deploy reset every cold start and
// caused the "sync every ~60s" cascade. Reads happen once per key per tick;
// writes only when the debounce window has actually elapsed.
async function readTs(key: string): Promise<number> {
  const { data } = await db().from("worker_state").select("value").eq("key", key).maybeSingle();
  const v = (data?.value as { ts?: number } | null | undefined)?.ts;
  return typeof v === "number" ? v : 0;
}

async function writeTs(key: string, ts: number): Promise<void> {
  await db().from("worker_state").upsert({ key, value: { ts }, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

export async function tick(): Promise<void> {
  if (ticking) return; // never overlap
  ticking = true;
  try {
    const { data: expired } = await db().rpc("expire_unconfirmed_events");
    if (expired) log("info", "worker.expired_confirmations", { count: expired });

    // One event per claim: a claim holds the row for 2 minutes, so claiming a batch of 20 and
    // working through it serially could outlive the claim and let a second worker send it again.
    for (let i = 0; i < 20; i++) {
      const [ev] = await claimDue(["requested"], 1);
      if (!ev) break;
      await processEvent(ev);
    }

    for (let i = 0; i < 20; i++) {
      const [ev] = await claimDue(["sent", "acknowledged"], 1);
      if (!ev) break;
      if (ev.category !== "command") {
        await updateEvent(ev.id, {
          locked_until: null,
          next_attempt_at: new Date(Date.now() + 365 * 86400_000).toISOString(),
        });
        continue;
      }
      try {
        await pollCommandStatus(ev);
      } catch (e) {
        const err = toAppError(e);
        log("warn", "worker.poll_failed", { event_id: ev.id, code: err.code });
        await updateEvent(ev.id, {
          locked_until: null,
          next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
      }
    }

    const cfg = getConfig();
    const now = Date.now();

    const lastSync = await readTs("last_sync_at");
    if (now - lastSync > cfg.syncIntervalMinutes * 60_000) {
      await writeTs("last_sync_at", now); // reserve the window before awaiting Zoho
      const conns = await run<{ enterprise_id: string }[]>(
        db().from("zoho_connections").select("enterprise_id").eq("status", "connected"),
      );
      for (const c of conns) {
        await syncEnterprise(c.enterprise_id, undefined, null, { quietIfBusy: true });
      }
    }
    await monitoringTick(cfg.syncIntervalMinutes);

    const lastAutomationTick = await readTs("last_automation_tick");
    if (now - lastAutomationTick > cfg.automationTickMinutes * 60_000) {
      await writeTs("last_automation_tick", now);
      try {
        await dailyTickAll();
      } catch (e) {
        log("warn", "worker.automation_tick_failed", { error: String(e) });
      }
    }
  } catch (e) {
    log("error", "worker.tick_failed", { error: String(e) });
  } finally {
    ticking = false;
  }
}

/** Per enterprise: security scan every sync interval, location poll on its own interval, admin checks each tick. */
export async function monitoringTick(scanEveryMinutes: number) {
  const conns = await run<{ enterprise_id: string }[]>(
    db().from("zoho_connections").select("enterprise_id").eq("status", "connected"),
  );
  for (const { enterprise_id: eid } of conns) {
    try {
      // One monitoring pass per enterprise across all processes.
      await withLease(`monitor:${eid}`, 15 * 60, async () => {
        const st = await getSettings(eid);
        const due = (iso: string | null, minutes: number) =>
          !iso || Date.now() - Date.parse(iso) > minutes * 60_000;
        if (due(st.last_security_scan_at, scanEveryMinutes)) await scanEnterprise(eid);
        if (
          st.location_tracking_enabled &&
          due(st.last_location_poll_at, st.location_interval_minutes)
        ) {
          await pollEnterpriseLocations(eid);
        }
        await checkAdminActivity(eid);
        await scanAutomation(eid);
      });
    } catch (e) {
      log("warn", "worker.monitoring_failed", { enterprise_id: eid, code: toAppError(e).code });
    }
  }
  const lastPurge = await readTs("last_purge_at");
  if (Date.now() - lastPurge > 6 * 3600_000) {
    await writeTs("last_purge_at", Date.now());
    const { data } = await db().rpc("purge_old_locations");
    if (data) log("info", "worker.locations_purged", { count: data });
  }
}

export function startWorker() {
  const cfg = getConfig();
  log("info", "worker.started", { every_s: cfg.workerIntervalSeconds });
  tick();
  return setInterval(tick, cfg.workerIntervalSeconds * 1000);
}

if (import.meta.main) startWorker();
