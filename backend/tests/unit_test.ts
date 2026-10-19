// Unit tests that need no database or network:  deno task test
import assert from "node:assert/strict";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test");
Deno.env.set("ENCRYPTION_KEY", btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
Deno.env.set("HASH_PEPPER", "unit-test-pepper");

const { buildKioskPayload, buildPasscodePayload, buildRestrictionsPayload } = await import("../zoho/payloads.ts");
const { decryptSecret, encryptSecret, hmacHex, randomDigits } = await import("../lib/crypto.ts");
const { toSafeHtml } = await import("../services/announcements.ts");
const { backoffMs } = await import("../services/events.ts");
const { apiBaseFor, normaliseAccountsServer } = await import("../zoho/client.ts");
const { DEVICE_ACTIONS, DESTRUCTIVE, deviceTag } = await import("../services/commands.ts");
const { redactParams } = await import("../routes/helpers.ts");

Deno.test("restrictions map allow/restrict to the guide's numeric values", () => {
  const p = buildRestrictionsPayload({ allow_factory_reset: "restrict", allow_camera: "restrict", allow_usb_debug: "allow" });
  assert.deepEqual(p, { allow_factory_reset: 0, allow_camera: 2, allow_usb_debug: 1 });
  assert.throws(() => buildRestrictionsPayload({ allow_teleport: "restrict" }));
  assert.throws(() => buildRestrictionsPayload({}));
});

Deno.test("restrictions support enum, integer, and boolean kinds", () => {
  const p = buildRestrictionsPayload({
    allow_wifi: 4,                       // enum: locked on
    allow_storage_encryption: 2,         // enum: required
    screen_timeout: 30,                  // integer in [15, 1800]
    adaptive_brightness: false,          // boolean
  });
  assert.deepEqual(p, {
    allow_wifi: 4,
    allow_storage_encryption: 2,
    screen_timeout: 30,
    adaptive_brightness: false,
  });
});

Deno.test("restrictions reject out-of-range and bad enum/boolean values", () => {
  assert.throws(() => buildRestrictionsPayload({ screen_timeout: 5000 }));       // > max
  assert.throws(() => buildRestrictionsPayload({ allow_wifi: 7 }));              // not an enum option
  assert.throws(() => buildRestrictionsPayload({ adaptive_brightness: "yes" })); // not boolean
  assert.throws(() => buildRestrictionsPayload({ brightness_value: -1 }));       // < min
});

Deno.test("kiosk payload encodes allowed_apps as a JSON string", () => {
  const p = buildKioskPayload({ mode: "single", apps: [{ appId: "42", packageName: "com.acme.pos" }] });
  assert.equal(p.kiosk_mode, 0);
  assert.equal(JSON.parse(p.allowed_apps as string)["42"].IDENTIFIER, "com.acme.pos");
  assert.throws(() => buildKioskPayload({ mode: "single", apps: [] }));
  assert.throws(() => buildKioskPayload({ mode: "single", apps: [{ appId: "1", packageName: "bad name!" }] }));
});

Deno.test("kiosk payload fills every Zoho field with sensible defaults", () => {
  const p = buildKioskPayload({ mode: "single", apps: [{ appId: "1", packageName: "com.a.b" }] });
  // Launcher / display defaults
  assert.equal(p.launcher_type, 2);
  assert.equal(p.screen_orientation, 2);
  assert.equal(p.screen_timeout, 0);
  // Shutdown mirrors power button when not set
  assert.equal(p.allow_shutdown, p.allow_power_button);
  // All the new buttons / chrome fields are present
  for (const k of ["allow_volume_button", "allow_key_guard", "allow_notification", "allow_recent_apps", "allow_task_manager", "allow_system_error_dialog", "allow_custom_settings", "show_me_mdm_app", "allow_status_bar_expansion"]) {
    assert.ok(k in p, `missing ${k}`);
  }
});

Deno.test("kiosk payload rejects invalid launcher / orientation / timeout", () => {
  const apps = [{ appId: "1", packageName: "com.a.b" }];
  assert.throws(() => buildKioskPayload({ mode: "single", apps, launcherType: 9 as 1 | 2 }));
  assert.throws(() => buildKioskPayload({ mode: "single", apps, screenOrientation: 99 as 1 }));
  assert.throws(() => buildKioskPayload({ mode: "single", apps, screenTimeout: 7 }));
});

Deno.test("passcode payload validates the wipe threshold", () => {
  assert.equal(buildPasscodePayload({ maxFailedAttempts: 8 }).max_failed_attempts, 8);
  assert.equal(buildPasscodePayload({ maxFailedAttempts: -1 }).max_failed_attempts, -1);
  assert.throws(() => buildPasscodePayload({ maxFailedAttempts: 2 }));
});

Deno.test("passcode payload fills Zoho's required + sensible defaults", () => {
  const p = buildPasscodePayload({});
  // scope_for_passcode is required by Zoho; default to device scope.
  assert.equal(p.scope_for_passcode, 0);
  // Enforcement knobs Zoho honours by default.
  assert.equal(p.grace_period, 60);
  assert.equal(p.allow_fingerprint, 1);
  assert.equal(p.allow_face_unlock, true);
  assert.equal(p.allow_iris_scan, true);
  assert.equal(p.allow_one_lock, true);
});

Deno.test("passcode payload forwards all opt-in fields", () => {
  const p = buildPasscodePayload({
    scope: 1,
    gracePeriodMinutes: 15,
    allowFingerprint: 0,
    allowFaceUnlock: false,
    allowIrisScan: false,
    allowOneLock: false,
  });
  assert.equal(p.scope_for_passcode, 1);
  assert.equal(p.grace_period, 15);
  assert.equal(p.allow_fingerprint, 0);
  assert.equal(p.allow_face_unlock, false);
  assert.equal(p.allow_iris_scan, false);
  assert.equal(p.allow_one_lock, false);
});

Deno.test("passcode payload rejects out-of-range grace period and bad scope", () => {
  assert.throws(() => buildPasscodePayload({ gracePeriodMinutes: 2000 }));
  assert.throws(() => buildPasscodePayload({ gracePeriodMinutes: 0 }));
  assert.throws(() => buildPasscodePayload({ scope: 99 }));
  assert.throws(() => buildPasscodePayload({ allowFingerprint: 2 }));
  // Guide: scope is 0 (device) or 1 (work profile) only; -1/2/3 are rejected by Zoho.
  assert.throws(() => buildPasscodePayload({ scope: -1 }));
  assert.throws(() => buildPasscodePayload({ scope: 2 }));
  // Guide: min_passcode_length accepts -1 (none) or 4–16.
  assert.equal(buildPasscodePayload({ minLength: -1 }).min_passcode_length, -1);
  assert.throws(() => buildPasscodePayload({ minLength: 3 }));
  assert.throws(() => buildPasscodePayload({ minLength: 17 }));
  // Guide: max_passcode_age 0–1000, no_of_passcode_maintained 0–100.
  assert.throws(() => buildPasscodePayload({ maxAgeDays: 1001 }));
  assert.throws(() => buildPasscodePayload({ maxAgeDays: -1 }));
  assert.throws(() => buildPasscodePayload({ history: 101 }));
  assert.throws(() => buildPasscodePayload({ history: -1 }));
});

Deno.test("secrets round-trip through AES-GCM and never appear in ciphertext", async () => {
  const blob = await encryptSecret("1000.refresh.token");
  assert.ok(blob.startsWith("v1:") && !blob.includes("refresh"));
  assert.equal(await decryptSecret(blob), "1000.refresh.token");
  assert.notEqual(await encryptSecret("x"), await encryptSecret("x")); // random IV
});

Deno.test("OTP helpers", async () => {
  const code = randomDigits(6);
  assert.match(code, /^\d{6}$/);
  assert.equal(await hmacHex("a"), await hmacHex("a"));
  assert.notEqual(await hmacHex("a"), await hmacHex("b"));
});

Deno.test("announcement text is escaped before it becomes device HTML", () => {
  assert.equal(toSafeHtml("<script>x</script>\nline"), "<p>&lt;script&gt;x&lt;/script&gt;<br>line</p>");
});

Deno.test("backoff grows and is capped", () => {
  assert.ok(backoffMs(1) < backoffMs(4));
  assert.ok(backoffMs(30) <= 30 * 60_000 * 1.2);
});

Deno.test("only known Zoho data centres are accepted", () => {
  assert.equal(normaliseAccountsServer("https://accounts.zoho.eu"), "https://accounts.zoho.eu");
  assert.equal(apiBaseFor("https://accounts.zoho.eu"), "https://mdm.manageengine.eu/api/v1/mdm");
  assert.throws(() => normaliseAccountsServer("https://evil.example.com"));
});

Deno.test("destructive actions need confirmation and the owner role", () => {
  assert.equal(DEVICE_ACTIONS.complete_wipe.confirm, true);
  assert.equal(DEVICE_ACTIONS.complete_wipe.minRole, "owner");
  assert.equal(DEVICE_ACTIONS.lock.confirm, false);
  // Every wipe and passcode action must go through the two-step confirmation.
  assert.deepEqual([...DESTRUCTIVE].sort(), ["clear_passcode", "complete_wipe", "corporate_wipe", "reset_passcode"]);
});

Deno.test("devices with the same name are told apart by serial / IMEI tail", () => {
  assert.deepEqual(deviceTag({ serial_number: "r58x-1a2b", imei: "357327071694307", zoho_device_id: "247008000000130084" }), { tag: "1A2B", source: "serial number" });
  assert.deepEqual(deviceTag({ serial_number: null, imei: "357327071694307", zoho_device_id: "1" }), { tag: "4307", source: "IMEI" });
  assert.deepEqual(deviceTag({ serial_number: "", imei: null, zoho_device_id: "247008000000130084" }), { tag: "0084", source: "device id" });
});

Deno.test("passcodes never leave the server; viewers don't see contact details", () => {
  const p = { passcode_enc: "abc", email_sent_to_user: true, phone_number: "+255700000000" };
  assert.deepEqual(redactParams(p, "admin"), { passcode: "[hidden]", email_sent_to_user: true, phone_number: "+255700000000" });
  assert.deepEqual(redactParams(p, "viewer"), { passcode: "[hidden]", email_sent_to_user: true, phone_number: "[hidden]" });
  assert.deepEqual(redactParams({ passcode: "1234" }), { passcode: "[hidden]" });
});

// ------------------------------------------------------------ monitoring
const { isWorkingTime } = await import("../services/monitoring.ts");
const { distanceM, evaluateFences } = await import("../services/locations.ts");
const { evaluateDataUse, evaluateSecurity } = await import("../services/security-scan.ts");

Deno.test("working hours are evaluated in the enterprise timezone", () => {
  const st = { work_start: "08:00", work_end: "18:00", work_days: [1, 2, 3, 4, 5], timezone: "Africa/Dar_es_Salaam" };
  assert.equal(isWorkingTime(st, new Date("2026-10-01T06:30:00Z")), true); // Thu 09:30 EAT
  assert.equal(isWorkingTime(st, new Date("2026-10-01T04:30:00Z")), false); // Thu 07:30 EAT
  assert.equal(isWorkingTime(st, new Date("2026-10-03T08:00:00Z")), false); // Saturday
  assert.equal(isWorkingTime({ ...st, work_start: "22:00", work_end: "06:00" }, new Date("2026-10-01T00:00:00Z")), true); // night shift 03:00
});

Deno.test("geofence maths", () => {
  assert.ok(Math.abs(distanceM(-6.8161, 39.2803, -6.7661, 39.2803) - 5560) < 30);
  const fence = { id: "f", enterprise_id: "e", group_id: null, name: "Office", kind: "allowed" as const, latitude: -6.8161, longitude: 39.2803, radius_m: 1000, active_hours_only: true, enabled: true };
  assert.equal(evaluateFences({ latitude: -6.8161, longitude: 39.2803 }, [fence], true).outsideAllowed, false);
  assert.equal(evaluateFences({ latitude: -6.7661, longitude: 39.2803 }, [fence], true).outsideAllowed, true);
  assert.equal(evaluateFences({ latitude: -6.7661, longitude: 39.2803 }, [fence], false).outsideAllowed, false); // after hours
});

Deno.test("security conditions", () => {
  const now = new Date();
  const c = evaluateSecurity({ security: { device_rooted: true, passcode_present: false }, lastContactAt: new Date(now.getTime() - 50 * 3600_000), offlineHours: 48, now });
  assert.equal(c.rooted, true);
  assert.equal(c.passcodeMissing, true);
  assert.equal(c.offline, true);
});

Deno.test("data spike needs a baseline and ignores idle periods", () => {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  let snap = { data_total: 1000, data_rate_baseline: null as number | null, data_samples: 0, captured_at: hourAgo };
  for (let i = 1; i <= 4; i++) {
    const r = evaluateDataUse(snap, 1000 + i * 100, 3);
    assert.equal(r.spike, false);
    snap = { data_total: 1000 + i * 100, data_rate_baseline: r.baseline, data_samples: r.samples, captured_at: hourAgo };
  }
  assert.equal(evaluateDataUse(snap, snap.data_total, 3).spike, false); // idle
  assert.equal(evaluateDataUse(snap, snap.data_total + 5000, 3).spike, true);
});

// ------------------------------------------------------------ Apple devices
{
  const { actionAppliesTo } = await import("../services/commands.ts");
  const { buildIosPasscodePayload, buildRestrictionsPayload: buildR } = await import("../zoho/payloads.ts");
  const { buildPayload } = await import("../services/profiles.ts");

  Deno.test("unsupervised iPhones don't get supervised-only commands", () => {
    const sup = { platform: "ios", is_knox: null, is_supervised: true };
    const unsup = { platform: "ios", is_knox: null, is_supervised: false };
    const unknown = { platform: "ios", is_knox: null, is_supervised: null };
    for (const a of ["enable_lost_mode", "fetch_location", "remote_alarm", "restart", "shutdown"]) {
      assert.equal(actionAppliesTo(a, sup), true, `${a} supervised`);
      assert.equal(actionAppliesTo(a, unsup), false, `${a} unsupervised`);
      assert.equal(actionAppliesTo(a, unknown), true, `${a} unknown is let through`);
    }
    for (const a of ["lock", "complete_wipe", "clear_passcode", "scan"]) assert.equal(actionAppliesTo(a, unsup), true, a);
    // Apple MDM can't set a passcode on iOS (only clear it), supervised or not.
    assert.equal(actionAppliesTo("reset_passcode", unsup), false);
    assert.equal(actionAppliesTo("reset_passcode", { ...unsup, is_supervised: true }), false);
    assert.equal(actionAppliesTo("pause_kiosk", sup), false);
    // Android unaffected by the iOS rule
    assert.equal(actionAppliesTo("enable_lost_mode", { platform: "android", is_knox: false, is_supervised: false }), true);
  });

  Deno.test("iOS passcode payload uses the guide's ranges", () => {
    const p = buildIosPasscodePayload({ minLength: 6, autoLockMinutes: 5, maxFailedAttempts: 9, requireAlphanumeric: true });
    assert.deepEqual(p, { allow_simple_value: false, require_alphanumeric: true, min_passcode_length: 6, auto_lock_idle_for: 5, max_failed_attempts: 9 });
    assert.throws(() => buildIosPasscodePayload({ maxFailedAttempts: 10 }));
    assert.throws(() => buildIosPasscodePayload({ maxFailedAttempts: 2 }));
    assert.throws(() => buildIosPasscodePayload({ autoLockMinutes: 7 }));
    assert.throws(() => buildIosPasscodePayload({ minLength: 17 }));
    assert.equal("max_failed_attempts" in buildIosPasscodePayload({}), false, "never erase unless chosen");
  });

  Deno.test("iOS restrictions are booleans and go to restrictionspolicy", () => {
    assert.deepEqual(buildR({ allow_use_of_camera: "restrict", allow_airdrop: "allow", force_encrypted_backup: true }, "ios"),
      { allow_use_of_camera: false, allow_airdrop: true, force_encrypted_backup: true });
    assert.throws(() => buildR({ allow_factory_reset: "restrict" }, "ios"), "Android-only key rejected for iOS");
    const r = buildPayload("ios", "restrictions", { restrictions: { allow_app_removal: "restrict" } });
    assert.equal(r.name, "restrictionspolicy");
    assert.equal(buildPayload("ios", "passcode", { minLength: 4 }).name, "passcodepolicy");
    assert.throws(() => buildPayload("ios", "kiosk", {}));
    // Android unchanged
    assert.deepEqual(buildR({ allow_camera: "restrict" }), { allow_camera: 2 });
  });
}
