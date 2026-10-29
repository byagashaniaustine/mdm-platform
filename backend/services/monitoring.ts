// Monitoring core: settings, alert rules, the alert engine (raise / auto-resolve),
// auto-actions and email notification. Detectors live in security-scan.ts and locations.ts.
import { db, run, runMaybe } from "../lib/db.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import { createEvent, processEvent, recordAudit } from "./events.ts";
import { sendMail } from "./mail.ts";
import type { Session } from "./auth.ts";

export type Severity = "info" | "warning" | "critical";
export type AutoAction = "lock" | "enable_lost_mode" | "remote_alarm";

type RuleDef = {
  label: string;
  description: string;
  severity: Severity;
  enabled: boolean;
  autoActions: AutoAction[]; // which auto-actions make sense for this rule
};

const DEVICE_ACTIONS: AutoAction[] = ["lock", "enable_lost_mode", "remote_alarm"];

export const RULES: Record<string, RuleDef> = {
  device_rooted: { label: "Device rooted / jailbroken", description: "The OS has been tampered with — usually an attempt to bypass management.", severity: "critical", enabled: true, autoActions: DEVICE_ACTIONS },
  passcode_missing: { label: "No screen lock", description: "The device has no passcode set.", severity: "warning", enabled: true, autoActions: ["lock"] },
  passcode_noncompliant: { label: "Passcode below policy", description: "A passcode exists but does not meet the passcode profile.", severity: "warning", enabled: true, autoActions: [] },
  storage_unencrypted: { label: "Storage not encrypted", description: "Device storage encryption is off.", severity: "info", enabled: false, autoActions: [] },
  device_offline: { label: "Device not checking in", description: "No contact with Zoho for longer than the offline threshold.", severity: "warning", enabled: true, autoActions: [] },
  device_unenrolled: { label: "Removed from management", description: "The device disappeared from Zoho (factory reset or forced unenrolment).", severity: "critical", enabled: true, autoActions: [] },
  data_spike: { label: "Unusual mobile data use", description: "Data use per hour is far above this device's normal level.", severity: "warning", enabled: true, autoActions: [] },
  geofence_exit: { label: "Left allowed area", description: "The device is outside every allowed geofence that applies to it.", severity: "warning", enabled: true, autoActions: DEVICE_ACTIONS },
  geofence_restricted: { label: "Entered restricted area", description: "The device is inside a restricted geofence.", severity: "critical", enabled: true, autoActions: DEVICE_ACTIONS },
  admin_failed_logins: { label: "Repeated failed sign-ins", description: "5+ wrong sign-in codes for this enterprise within 15 minutes.", severity: "warning", enabled: true, autoActions: [] },
  admin_new_ip: { label: "Sign-in from a new network", description: "An admin signed in from an IP address not seen in the last 30 days.", severity: "info", enabled: true, autoActions: [] },
  wipe_confirmation_failed: { label: "Wipe confirmation failed repeatedly", description: "A wipe/passcode request was cancelled after 5 wrong confirmations.", severity: "critical", enabled: true, autoActions: [] },
  // Loan-automation health rules (added 2026-10-29, see plan). Each is raised by
  // services/monitoring.ts::scanAutomation on every monitoringTick.
  "automation.hold": { label: "Automation batch held", description: "A reconcile batch exceeded the blast-radius cap and was held with no device moved. Someone should look.", severity: "warning", enabled: true, autoActions: [] },
  "automation.stuck_tier_warn": { label: "Device tier change pending", description: "A device has desired_tier ≠ applied_tier for more than 2 hours. Zoho may be slow or the device offline.", severity: "warning", enabled: true, autoActions: [] },
  "automation.stuck_tier_crit": { label: "Device tier change stuck", description: "A device has desired_tier ≠ applied_tier for more than 24 hours. Apply path or Zoho is broken for this device.", severity: "critical", enabled: true, autoActions: [] },
  "automation.events_dead": { label: "Automation events dead", description: "Group-move or announcement events hit max retries in the last 24h. Zoho or the executor is failing.", severity: "critical", enabled: true, autoActions: [] },
  "automation.fineract_down": { label: "Fineract unreachable", description: "The circuit breaker is open after repeated Fineract failures. DPD-driven transitions will stall until Fineract recovers.", severity: "critical", enabled: true, autoActions: [] },
};

export type RuleKey = keyof typeof RULES;
export type EffectiveRule = { key: string; label: string; description: string; enabled: boolean; severity: Severity; autoAction: AutoAction | null; autoActions: AutoAction[] };

export async function getRules(eid: string): Promise<EffectiveRule[]> {
  const overrides = await run<{ rule_key: string; enabled: boolean; severity: Severity; auto_action: AutoAction | null }[]>(
    db().from("alert_rules").select("rule_key, enabled, severity, auto_action").eq("enterprise_id", eid),
  );
  const byKey = new Map(overrides.map((o) => [o.rule_key, o]));
  return Object.entries(RULES).map(([key, def]) => {
    const o = byKey.get(key);
    return {
      key,
      label: def.label,
      description: def.description,
      enabled: o ? o.enabled : def.enabled,
      severity: o ? o.severity : def.severity,
      autoAction: o?.auto_action ?? null,
      autoActions: def.autoActions,
    };
  });
}

export async function updateRule(s: Session, key: string, patch: { enabled?: boolean; severity?: Severity; autoAction?: AutoAction | null }) {
  const def = RULES[key];
  if (!def) fail("NOT_FOUND", "Unknown rule");
  if (patch.autoAction && !def.autoActions.includes(patch.autoAction)) fail("VALIDATION_FAILED", `${patch.autoAction} is not available for this rule`);
  const current = (await getRules(s.enterpriseId)).find((r) => r.key === key)!;
  await run(
    db().from("alert_rules").upsert({
      enterprise_id: s.enterpriseId,
      rule_key: key,
      enabled: patch.enabled ?? current.enabled,
      severity: patch.severity ?? current.severity,
      auto_action: patch.autoAction === undefined ? current.autoAction : patch.autoAction,
      updated_by: s.adminId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "enterprise_id,rule_key" }),
  );
  await recordAudit({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "zoho", action: "monitoring.rule_updated", params: { key, ...patch } });
  return (await getRules(s.enterpriseId)).find((r) => r.key === key);
}

// ----------------------------------------------------------------- settings
export type MonitoringSettings = {
  enterprise_id: string;
  location_tracking_enabled: boolean;
  tracking_consent_at: string | null;
  location_interval_minutes: number;
  working_hours_only: boolean;
  work_start: string; // "08:00:00"
  work_end: string;
  work_days: number[];
  timezone: string;
  location_retention_days: number;
  offline_hours: number;
  data_spike_factor: number;
  email_critical_alerts: boolean;
  last_location_poll_at: string | null;
  last_security_scan_at: string | null;
};

export async function getSettings(eid: string): Promise<MonitoringSettings> {
  const row = await runMaybe<MonitoringSettings>(db().from("monitoring_settings").select("*").eq("enterprise_id", eid).maybeSingle());
  if (row) return { ...row, data_spike_factor: Number(row.data_spike_factor) };
  await db().from("monitoring_settings").upsert({ enterprise_id: eid }, { onConflict: "enterprise_id", ignoreDuplicates: true });
  return getSettings(eid);
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function updateSettings(s: Session, b: Record<string, unknown>) {
  const cur = await getSettings(s.enterpriseId);
  const patch: Record<string, unknown> = { updated_by: s.adminId };
  const intIn = (k: string, col: string, min: number, max: number) => {
    if (b[k] === undefined) return;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < min || n > max) fail("VALIDATION_FAILED", `${k} must be ${min}–${max}`);
    patch[col] = n;
  };
  intIn("locationIntervalMinutes", "location_interval_minutes", 5, 1440);
  intIn("locationRetentionDays", "location_retention_days", 1, 365);
  intIn("offlineHours", "offline_hours", 1, 720);
  if (b.dataSpikeFactor !== undefined) {
    const f = Number(b.dataSpikeFactor);
    if (!(f >= 1.5 && f <= 50)) fail("VALIDATION_FAILED", "dataSpikeFactor must be 1.5–50");
    patch.data_spike_factor = f;
  }
  for (const [k, col] of [["workStart", "work_start"], ["workEnd", "work_end"]] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "string" || !TIME.test(b[k] as string)) fail("VALIDATION_FAILED", `${k} must be HH:MM`);
    patch[col] = b[k];
  }
  if (b.workDays !== undefined) {
    const days = b.workDays as number[];
    if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) fail("VALIDATION_FAILED", "workDays must be 1–7");
    patch.work_days = [...new Set(days)].sort();
  }
  if (b.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: String(b.timezone) });
    } catch {
      fail("VALIDATION_FAILED", "Unknown timezone");
    }
    patch.timezone = String(b.timezone);
  }
  for (const [k, col] of [["workingHoursOnly", "working_hours_only"], ["emailCriticalAlerts", "email_critical_alerts"]] as const) {
    if (b[k] !== undefined) patch[col] = Boolean(b[k]);
  }
  if (b.locationTrackingEnabled !== undefined) {
    const on = Boolean(b.locationTrackingEnabled);
    if (on && !cur.location_tracking_enabled) {
      // Privacy gate: the owner must confirm employees were told (PDPA 2022 transparency).
      if (b.employeesInformed !== true) fail("CONSENT_REQUIRED");
      patch.tracking_consent_at = new Date().toISOString();
      patch.tracking_consent_by = s.adminId;
    }
    patch.location_tracking_enabled = on;
  }
  await run(db().from("monitoring_settings").update(patch).eq("enterprise_id", s.enterpriseId));
  await recordAudit({ enterpriseId: s.enterpriseId, adminId: s.adminId, category: "zoho", action: "monitoring.settings_updated", params: { ...b, employeesInformed: undefined } });
  return getSettings(s.enterpriseId);
}

/** Is `now` inside the enterprise's working hours (in its own timezone)? */
export function isWorkingTime(st: Pick<MonitoringSettings, "work_start" | "work_end" | "work_days" | "timezone">, now = new Date()): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: st.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  if (!st.work_days.includes(day)) return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const start = toMin(st.work_start);
  const end = toMin(st.work_end);
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end; // supports night shifts
}

// ------------------------------------------------------------- alert engine
export type AlertInput = {
  enterpriseId: string;
  ruleKey: RuleKey;
  dedupeKey: string;
  title: string;
  details?: Record<string, unknown>;
  deviceId?: string | null;
  geofenceId?: string | null;
};

type AlertRow = { id: string; occurrences: number; severity: Severity; status: string };

/**
 * Open (or refresh) an alert. One open alert per dedupeKey: repeated detections bump
 * occurrences instead of spamming. New alerts may trigger an auto-action and an email.
 */
export async function raiseAlert(a: AlertInput, rules?: EffectiveRule[]): Promise<{ id: string; created: boolean } | null> {
  const rule = (rules ?? await getRules(a.enterpriseId)).find((r) => r.key === a.ruleKey);
  if (!rule?.enabled) return null;
  const now = new Date().toISOString();

  const existing = await runMaybe<AlertRow>(
    db().from("alerts").select("id, occurrences, severity, status").eq("enterprise_id", a.enterpriseId)
      .eq("dedupe_key", a.dedupeKey).neq("status", "resolved").maybeSingle(),
  );
  if (existing) {
    await db().from("alerts").update({ last_seen_at: now, occurrences: existing.occurrences + 1, details: a.details ?? {} }).eq("id", existing.id);
    return { id: existing.id, created: false };
  }

  const { data, error } = await db().from("alerts").insert({
    enterprise_id: a.enterpriseId,
    device_id: a.deviceId ?? null,
    geofence_id: a.geofenceId ?? null,
    rule_key: a.ruleKey,
    severity: rule.severity,
    title: a.title,
    details: a.details ?? {},
    dedupe_key: a.dedupeKey,
  }).select("id").single();
  if (error) {
    if (error.code === "23505") return { id: "", created: false }; // a parallel detector won the race
    log("error", "alert.insert_failed", { error: error.message });
    return null;
  }
  const id = (data as { id: string }).id;
  log("warn", "alert.raised", { enterprise_id: a.enterpriseId, rule: a.ruleKey, severity: rule.severity });

  if (rule.autoAction && a.deviceId) await runAutoAction(a, rule, id);
  if (rule.severity === "critical") await notifyAdmins(a, rule).catch((e) => log("error", "alert.email_failed", { error: String(e) }));
  return { id, created: true };
}

/** Condition cleared: close the open alert automatically (resolved_by stays null = system). */
export async function resolveAlert(eid: string, dedupeKey: string, note = "Condition cleared"): Promise<void> {
  await db().from("alerts").update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: note })
    .eq("enterprise_id", eid).eq("dedupe_key", dedupeKey).neq("status", "resolved");
}

async function runAutoAction(a: AlertInput, rule: EffectiveRule, alertId: string) {
  const { data: device } = await db().from("devices").select("id, is_removed").eq("id", a.deviceId!).maybeSingle();
  if (!device || device.is_removed) return;
  try {
    const { event } = await createEvent({
      enterpriseId: a.enterpriseId,
      adminId: null, // system
      category: "command",
      action: `command.${rule.autoAction}`,
      deviceId: a.deviceId!,
      params: rule.autoAction === "lock" || rule.autoAction === "enable_lost_mode"
        ? { lock_message: "This device was locked by your organisation's security policy. Contact IT." }
        : {},
      idempotencyKey: `auto:${alertId}`,
      maxAttempts: 4,
    });
    const done = await processEvent(event);
    await db().from("alerts").update({ auto_action_event_id: done.id }).eq("id", alertId);
  } catch (e) {
    log("error", "alert.auto_action_failed", { alert_id: alertId, error: String(e) });
  }
}

async function notifyAdmins(a: AlertInput, rule: EffectiveRule) {
  const st = await getSettings(a.enterpriseId);
  if (!st.email_critical_alerts) return;
  const admins = await run<{ email: string }[]>(
    db().from("admins").select("email").eq("enterprise_id", a.enterpriseId).eq("is_active", true).in("role", ["owner", "admin"]),
  );
  for (const ad of admins) {
    await sendMail({
      to: ad.email,
      subject: `[Critical] ${rule.label}: ${a.title}`,
      text: `${a.title}\n\n${rule.description}\n${rule.autoAction ? `Automatic action: ${rule.autoAction}\n` : ""}\nOpen the MDM Console → Alerts to review.`,
    });
  }
}

// ------------------------------------------------------------ alert actions
export async function listAlerts(eid: string, q: { status?: string; severity?: string; deviceId?: string; limit: number }) {
  let query = db().from("alerts")
    .select("*, devices(id, device_name, model), geofences(id, name), ack:admins!alerts_acknowledged_by_fkey(email), res:admins!alerts_resolved_by_fkey(email)")
    .eq("enterprise_id", eid).order("last_seen_at", { ascending: false }).limit(q.limit);
  if (q.status === "active") query = query.neq("status", "resolved");
  else if (q.status && ["open", "acknowledged", "resolved"].includes(q.status)) query = query.eq("status", q.status);
  if (q.severity && ["info", "warning", "critical"].includes(q.severity)) query = query.eq("severity", q.severity);
  if (q.deviceId) query = query.eq("device_id", q.deviceId);
  return await run(query);
}

export async function acknowledgeAlert(s: Session, id: string) {
  const row = await run<{ status: string }>(db().from("alerts").select("status").eq("enterprise_id", s.enterpriseId).eq("id", id).single());
  if (row.status !== "open") fail("CONFLICT", `Alert is ${row.status}`);
  return await run(
    db().from("alerts").update({ status: "acknowledged", acknowledged_by: s.adminId, acknowledged_at: new Date().toISOString() })
      .eq("id", id).select("*").single(),
  );
}

export async function resolveAlertManually(s: Session, id: string, note: string) {
  const row = await run<{ status: string }>(db().from("alerts").select("status").eq("enterprise_id", s.enterpriseId).eq("id", id).single());
  if (row.status === "resolved") fail("CONFLICT", "Alert is already resolved");
  return await run(
    db().from("alerts").update({ status: "resolved", resolved_by: s.adminId, resolved_at: new Date().toISOString(), resolution_note: note || "Resolved by admin" })
      .eq("id", id).select("*").single(),
  );
}

// -------------------------------------------------- admin activity detectors
/** Failed sign-ins burst — called by the worker each tick. */
export async function checkAdminActivity(eid: string, rules?: EffectiveRule[]) {
  const since15 = new Date(Date.now() - 15 * 60_000).toISOString();
  const since60 = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count: recent } = await db().from("events").select("id", { count: "exact", head: true })
    .eq("enterprise_id", eid).eq("action", "login.failed").gte("action_time", since15);
  if ((recent ?? 0) >= 5) {
    await raiseAlert({ enterpriseId: eid, ruleKey: "admin_failed_logins", dedupeKey: "admin_failed_logins", title: `${recent} failed sign-in attempts in 15 minutes`, details: { count: recent } }, rules);
    return;
  }
  const { count: hour } = await db().from("events").select("id", { count: "exact", head: true })
    .eq("enterprise_id", eid).eq("action", "login.failed").gte("action_time", since60);
  if ((hour ?? 0) === 0) await resolveAlert(eid, "admin_failed_logins", "No failed sign-ins for an hour");
}

/**
 * Loan-automation health scan. Called from worker's monitoringTick (same lease
 * as other scans). Raises/resolves alerts for five conditions. All queries are
 * cheap aggregates; no Zoho or Fineract I/O here.
 */
export async function scanAutomation(eid: string, rules?: EffectiveRule[]): Promise<void> {
  const r = rules ?? await getRules(eid);
  const day = new Date().toISOString().slice(0, 10);

  // 1) automation.hold — any held run in the last 1h.
  const sinceHour = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count: holdCount } = await db().from("automation_runs").select("id", { count: "exact", head: true })
    .eq("enterprise_id", eid).eq("held", true).gte("created_at", sinceHour);
  if ((holdCount ?? 0) > 0) {
    await raiseAlert({
      enterpriseId: eid, ruleKey: "automation.hold",
      dedupeKey: `automation.hold:${eid}:${day}`,
      title: `${holdCount} reconcile batch(es) held in the last hour`,
      details: { count: holdCount, window_hours: 1 },
    }, r);
  } else {
    await resolveAlert(eid, `automation.hold:${eid}:${day}`, "No held batches in the last hour");
  }

  // 2+3) stuck_tier: desired_tier != applied_tier for a while. One alert per tier
  // group of staleness, device IDs listed in `details.devices`.
  const stuckRows = await run<{ device_id: string; desired_tier: string | null; applied_tier: string | null; updated_at: string }[]>(
    db().from("device_tier_state")
      .select("device_id, desired_tier, applied_tier, updated_at")
      .eq("enterprise_id", eid)
      .not("desired_tier", "is", null),
  );
  const now = Date.now();
  const stuckWarn = stuckRows.filter((s) => s.desired_tier !== s.applied_tier && now - Date.parse(s.updated_at) > 2 * 3600_000 && now - Date.parse(s.updated_at) <= 24 * 3600_000);
  const stuckCrit = stuckRows.filter((s) => s.desired_tier !== s.applied_tier && now - Date.parse(s.updated_at) > 24 * 3600_000);

  if (stuckWarn.length) {
    await raiseAlert({
      enterpriseId: eid, ruleKey: "automation.stuck_tier_warn",
      dedupeKey: `automation.stuck_tier_warn:${eid}:${day}`,
      title: `${stuckWarn.length} device(s) pending tier change >2h`,
      details: { count: stuckWarn.length, devices: stuckWarn.slice(0, 20).map((s) => s.device_id) },
    }, r);
  } else {
    await resolveAlert(eid, `automation.stuck_tier_warn:${eid}:${day}`, "No devices stuck >2h");
  }

  if (stuckCrit.length) {
    await raiseAlert({
      enterpriseId: eid, ruleKey: "automation.stuck_tier_crit",
      dedupeKey: `automation.stuck_tier_crit:${eid}:${day}`,
      title: `${stuckCrit.length} device(s) STUCK on tier change >24h`,
      details: { count: stuckCrit.length, devices: stuckCrit.slice(0, 20).map((s) => s.device_id) },
    }, r);
  } else {
    await resolveAlert(eid, `automation.stuck_tier_crit:${eid}:${day}`, "No devices stuck >24h");
  }

  // 4) events_dead — any automation-related event in `dead` state in last 24h.
  const since24 = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count: deadCount } = await db().from("events").select("id", { count: "exact", head: true })
    .eq("enterprise_id", eid).eq("state", "dead").in("category", ["group", "announcement"]).gte("updated_at", since24);
  if ((deadCount ?? 0) > 0) {
    await raiseAlert({
      enterpriseId: eid, ruleKey: "automation.events_dead",
      dedupeKey: `automation.events_dead:${eid}:${day}`,
      title: `${deadCount} dead automation event(s) in last 24h`,
      details: { count: deadCount, window_hours: 24 },
    }, r);
  } else {
    await resolveAlert(eid, `automation.events_dead:${eid}:${day}`, "No dead events in 24h");
  }

  // 5) fineract_down — circuit breaker state. Non-'closed' = alert.
  const { breakerState } = await import("../lib/circuit.ts");
  const breaker = breakerState("fineract");
  if (breaker.state !== "closed") {
    await raiseAlert({
      enterpriseId: eid, ruleKey: "automation.fineract_down",
      dedupeKey: `automation.fineract_down:${eid}`,
      title: `Fineract circuit breaker ${breaker.state.toUpperCase()}`,
      details: {
        state: breaker.state,
        consecutive_failures: breaker.consecutiveFailures,
        opened_at: breaker.openedAt,
        cooldown_remaining_ms: breaker.cooldownRemainingMs,
      },
    }, r);
  } else {
    await resolveAlert(eid, `automation.fineract_down:${eid}`, "Fineract reachable again");
  }
}

/** Called after a successful login. */
export async function noteLogin(admin: { id: string; enterprise_id: string; email: string }, ip: string | null) {
  if (!ip) return;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { count: total } = await db().from("sessions").select("id", { count: "exact", head: true }).eq("admin_id", admin.id);
  const { count: sameIp } = await db().from("sessions").select("id", { count: "exact", head: true })
    .eq("admin_id", admin.id).eq("ip", ip).gte("created_at", since);
  // The new session row is already inserted, so "seen before" means more than one.
  if ((total ?? 0) > 1 && (sameIp ?? 0) <= 1) {
    await raiseAlert({
      enterpriseId: admin.enterprise_id,
      ruleKey: "admin_new_ip",
      dedupeKey: `admin_new_ip:${admin.id}:${ip}`,
      title: `${admin.email} signed in from a new network (${ip})`,
      details: { ip, admin: admin.email },
    });
  }
}
