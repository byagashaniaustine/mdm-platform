// Security scan: reads each device's security / network / last-contact state from Zoho,
// stores a snapshot, and raises or auto-resolves alerts on changes.
import { db, run } from "../lib/db.ts";
import { toAppError } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import * as zoho from "../zoho/api.ts";
import { type EffectiveRule, getRules, getSettings, raiseAlert, resolveAlert } from "./monitoring.ts";

type Json = Record<string, unknown>;
type Device = { id: string; zoho_device_id: number; device_name: string | null };
type Snapshot = { data_total: number | null; data_rate_baseline: number | null; data_samples: number; captured_at: string };

// Zoho returns these fields as booleans sometimes, strings ("true"/"false") other times,
// occasionally as 0/1 numbers. Previous version only accepted strict JS booleans and
// silently null'd the rest — so is_supervised stayed null forever after sync even on
// supervised iPhones that Zoho reports as "true".
const asBool = (v: unknown): boolean | null => {
  if (v === true || v === false) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  if (typeof v === "number") return v !== 0;
  return null;
};
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Pure evaluation (unit-tested): which conditions are true for this device right now. */
export function evaluateSecurity(input: {
  security: Json;
  lastContactAt: Date | null;
  offlineHours: number;
  now?: Date;
}) {
  const s = input.security;
  const now = input.now ?? new Date();
  return {
    rooted: s.device_rooted === true,
    passcodeMissing: s.passcode_present === false,
    // Zoho spells the field "passcode_complaint"
    passcodeNoncompliant: s.passcode_present === true && s.passcode_complaint === false,
    unencrypted: s.storage_encryption === false,
    offline: input.lastContactAt !== null && now.getTime() - input.lastContactAt.getTime() > input.offlineHours * 3600_000,
  };
}

/** Pure data-spike check: returns the new baseline and whether this sample is a spike. */
export function evaluateDataUse(prev: Snapshot | null, total: number | null, factor: number, now = new Date()) {
  if (total === null) return { spike: false, baseline: prev?.data_rate_baseline ?? null, samples: prev?.data_samples ?? 0, rate: null };
  if (!prev || prev.data_total === null || total < prev.data_total) {
    return { spike: false, baseline: prev?.data_rate_baseline ?? null, samples: prev?.data_samples ?? 0, rate: null }; // first sample or counter reset
  }
  const hours = Math.max((now.getTime() - Date.parse(prev.captured_at)) / 3600_000, 0.1);
  const rate = (total - prev.data_total) / hours;
  const baseline = prev.data_rate_baseline;
  // Idle periods (no usage) say nothing about normal use: they don't move the baseline,
  // otherwise a phone that sat unused overnight would flag ordinary use in the morning.
  if (rate === 0) return { spike: false, baseline, samples: prev.data_samples, rate };
  const spike = prev.data_samples >= 3 && baseline !== null && baseline > 0 && rate > factor * baseline;
  // Spikes are not folded into the baseline, so one burst does not hide the next.
  const next = spike ? baseline : baseline === null ? rate : 0.8 * baseline + 0.2 * rate;
  return { spike, baseline: next, samples: prev.data_samples + 1, rate };
}

async function scanDevice(eid: string, d: Device, offlineHours: number, factor: number, rules: EffectiveRule[]) {
  const [details, summary] = await Promise.all([
    zoho.getDevice(eid, d.zoho_device_id),
    zoho.getDeviceSummary(eid, d.zoho_device_id).catch(() => ({} as Json)),
  ]);
  const security = (details.security ?? {}) as Json;
  const network = (details.network ?? {}) as Json;
  const lastContactMs = num((summary as Json).last_contact_time ?? details.last_contact_time);
  const lastContactAt = lastContactMs ? new Date(lastContactMs) : null;
  const total = network.outgoing_network_usage === undefined && network.incoming_network_usage === undefined
    ? null
    : (num(network.outgoing_network_usage) ?? 0) + (num(network.incoming_network_usage) ?? 0);

  const { data: prev } = await db().from("device_snapshots").select("data_total, data_rate_baseline, data_samples, captured_at")
    .eq("device_id", d.id).maybeSingle();
  const use = evaluateDataUse(prev as Snapshot | null, total, factor);
  const c = evaluateSecurity({ security, lastContactAt, offlineHours });
  const name = d.device_name ?? String(d.zoho_device_id);

  // Backfill the devices table with fields that only exist on the detail endpoint.
  // is_profileowner is not on /devices list, so without this scan the badge logic
  // falls back to owned_by + is_supervised only.
  if (details.is_profileowner !== undefined || details.is_supervised !== undefined) {
    await db().from("devices").update({
      is_profileowner: details.is_profileowner === undefined ? null : asBool(details.is_profileowner),
      is_supervised: details.is_supervised === undefined ? null : asBool(details.is_supervised),
    }).eq("id", d.id);
  }

  await run(db().from("device_snapshots").upsert({
    device_id: d.id,
    enterprise_id: eid,
    device_rooted: asBool(security.device_rooted),
    passcode_present: asBool(security.passcode_present),
    passcode_compliant: asBool(security.passcode_complaint),
    storage_encrypted: asBool(security.storage_encryption),
    battery_level: num(details.battery_level),
    last_contact_at: lastContactAt?.toISOString() ?? null,
    data_total: total,
    data_rate_baseline: use.baseline,
    data_samples: use.samples,
    captured_at: new Date().toISOString(),
  }, { onConflict: "device_id" }));

  const toggle = async (on: boolean, rule: string, title: string, details: Json = {}) => {
    const key = `${rule}:${d.id}`;
    if (on) await raiseAlert({ enterpriseId: eid, ruleKey: rule, dedupeKey: key, deviceId: d.id, title, details }, rules);
    else await resolveAlert(eid, key);
  };
  await toggle(c.rooted, "device_rooted", `${name} is rooted / jailbroken`);
  await toggle(c.passcodeMissing, "passcode_missing", `${name} has no screen lock`);
  await toggle(c.passcodeNoncompliant, "passcode_noncompliant", `${name} passcode does not meet policy`);
  await toggle(c.unencrypted, "storage_unencrypted", `${name} storage is not encrypted`);
  await toggle(c.offline, "device_offline", `${name} has not checked in for over ${offlineHours} h`, { last_contact_at: lastContactAt?.toISOString() });
  if (use.spike) {
    await raiseAlert({
      enterpriseId: eid,
      ruleKey: "data_spike",
      dedupeKey: `data_spike:${d.id}`,
      deviceId: d.id,
      title: `${name} is using ${Math.round((use.rate ?? 0) / (use.baseline || 1))}× its normal mobile data`,
      details: { rate_per_hour: use.rate, baseline_per_hour: use.baseline },
    }, rules);
  }
}

export async function scanEnterprise(eid: string): Promise<{ scanned: number; failed: number }> {
  const st = await getSettings(eid);
  const rules = await getRules(eid);
  const devices = await run<Device[]>(
    db().from("devices").select("id, zoho_device_id, device_name").eq("enterprise_id", eid).eq("is_removed", false),
  );
  let failed = 0;
  for (let i = 0; i < devices.length; i += 4) {
    await Promise.all(devices.slice(i, i + 4).map((d) =>
      scanDevice(eid, d, st.offline_hours, st.data_spike_factor, rules).catch((e) => {
        failed++;
        log("warn", "scan.device_failed", { device_id: d.id, code: toAppError(e).code });
      })
    ));
  }
  await db().from("monitoring_settings").update({ last_security_scan_at: new Date().toISOString() }).eq("enterprise_id", eid);
  return { scanned: devices.length - failed, failed };
}

/** Called by sync when devices disappear from Zoho. */
export async function onDevicesUnenrolled(eid: string, devices: { id: string; device_name: string | null }[]) {
  if (!devices.length) return;
  const rules = await getRules(eid);
  for (const d of devices) {
    await raiseAlert({
      enterpriseId: eid,
      ruleKey: "device_unenrolled",
      dedupeKey: `device_unenrolled:${d.id}`,
      deviceId: d.id,
      title: `${d.device_name ?? "A device"} was removed from management`,
      details: { hint: "Factory reset or forced unenrolment. If unexpected, treat as lost/stolen." },
    }, rules);
  }
}
