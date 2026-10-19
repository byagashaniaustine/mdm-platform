// Device commands: catalogue, role rules, two-step confirmation and acknowledgement tracking.
import { getConfig } from "../config.ts";
import { db } from "../lib/db.ts";
import { decryptSecret, encryptSecret } from "../lib/crypto.ts";
import { fail, toAppError } from "../lib/errors.ts";
import { getCommandHistory, runDeviceAction, runKnoxDeviceAction } from "../zoho/api.ts";
import type { Role, Session } from "./auth.ts";
import {
  createEvent,
  type EventRow,
  processEvent,
  recordAudit,
  registerExecutor,
  updateEvent,
} from "./events.ts";
import { type DeviceRow, getDevice, getDevices, getGroup, type GroupRow } from "./lookup.ts";
import { raiseAlert } from "./monitoring.ts";

export type Platform = "ios" | "android" | "macos" | "windows" | "chrome";

type ActionDef = {
  label: string;
  minRole: Role;
  confirm: boolean; // two-step: review dialog, then the admin types the serial tail
  params: readonly string[]; // allowed body fields for Zoho
  history: RegExp; // how the command shows up in Zoho command history
  // Platforms where the standard /actions/ endpoint works. macOS is included only for the
  // handful of commands Apple's MDM protocol exposes on Mac (lock, wipe, reset_passcode).
  platforms: readonly Platform[];
  // true → on Samsung Knox (device.is_knox) route via /knox_actions/ instead of /actions/.
  // These are the commands standard Android MDM doesn't surface (shutdown, restart).
  knoxOnlyAndroid?: boolean;
  // true → on iPhone/iPad Apple only accepts it from a supervised device (Apple Business
  // Manager / Configurator). Unsupervised iPhones reject it, so we don't offer it there.
  supervisedOnlyIos?: boolean;
};

// Action names from the guide: POST /devices/{id}/actions/{action_name}
export const DEVICE_ACTIONS: Record<string, ActionDef> = {
  scan: { label: "Scan / refresh inventory", minRole: "admin", confirm: false, params: [], history: /scan/i, platforms: ["ios", "android", "macos", "windows", "chrome"] },
  lock: { label: "Lock device", minRole: "admin", confirm: false, params: ["lock_message"], history: /lock/i, platforms: ["ios", "android", "macos"] },
  remote_alarm: { label: "Ring alarm", minRole: "admin", confirm: false, params: [], history: /alarm/i, platforms: ["ios", "android"], supervisedOnlyIos: true },
  fetch_location: { label: "Fetch location", minRole: "admin", confirm: false, params: [], history: /locat/i, platforms: ["ios", "android"], supervisedOnlyIos: true },
  // Shutdown / restart: Apple's MDM protocol exposes these on supervised iOS; macOS does not.
  // On Android the standard protocol has no shutdown/restart — only Samsung Knox does, via /knox_actions/.
  restart: { label: "Restart", minRole: "admin", confirm: false, params: [], history: /restart|reboot/i, platforms: ["ios", "android"], knoxOnlyAndroid: true, supervisedOnlyIos: true },
  shutdown: { label: "Shut down", minRole: "admin", confirm: false, params: [], history: /shut/i, platforms: ["ios", "android"], knoxOnlyAndroid: true, supervisedOnlyIos: true },
  enable_lost_mode: {
    label: "Enable lost mode",
    minRole: "admin",
    confirm: false,
    params: ["lock_message", "phone_number", "send_email_to_user", "audit_message"],
    history: /lost/i,
    platforms: ["ios", "android"],
    supervisedOnlyIos: true,
  },
  disable_lost_mode: { label: "Disable lost mode", minRole: "admin", confirm: false, params: [], history: /lost/i, platforms: ["ios", "android"], supervisedOnlyIos: true },
  pause_kiosk: { label: "Pause kiosk", minRole: "admin", confirm: false, params: ["re_enter_time"], history: /kiosk/i, platforms: ["android"] },
  re_apply_kiosk: { label: "Re-apply kiosk", minRole: "admin", confirm: false, params: [], history: /kiosk/i, platforms: ["android"] },
  reset_passcode: {
    label: "Reset passcode",
    minRole: "admin",
    confirm: true,
    params: ["passcode", "email_sent_to_user", "email_sent_to_admin"],
    history: /pass/i,
    // Not iPhone/iPad: Apple's MDM protocol can't set a passcode on iOS, only clear it.
    platforms: ["android", "macos"],
  },
  clear_passcode: { label: "Clear passcode", minRole: "admin", confirm: true, params: [], history: /pass/i, platforms: ["ios", "android"] },
  corporate_wipe: { label: "Corporate wipe (work data only)", minRole: "owner", confirm: true, params: [], history: /wipe|corporate/i, platforms: ["ios", "android", "macos"] },
  complete_wipe: {
    label: "Complete wipe (erase everything)",
    minRole: "owner",
    confirm: true,
    params: ["wipe_sd_card", "wipe_but_retain_mdm"],
    history: /wipe/i,
    platforms: ["ios", "android", "macos"],
  },
};

/** Server-side guard: is this action expected to work for this device? Mirrors the UI filter. */
export function actionAppliesTo(action: string, device: Pick<DeviceRow, "platform" | "is_knox" | "is_supervised">): boolean {
  const def = DEVICE_ACTIONS[action];
  if (!def) return false;
  const p = device.platform as Platform;
  if (!def.platforms.includes(p)) return false;
  // Android shutdown/restart only on Samsung Knox.
  if (p === "android" && def.knoxOnlyAndroid && !device.is_knox) return false;
  // Unknown supervision (null, not synced yet) is let through; only a known "false" blocks.
  if (p === "ios" && def.supervisedOnlyIos && device.is_supervised === false) return false;
  return true;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };
export const roleAtLeast = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min];

function pickParams(def: ActionDef, params: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of def.params) if (params[k] !== undefined) out[k] = params[k];
  const extra = Object.keys(params).filter((k) => !def.params.includes(k));
  if (extra.length) fail("VALIDATION_FAILED", `Unsupported parameters: ${extra.join(", ")}`);
  return out;
}

/** Actions that must never be sent to several devices in one request. */
export const DESTRUCTIVE = Object.entries(DEVICE_ACTIONS).filter(([, d]) => d.confirm).map(([id]) => id);

/**
 * What the admin types to prove they picked the right phone. Device names repeat (same user,
 * same model), so use the last 4 characters of the serial number, else IMEI, else Zoho id.
 */
export function deviceTag(d: Pick<DeviceRow, "serial_number" | "imei" | "zoho_device_id">): { tag: string; source: string } {
  const tail = (v: unknown) => String(v ?? "").replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();
  if (tail(d.serial_number).length === 4) return { tag: tail(d.serial_number), source: "serial number" };
  if (tail(d.imei).length === 4) return { tag: tail(d.imei), source: "IMEI" };
  return { tag: tail(d.zoho_device_id), source: "device id" };
}

async function describeDevice(device: DeviceRow) {
  const { tag, source } = deviceTag(device);
  let user: string | null = null;
  if (device.assigned_user_id) {
    const { data } = await db().from("mdm_users").select("user_name, email").eq("id", device.assigned_user_id).maybeSingle();
    user = (data?.user_name ?? data?.email ?? null) as string | null;
  }
  const name = device.device_name ?? `device ${device.zoho_device_id}`;
  return {
    kind: "device" as const,
    name,
    model: device.model,
    user,
    owned_by: device.owned_by === 2 ? "personal" : device.owned_by === 1 ? "corporate" : null,
    tag,
    tag_source: source,
    lines: [
      `Device: ${name}`,
      `Model: ${device.model ?? "unknown"}${device.owned_by === 2 ? " (personal device)" : ""}`,
      `User: ${user ?? "unassigned"}`,
      `${source[0].toUpperCase()}${source.slice(1)} ends in: ${tag}`,
    ],
  };
}

/** Confirmation details the console shows next to the code box. */
export async function confirmationTarget(enterpriseId: string, ev: EventRow) {
  if (ev.category === "group") {
    const g = await getGroup(enterpriseId, ev.group_id!);
    return { kind: "group" as const, name: g.name, devices: (ev.params.device_ids as string[] | undefined)?.length ?? 0, tag: g.name, tag_source: "group name" };
  }
  const { lines: _l, ...rest } = await describeDevice(await getDevice(enterpriseId, ev.device_id!));
  return rest;
}

const KIOSK_ACTIONS = new Set(["pause_kiosk", "re_apply_kiosk"]);

/** Kiosk commands only make sense on a device that gets a kiosk profile through one of its groups. */
export async function deviceHasKiosk(deviceId: string): Promise<boolean> {
  const { data } = await db().from("group_devices")
    .select("groups(profile_groups(profiles(purpose, state, payload_names)))")
    .eq("device_id", deviceId);
  type P = { purpose?: string; state?: string; payload_names?: string[] | null };
  const flat = (v: unknown): unknown[] => (Array.isArray(v) ? v : v ? [v] : []);
  for (const gd of (data ?? []) as Record<string, unknown>[]) {
    for (const g of flat(gd.groups) as Record<string, unknown>[]) {
      for (const pg of flat(g.profile_groups) as Record<string, unknown>[]) {
        for (const p of flat(pg.profiles) as P[]) {
          if (p.state === "deleted") continue;
          if (p.purpose === "kiosk" || (p.payload_names ?? []).some((n) => /kiosk/i.test(n))) return true;
        }
      }
    }
  }
  return false;
}

/** Passcodes are stored encrypted in the event and decrypted only when sent to Zoho. */
async function sealParams(params: Record<string, unknown>) {
  if (typeof params.passcode !== "string") return params;
  const { passcode, ...rest } = params;
  return { ...rest, passcode_enc: await encryptSecret(passcode as string) };
}

/** Step 1. Non-destructive actions run now; destructive ones wait for confirmCommand(). */
export async function requestCommand(session: Session, input: {
  deviceIds: string[];
  action: string;
  params: Record<string, unknown>;
  idempotencyKey: string | null;
}): Promise<EventRow[]> {
  const def = DEVICE_ACTIONS[input.action];
  if (!def) fail("COMMAND_UNKNOWN");
  if (!roleAtLeast(session.role, def.minRole)) fail("AUTH_FORBIDDEN", `${def.label} needs the ${def.minRole} role`);
  if (def.confirm && input.deviceIds.length !== 1) {
    fail("VALIDATION_FAILED", `${def.label} can only target one device at a time`);
  }
  // The guide marks `passcode` as required for reset_passcode; without it Zoho rejects the command.
  if (input.action === "reset_passcode") {
    const pc = input.params.passcode;
    if (typeof pc !== "string" || pc.length < 4 || pc.length > 16) {
      fail("VALIDATION_FAILED", "Enter the new passcode (4–16 characters). To remove the passcode instead, use Clear passcode.");
    }
  }
  const params = await sealParams(pickParams(def, input.params));
  const devices = await getDevices(session.enterpriseId, input.deviceIds);
  const cfg = getConfig();
  const results: EventRow[] = [];

  for (const device of devices) {
    if (device.is_removed) fail("CONFLICT", `${device.device_name ?? device.id} is no longer enrolled`);
    // Zoho answers 412 "Command not applicable" otherwise; say why before sending.
    if (KIOSK_ACTIONS.has(input.action) && !(await deviceHasKiosk(device.id))) {
      fail("VALIDATION_FAILED", `${device.device_name ?? "This device"} is not in kiosk mode: none of its groups has a kiosk profile`);
    }
    if (!actionAppliesTo(input.action, device)) {
      const name = device.device_name ?? "This device";
      if (device.platform === "android" && def.knoxOnlyAndroid && !device.is_knox) {
        fail("VALIDATION_FAILED", `${def.label} needs a Samsung Knox device; ${name} isn't one`);
      }
      if (device.platform === "ios" && input.action === "reset_passcode") {
        fail("VALIDATION_FAILED", `iPhones can't be given a new passcode remotely; Apple only allows clearing it. Use Clear passcode on ${name}, then the user sets a new one (a passcode profile on its group makes that required).`);
      }
      if (device.platform === "ios" && def.supervisedOnlyIos) {
        fail("VALIDATION_FAILED", `${def.label} needs a supervised iPhone; ${name} isn't supervised. Enrol it through Apple Business Manager to supervise it.`);
      }
      fail("VALIDATION_FAILED", `${def.label} isn't supported on ${device.platform} devices (${name})`);
    }
    const base = {
      enterpriseId: session.enterpriseId,
      adminId: session.adminId,
      category: "command" as const,
      action: `command.${input.action}`,
      params,
      deviceId: device.id,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${device.id}` : null,
      maxAttempts: 4,
    };

    if (def.confirm) {
      const { event, duplicate } = await createEvent({
        ...base,
        state: "awaiting_confirmation",
        confirmExpiresAt: new Date(Date.now() + cfg.confirmTtlMinutes * 60_000),
      });
      if (!duplicate) await updateEvent(event.id, { locked_until: null });
      results.push(event);
      continue;
    }

    const { event, duplicate } = await createEvent(base);
    results.push(duplicate ? event : await processEvent(event));
  }
  return results;
}

/**
 * Group-wide passcode reset (Group page). The admin confirms by typing the group name. Per-device commands are created only after confirmation.
 */
export async function requestGroupPasscodeReset(session: Session, group: GroupRow, deviceIds: string[], params: Record<string, unknown>, idempotencyKey: string | null) {
  if (!roleAtLeast(session.role, DEVICE_ACTIONS.reset_passcode.minRole)) fail("AUTH_FORBIDDEN");
  const sealed = await sealParams(pickParams(DEVICE_ACTIONS.reset_passcode, params));
  const cfg = getConfig();
  const { event, duplicate } = await createEvent({
    enterpriseId: session.enterpriseId,
    adminId: session.adminId,
    category: "group",
    action: "group.reset_passcode",
    params: { ...sealed, device_ids: deviceIds },
    groupId: group.id,
    idempotencyKey,
    state: "awaiting_confirmation",
    confirmExpiresAt: new Date(Date.now() + cfg.confirmTtlMinutes * 60_000),
  });
  if (!duplicate) await updateEvent(event.id, { locked_until: null });
  return event;
}

/** Step 2. The requester types the serial tail (or group name) shown in the dialog. */
export async function confirmCommand(session: Session, eventId: string, input: { typed: string }) {
  const ev = (await db().from("events").select("*").eq("id", eventId).eq("enterprise_id", session.enterpriseId)
    .maybeSingle()).data as EventRow | null;
  const isGroup = ev?.category === "group" && ev.action === "group.reset_passcode";
  if (!ev || (ev.category !== "command" && !isGroup)) fail("NOT_FOUND");
  if (ev.state !== "awaiting_confirmation") fail("CONFLICT", `Event is ${ev.state}`);
  if (ev.admin_id !== session.adminId) fail("AUTH_FORBIDDEN", "Only the admin who requested this can confirm it");
  if (!ev.confirm_expires_at || Date.parse(ev.confirm_expires_at) < Date.now()) {
    await updateEvent(ev.id, { state: "cancelled", error_code: "COMMAND_CONFIRMATION_EXPIRED", completed_at: new Date().toISOString() });
    fail("COMMAND_CONFIRMATION_EXPIRED");
  }
  const target = await confirmationTarget(session.enterpriseId, ev);
  const tries = Number((ev.response as { confirm_tries?: number } | null)?.confirm_tries ?? 0) + 1;
  const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
  const nameOk = norm(input.typed) === norm(target.tag);

  if (!nameOk) {
    const cancel = tries >= 5;
    await updateEvent(ev.id, {
      response: { ...(ev.response ?? {}), confirm_tries: tries },
      ...(cancel ? { state: "cancelled", error_code: "COMMAND_CONFIRMATION_INVALID", completed_at: new Date().toISOString() } : {}),
    });
    if (cancel) {
      await raiseAlert({
        enterpriseId: session.enterpriseId,
        ruleKey: "wipe_confirmation_failed",
        dedupeKey: `wipe_confirm:${ev.id}`,
        deviceId: isGroup ? undefined : ev.device_id!,
        title: `${session.email} failed to confirm "${ev.action.replace(/^(command|group)\./, "")}" on ${target.name} 5 times`,
        details: { event_id: ev.id, admin: session.email },
      });
    }
    fail("COMMAND_CONFIRMATION_INVALID", cancel ? "Too many wrong attempts; request cancelled" : undefined);
  }

  if (isGroup) return await fanOutGroupPasscode(session, ev);

  const ready = await updateEvent(ev.id, {
    state: "requested",
    confirm_code_hash: null,
    locked_until: new Date(Date.now() + 120_000).toISOString(),
    response: { ...(ev.response ?? {}), confirmed_at: new Date().toISOString() },
  });
  return await processEvent(ready);
}

/** After a confirmed group reset: one command per device (each retried / tracked on its own). */
async function fanOutGroupPasscode(session: Session, parent: EventRow) {
  const { device_ids, ...params } = parent.params as Record<string, unknown> & { device_ids: string[] };
  await updateEvent(parent.id, {
    state: "succeeded",
    confirm_code_hash: null,
    completed_at: new Date().toISOString(),
    response: { ...(parent.response ?? {}), confirmed_at: new Date().toISOString(), devices: device_ids.length },
  });
  const devices = await getDevices(session.enterpriseId, device_ids);
  const out: EventRow[] = [];
  // iPhones can't take a new passcode (Apple MDM limit); skip them rather than queue sure failures.
  for (const device of devices.filter((d) => !d.is_removed && actionAppliesTo("reset_passcode", d))) {
    const { event, duplicate } = await createEvent({
      enterpriseId: session.enterpriseId,
      adminId: session.adminId,
      category: "command",
      action: "command.reset_passcode",
      params,
      deviceId: device.id,
      groupId: parent.group_id ?? undefined,
      idempotencyKey: `${parent.id}:${device.id}`,
      maxAttempts: 4,
    });
    out.push(duplicate ? event : await processEvent(event));
  }
  return out;
}

// ------------------------------------------------------------- executors
for (const action of Object.keys(DEVICE_ACTIONS)) {
  registerExecutor(`command.${action}`, async (ev) => {
    const device = await getDevice(ev.enterprise_id, ev.device_id!);
    const def = DEVICE_ACTIONS[action];
    const { passcode_enc, ...params } = ev.params as Record<string, unknown>;
    if (typeof passcode_enc === "string") params.passcode = await decryptSecret(passcode_enc);
    if (params.passcode === "[removed]") throw new Error("Passcode was scrubbed from this old event; send a new reset");
    // Samsung Knox devices get shutdown/restart via /knox_actions/ — the standard /actions/ endpoint returns COM0007.
    const useKnox = device.platform === "android" && !!device.is_knox && !!def.knoxOnlyAndroid;
    const send = useKnox ? runKnoxDeviceAction : runDeviceAction;
    let zoho;
    try {
      zoho = await send(ev.enterprise_id, device.zoho_device_id, action, params);
    } catch (e) {
      // Zoho's 412 CMD0001 "Command not applicable for Device": say what usually causes it.
      const err = toAppError(e);
      if (err.code === "ZOHO_BAD_REQUEST" && /not applicable|CMD0001/i.test(`${err.message} ${JSON.stringify(err.details ?? "")}`)) {
        fail("ZOHO_BAD_REQUEST", `Zoho says ${def.label.toLowerCase()} doesn't apply to ${device.device_name ?? "this device"}. ${NOT_APPLICABLE_HINT[`${action}:${device.platform}`] ?? NOT_APPLICABLE_HINT[action] ?? "The phone's platform or management mode doesn't support it."}`, err.details);
      }
      throw e;
    }
    return { state: "sent", response: { zoho_send: zoho ?? { status: "accepted" }, endpoint: useKnox ? "knox" : "standard" } };
  });
}

/** Most common reasons Zoho answers CMD0001 for each command (shown to the admin). */
const NOT_APPLICABLE_HINT: Record<string, string> = {
  "reset_passcode:ios": "Apple doesn't let an MDM set a passcode on iPhone or iPad. Use Clear passcode, then the user sets a new one.",
  "clear_passcode:ios": "Zoho needs the iPhone's unlock token, which it only gets if the phone had a passcode when it enrolled. Re-enrol it with a passcode set, or erase it with Complete wipe.",
  reset_passcode: "On Android it only works on company-owned phones fully managed by Zoho (not personal or work-profile phones), and the new passcode must meet the passcode policy of the phone's groups (length and type).",
  clear_passcode: "Android 7 and later don't allow an MDM to clear the passcode on most phones. Use Reset passcode to set a new one instead.",
  pause_kiosk: "The phone isn't in kiosk mode right now.",
  re_apply_kiosk: "The phone has no kiosk profile applied right now.",
  enable_lost_mode: "Lost mode needs a company-owned phone (and, on iPhone, a supervised one).",
  fetch_location: "Location needs the Zoho MDM app with location permission on the phone (and, on iPhone, a supervised device).",
  restart: "Restart needs a Samsung Knox phone on Android or a supervised iPhone.",
  shutdown: "Shut down needs a Samsung Knox phone on Android or a supervised iPhone.",
};

// The group event only carries the confirmation; confirmCommand() creates the per-device
// commands. It never enters the queue, so this executor exists only to satisfy createEvent().
registerExecutor("group.reset_passcode", () => {
  fail("CONFLICT", "Group passcode resets run only after they are confirmed");
});

// ------------------------------------------------------ acknowledgement poll
type HistoryCommand = { command_name?: string; added_time?: number; command_status?: number; remarks?: string; command_life?: { status_description?: string; status_code?: number }[] };

const MAX_POLLS = 40; // fast polls (~13 h), then every 6 h
const OFFLINE_WAIT_DAYS = 14;

function classify(cmd: HistoryCommand): "succeeded" | "failed" | "acknowledged" {
  const life = cmd.command_life ?? [];
  const last = life[life.length - 1];
  const text = `${last?.status_description ?? ""} ${cmd.remarks ?? ""}`;
  if (/success|completed/i.test(text) || cmd.command_status === 2) return "succeeded";
  if (/fail|error|not supported|not compatible/i.test(text)) return "failed";
  return "acknowledged";
}

/** Called by the worker for events in state "sent". */
export async function pollCommandStatus(ev: EventRow): Promise<void> {
  const action = ev.action.replace(/^command\./, "");
  const def = DEVICE_ACTIONS[action];
  const polls = Number((ev.response as { polls?: number } | null)?.polls ?? 0) + 1;
  const device = await getDevice(ev.enterprise_id, ev.device_id!);

  const history = await getCommandHistory(ev.enterprise_id, device.zoho_device_id, { days: 2, limit: 25 });
  const commands = ((history as { commands?: HistoryCommand[] }).commands ?? [])
    .filter((c) => (c.added_time ?? 0) >= Date.parse(ev.sent_at ?? ev.action_time) - 120_000)
    .filter((c) => !def || def.history.test(c.command_name ?? ""))
    .sort((a, b) => (b.added_time ?? 0) - (a.added_time ?? 0));

  const match = commands[0];
  const outcome = match ? classify(match) : null;
  const response = { ...(ev.response ?? {}), polls, zoho_status: match ?? null };

  if (outcome === "succeeded" || outcome === "failed") {
    await updateEvent(ev.id, {
      state: outcome,
      response,
      completed_at: new Date().toISOString(),
      error_code: outcome === "failed" ? "ZOHO_BAD_REQUEST" : null,
      error_message: outcome === "failed" ? (match?.remarks ?? "Device reported failure") : null,
      locked_until: null,
    });
    if (outcome === "succeeded") await applyLocalEffects(ev, device.id);
    return;
  }
  // Still waiting: usually the phone is offline. Zoho keeps the command and the phone runs it
  // when it reconnects, so keep checking: quickly at first, then every 6 hours for up to 14 days.
  const ageMs = Date.now() - Date.parse(ev.sent_at ?? ev.action_time);
  const givingUp = ageMs > OFFLINE_WAIT_DAYS * 86400_000;
  const waitMs = polls < MAX_POLLS ? Math.min(60_000 * polls, 30 * 60_000) : 6 * 3600_000;
  await updateEvent(ev.id, {
    state: outcome === "acknowledged" ? "acknowledged" : "sent",
    response,
    next_attempt_at: new Date(Date.now() + (givingUp ? 365 * 86400_000 : waitMs)).toISOString(),
    error_message: givingUp
      ? `The phone hasn't answered for ${OFFLINE_WAIT_DAYS} days. Zoho still holds the command; check the device in Zoho.`
      : polls >= MAX_POLLS ? "Waiting for the phone to come online; checking every 6 hours." : null,
    locked_until: null,
  });
}

async function applyLocalEffects(ev: EventRow, deviceId: string) {
  if (ev.action === "command.enable_lost_mode") await db().from("devices").update({ is_lost_mode: true }).eq("id", deviceId);
  if (ev.action === "command.disable_lost_mode") await db().from("devices").update({ is_lost_mode: false }).eq("id", deviceId);
  if (ev.action === "command.complete_wipe") {
    await recordAudit({ enterpriseId: ev.enterprise_id, category: "command", action: "device.wiped", deviceId });
  }
}
