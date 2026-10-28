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

Deno.test("kiosk payload encodes allowed_apps as a JSON array of {app_id, group_display_name}", () => {
  const p = buildKioskPayload({ mode: "single", apps: [{ appId: "247008000000124034", packageName: "com.acme.pos", name: "Acme POS" }] });
  assert.equal(p.kiosk_mode, 0);
  const apps = JSON.parse(p.allowed_apps as string) as { app_id: number; group_display_name: string }[];
  assert.equal(apps.length, 1);
  assert.equal(apps[0].app_id, 247008000000124034);
  assert.equal(apps[0].group_display_name, "Acme POS");
  assert.throws(() => buildKioskPayload({ mode: "single", apps: [] }));
  assert.throws(() => buildKioskPayload({ mode: "single", apps: [{ appId: "1", packageName: "bad name!" }] }));
});

Deno.test("kiosk payload preserves 18-digit app_group_id precision (string, not Number)", () => {
  // Zoho app_group_ids like 247008000000159173 exceed Number.MAX_SAFE_INTEGER.
  // Number(…) rounds the last 1-2 digits (→ 247008000000159170), and Zoho then
  // returns 404 "Unknown id(s)". The wire payload must preserve the exact digits.
  const id = "247008000000159173";
  const p = buildKioskPayload({ mode: "single", apps: [{ appId: id, packageName: "com.google.android.dialer" }] });
  // Assert the raw JSON STRING contains the exact digits, not Number(id).
  assert.ok((p.allowed_apps as string).includes(`"app_id":${id}`), `expected exact digits "${id}" in ${p.allowed_apps}`);
  assert.ok(!(p.allowed_apps as string).includes("247008000000159170"), "precision was lost — Number() rounded the id");
});

Deno.test("kiosk payload rejects non-numeric app ids (synthetic installed-/common-/manual-)", () => {
  assert.throws(() => buildKioskPayload({ mode: "single", apps: [{ appId: "installed-com.foo", packageName: "com.foo" }] }));
  assert.throws(() => buildKioskPayload({ mode: "single", apps: [{ appId: "manual-123-1", packageName: "com.foo" }] }));
});

Deno.test("kiosk payload fills every Zoho field with sensible defaults", () => {
  const p = buildKioskPayload({ mode: "single", apps: [{ appId: "1", packageName: "com.a.b" }] });
  // Launcher at top level
  assert.equal(p.launcher_type, 2);
  // screen_orientation and screen_timeout live inside kiosk_custom_settings per Zoho's live API.
  const kcs = p.kiosk_custom_settings as { screen_orientation: number; screen_timeout: number };
  assert.equal(kcs.screen_orientation, 2);
  assert.equal(kcs.screen_timeout, 0);
  // Shutdown mirrors power button when not set
  assert.equal(p.allow_shutdown, p.allow_power_button);
  // All the chrome / button fields Zoho actually accepts
  for (const k of ["allow_key_guard", "allow_notification", "allow_recent_apps", "allow_task_manager", "allow_system_error_dialog", "allow_custom_settings", "show_me_mdm_app", "allow_status_bar_expansion"]) {
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
  const {
    buildIosEmailPayload,
    buildIosKioskPayload,
    buildIosPasscodePayload,
    buildIosProxyPayload,
    buildIosVpnPayload,
    buildIosWebFilterPayload,
    buildIosWifiPayload,
    buildRestrictionsPayload: buildR,
  } = await import("../zoho/payloads.ts");
  const { buildPayload } = await import("../services/profiles.ts");

  Deno.test("unsupervised iPhones don't get supervised-only commands", () => {
    const sup = { platform: "ios", is_knox: null, is_supervised: true };
    const unsup = { platform: "ios", is_knox: null, is_supervised: false };
    const unknown = { platform: "ios", is_knox: null, is_supervised: null };
    for (const a of ["enable_lost_mode", "remote_alarm", "restart", "shutdown"]) {
      assert.equal(actionAppliesTo(a, sup), true, `${a} supervised`);
      assert.equal(actionAppliesTo(a, unsup), false, `${a} unsupervised`);
      // Previously let unknown through; prod backlog showed Zoho rejects these every
      // time with "Command not applicable for Device", so unknown now blocks too.
      assert.equal(actionAppliesTo(a, unknown), false, `${a} unknown is blocked`);
    }
    for (const a of ["lock", "complete_wipe", "clear_passcode", "scan", "fetch_location"]) assert.equal(actionAppliesTo(a, unsup), true, a);
    // Apple MDM can't set a passcode on iOS (only clear it), supervised or not —
    // not even when supervision is still unknown. Lock in all three cases so a
    // future refactor can't quietly re-enable it.
    for (const d of [sup, unsup, unknown]) assert.equal(actionAppliesTo("reset_passcode", d), false, "reset_passcode iOS");
    assert.equal(actionAppliesTo("reset_passcode", { platform: "android", is_knox: false, is_supervised: null }), true);
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
    // Android unchanged
    assert.deepEqual(buildR({ allow_camera: "restrict" }), { allow_camera: 2 });
  });

  Deno.test("iOS kiosk routes to applockpolicy with guide field shape", () => {
    const single = buildPayload("ios", "kiosk", { mode: "single", apps: [{ appId: "9007199254741861", displayName: "POS" }] });
    assert.equal(single.name, "applockpolicy");
    assert.equal((single.body as Record<string, unknown>).kiosk_mode, 1);
    assert.equal((single.body as Record<string, unknown>).disable_auto_lock, true);
    // Precision check: 9007199254741861 is past 2^53, so Number() would mangle it.
    // Confirm the JSON string preserves the exact digits.
    const sJson = (single.body as Record<string, string>).allowed_apps;
    assert.ok(sJson.includes("9007199254741861"), "exact app_id digits must be preserved");
    const sApps = JSON.parse(sJson);
    assert.equal(sApps[0].group_display_name, "POS");
    // is_system_app intentionally omitted — Zoho's live API rejects it even though
    // the guide field table lists it as required.
    assert.ok(!("is_system_app" in sApps[0]));
    // Multi mode also writes allowed_apps per the guide samples.
    const multi = buildIosKioskPayload({ mode: "multi", apps: [{ appId: "111", displayName: "A" }, { appId: "222" }] });
    assert.equal(multi.kiosk_mode, 2);
    assert.ok(!("autonomous_kiosk_apps" in multi), "guide samples use allowed_apps for both modes");
    const mApps = JSON.parse(multi.allowed_apps as string);
    assert.equal(mApps.length, 2);
    assert.equal(mApps[1].group_display_name, "222");
    // Multi-mode must NOT send mode-1-only toggle fields.
    assert.ok(!("disable_touch" in multi));
    assert.throws(() => buildIosKioskPayload({ mode: "single", apps: [] }));
    assert.throws(() => buildIosKioskPayload({ mode: "single", apps: [{ appId: "1" }, { appId: "2" }] }));
    assert.throws(() => buildIosKioskPayload({ mode: "single", apps: [{ appId: "com.not-numeric" }] }));
  });

  Deno.test("iOS Wi-Fi payload requires password for encrypted networks", () => {
    const p = buildIosWifiPayload({ ssid: "Office", password: "s3cret", encryption: "WPA2" });
    assert.equal(p.ssid_str, "Office");
    assert.equal(p.encryption_type, "WPA2");
    assert.equal(p.password, "s3cret");
    const open = buildIosWifiPayload({ ssid: "Guest", encryption: "None" });
    assert.equal("password" in open, false);
    assert.throws(() => buildIosWifiPayload({ ssid: "", password: "x" }));
    assert.throws(() => buildIosWifiPayload({ ssid: "x", encryption: "WPA2" }));
    const r = buildPayload("ios", "wifi", { ssid: "Office", encryption: "WPA2", password: "pw" });
    assert.equal(r.name, "wifipolicy");
  });

  Deno.test("iOS web filter encodes allow-only vs limit-adult", () => {
    const allow = buildIosWebFilterPayload({ mode: "allow-only", permittedUrls: ["https://a.co"], allowedUrls: [{ title: "A", url: "https://a.co" }] });
    assert.equal(allow.filter_type, "allow-only");
    assert.deepEqual(JSON.parse(allow.permitted_urls as string), ["https://a.co"]);
    const limit = buildIosWebFilterPayload({ mode: "limit-adult", blacklistedUrls: ["https://bad.example"] });
    assert.equal(limit.filter_type, "limit-adult-content");
    assert.throws(() => buildIosWebFilterPayload({ mode: "allow-only", permittedUrls: [] }));
    assert.throws(() => buildIosWebFilterPayload({ mode: "allow-only", permittedUrls: ["not-a-url"] }));
    assert.equal(buildPayload("ios", "webfilter", { mode: "limit-adult", blacklistedUrls: [] }).name, "webcontentfilterpolicy");
  });

  Deno.test("iOS VPN payload validates servers and types", () => {
    const vpn = buildIosVpnPayload({ connectionName: "Work", server: "vpn.co.tz", type: "IKEv2", account: "jane", password: "p" });
    assert.equal(vpn.connection_name, "Work");
    assert.equal(vpn.connection_type, "IKEv2");
    assert.throws(() => buildIosVpnPayload({ connectionName: "", server: "vpn.co.tz" }));
    assert.throws(() => buildIosVpnPayload({ connectionName: "x", server: "" }));
    assert.throws(() => buildIosVpnPayload({ connectionName: "x", server: "y", proxyServer: "p", proxyPort: 70000 }));
    assert.equal(buildPayload("ios", "vpn", { connectionName: "x", server: "y" }).name, "vpnpolicy");
  });

  Deno.test("iOS email payload applies IMAP defaults and validates addresses", () => {
    const em = buildIosEmailPayload({
      accountDescription: "Work",
      emailAddress: "jane@co.tz",
      incomingMailServer: "imap.co.tz",
      outgoingMailServer: "smtp.co.tz",
    });
    assert.equal(em.email_account_type, "EmailTypeIMAP");
    assert.equal(em.incoming_mail_server_port, 993);
    assert.equal(em.outgoing_mail_server_port, 587);
    assert.equal(em.incoming_mail_server_username, "jane@co.tz");
    assert.throws(() => buildIosEmailPayload({ accountDescription: "", emailAddress: "a@b.co", incomingMailServer: "x", outgoingMailServer: "y" }));
    assert.throws(() => buildIosEmailPayload({ accountDescription: "x", emailAddress: "not-an-email", incomingMailServer: "x", outgoingMailServer: "y" }));
    assert.equal(buildPayload("ios", "email", { accountDescription: "x", emailAddress: "a@b.co", incomingMailServer: "x", outgoingMailServer: "y" }).name, "emailpolicy");
  });

  Deno.test("iOS global HTTP proxy supports manual and PAC modes", () => {
    const manual = buildIosProxyPayload({ proxyType: "manual", server: "proxy.co.tz", port: 8080, username: "u", password: "p" });
    assert.equal(manual.proxy_type, "manual");
    assert.equal(manual.proxy_server_port, 8080);
    const auto = buildIosProxyPayload({ proxyType: "auto", pacUrl: "https://proxy.co.tz/wpad.dat" });
    assert.equal(auto.proxy_type, "auto");
    assert.throws(() => buildIosProxyPayload({ proxyType: "manual", server: "x" })); // missing port
    assert.throws(() => buildIosProxyPayload({ proxyType: "auto", pacUrl: "ftp://x" }));
    assert.equal(buildPayload("ios", "proxy", { proxyType: "auto", pacUrl: "https://x/wpad.dat" }).name, "globalhttpproxypolicy");
  });

  Deno.test("iOS buildPayload rejects purposes outside the iOS allow-list", () => {
    assert.throws(() => buildPayload("ios", "frp", { accounts: [] }));
  });
}

// ----------------------------------------------- device-level app blacklist
{
  const { blacklistAppsOnDevice } = await import("../services/apps.ts");
  // Validation runs synchronously before any DB access; a stub session is enough.
  const s = { sessionId: "x", adminId: "x", enterpriseId: "x", enterpriseName: "", email: "", fullName: null, role: "admin" as const };
  const good = { identifier: "com.example.app", platform: 2, appname: "Example" };

  Deno.test("device blacklist rejects empty entries", async () => {
    await assert.rejects(() => blacklistAppsOnDevice(s, "d", [], null), /at least one app/i);
  });

  Deno.test("device blacklist caps entries at 100", async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ ...good, identifier: `com.example.a${i}` }));
    await assert.rejects(() => blacklistAppsOnDevice(s, "d", many, null), /100 apps/);
  });

  Deno.test("device blacklist rejects malformed package identifiers", async () => {
    await assert.rejects(() => blacklistAppsOnDevice(s, "d", [{ ...good, identifier: "has spaces" }], null), /Invalid package identifier/);
    await assert.rejects(() => blacklistAppsOnDevice(s, "d", [{ ...good, identifier: "" }], null), /Invalid package identifier/);
    await assert.rejects(() => blacklistAppsOnDevice(s, "d", [{ ...good, identifier: "1starts.with.digit" }], null), /Invalid package identifier/);
  });

  Deno.test("device blacklist rejects unknown platform codes", async () => {
    await assert.rejects(() => blacklistAppsOnDevice(s, "d", [{ ...good, platform: 9 }], null), /Invalid platform code/);
  });
}

// Zoho's /blacklist/status returns an integer code with no documented enum.
// The label helper must fall through to a literal "status N" for unknowns so
// the UI never silently hides a code we haven't mapped yet.
{
  const { blacklistStatusLabel } = await import("../services/apps.ts");

  Deno.test("blacklistStatusLabel maps known codes and falls through for unknowns", () => {
    assert.equal(blacklistStatusLabel(1).label, "pending");
    assert.equal(blacklistStatusLabel(2).tone, "ok");
    assert.equal(blacklistStatusLabel(3).tone, "bad");
    assert.equal(blacklistStatusLabel(4).label, "enforced");
    // Unknown code: never swallow — surface the raw number.
    assert.equal(blacklistStatusLabel(99).label, "status 99");
    assert.equal(blacklistStatusLabel(99).tone, "muted");
    // Null / undefined: no row from Zoho — explicit "no status".
    assert.equal(blacklistStatusLabel(null).label, "no status");
    assert.equal(blacklistStatusLabel(undefined).code, null);
  });
}
