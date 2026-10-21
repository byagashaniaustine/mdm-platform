// Profile payload builders for Android, based on the field tables in MDM_Dev_Guide.pdf
// ("Profile API Help" section). Values differ per field: most use 1 = allow / 0 = restrict,
// a few (camera, video, audio) use 1 = allow / 2 = restrict. The catalog encodes this.
import { fail } from "../lib/errors.ts";

// Zoho's payload type names are lowercase in the URL path.
// Confirmed shape by inspecting /profiles/{id}/payloads on an already-published profile.
export const PAYLOAD = {
  android: {
    restrictions: "androidrestrictionspolicy",
    kiosk: "androidkioskpolicy",
    passcode: "androidpasscodepolicy",
    frp: "androidefrppolicy",
    wifi: "androidwifipolicy",
  },
  ios: {
    restrictions: "restrictionspolicy",
    passcode: "passcodepolicy",
    wifi: "wifipolicy",
    // iOS Single App Mode goes through the same `applockpolicy` payload Zoho uses
    // for Android kiosk. `singleappmodepolicy` (my previous guess) returns 404.
    kiosk: "applockpolicy",
    webfilter: "webcontentfilterpolicy",
    vpn: "vpnpolicy",
    email: "emailpolicy",
    proxy: "globalhttpproxypolicy",
  },
} as const;

export type Purpose =
  | "restrictions"
  | "kiosk"
  | "passcode"
  | "frp"
  | "wifi"
  | "webfilter"
  | "vpn"
  | "email"
  | "proxy"
  | "custom"
  | "apps"
  | "app_blacklist";

// 'apps' and 'app_blacklist' are platform-synthetic profiles — they live only
// in our DB (no Zoho profile_id). Their payload_config holds the app list; the
// group.associate_profiles executor translates them into install / blacklist
// API calls when they're attached to a group. These names are our own and
// never go over the wire to Zoho.
export const APP_PROFILE_PAYLOAD = "platform_apps_install";
export const APP_BLACKLIST_PAYLOAD = "platform_apps_blacklist";

export type AppProfileEntry = { appId: string; releaseLabelId?: string | null; appName?: string };
export function buildAppsPayload(apps: AppProfileEntry[]) {
  if (!apps.length) fail("VALIDATION_FAILED", "Pick at least one app");
  return { apps: apps.map((a) => ({ appId: String(a.appId), releaseLabelId: a.releaseLabelId ?? null, appName: a.appName ?? null })) };
}

export type BlacklistProfileEntry = { identifier: string; platform: number; appname: string };
export function buildAppBlacklistPayload(apps: BlacklistProfileEntry[]) {
  if (!apps.length) fail("VALIDATION_FAILED", "Pick at least one app to blacklist");
  for (const a of apps) {
    if (!/^[a-zA-Z][\w.]+$/.test(a.identifier)) fail("VALIDATION_FAILED", `Invalid package identifier ${a.identifier}`);
  }
  return { apps };
}

export type RestrictionCategory =
  | "security"
  | "data"
  | "hardware"
  | "apps"
  | "settings"
  | "display"
  | "network";

/**
 * Restriction catalog uses a discriminated union so each Zoho field can model
 * its native shape: a simple allow/restrict toggle (binary), a multi-state
 * (enum, e.g. radios that can be "allow toggle" or "locked on"), a numeric
 * range (integer, e.g. brightness 0-255), or a flat on/off (boolean).
 */
export type RestrictionDef =
  | {
    kind: "binary";
    key: string;
    label: string;
    category: RestrictionCategory;
    allow: number | boolean; // Android uses numbers (1/0 or 1/2); iOS uses true/false
    restrict: number | boolean;
    recommended: "allow" | "restrict";
    hint?: string;
    supervised?: boolean; // iOS: Apple only enforces it on supervised devices
  }
  | {
    kind: "enum";
    key: string;
    label: string;
    category: RestrictionCategory;
    options: readonly { value: number | string; label: string }[];
    recommended?: number | string;
    hint?: string;
  }
  | {
    kind: "integer";
    key: string;
    label: string;
    category: RestrictionCategory;
    min: number;
    max: number;
    recommended?: number;
    unit?: string;
    hint?: string;
  }
  | {
    kind: "boolean";
    key: string;
    label: string;
    category: RestrictionCategory;
    recommended?: boolean;
    hint?: string;
    supervised?: boolean;
  };

export const ANDROID_RESTRICTIONS: readonly RestrictionDef[] = [
  // ----------------------------------------------------------- security
  { kind: "binary", key: "allow_factory_reset", label: "Factory reset from Settings", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_safe_mode", label: "Boot into safe mode", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_developer_mode", label: "Developer options", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_usb_debug", label: "USB debugging", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_user_add_accounts", label: "Add or remove accounts", category: "security", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_keyguard_notifications", label: "Lock-screen notification previews", category: "security", allow: 1, restrict: 0, recommended: "restrict", hint: "Restrict hides message bodies on the lock screen." },
  { kind: "binary", key: "allow_play_protect_monitoring", label: "Google Play Protect scanning", category: "security", allow: 1, restrict: 0, recommended: "allow" },
  { kind: "enum", key: "allow_storage_encryption", label: "Internal storage encryption", category: "security", options: [{ value: 0, label: "Not required" }, { value: 2, label: "Required" }], recommended: 2 },
  { kind: "enum", key: "external_storage_encryption", label: "SD card encryption", category: "security", options: [{ value: 0, label: "Not required" }, { value: 2, label: "Required" }], recommended: 2 },

  // ---------------------------------------------------------------- apps
  { kind: "binary", key: "allow_non_market_apps", label: "Install apps from unknown sources", category: "apps", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_install_app", label: "Users can install apps", category: "apps", allow: 1, restrict: 0, recommended: "allow" },
  { kind: "binary", key: "allow_uninstall_app", label: "Users can uninstall apps", category: "apps", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_android_market", label: "Play Store access", category: "apps", allow: 1, restrict: 0, recommended: "allow" },
  { kind: "binary", key: "allow_all_apps_access", label: "Show every installed app in app drawer", category: "apps", allow: 1, restrict: 0, recommended: "allow", hint: "Restrict hides apps not explicitly allowed by policy." },

  // ------------------------------------------------------------ settings
  { kind: "binary", key: "allow_date_time_change", label: "Change date and time", category: "settings", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_settings", label: "Modify device settings", category: "settings", allow: 1, restrict: 0, recommended: "allow" },

  // ---------------------------------------------------------------- data
  { kind: "binary", key: "allow_usb_media_player", label: "USB file transfer", category: "data", allow: 1, restrict: 0, recommended: "restrict" },
  { kind: "binary", key: "allow_screen_capture", label: "Screenshots", category: "data", allow: 1, restrict: 0, recommended: "allow" },
  { kind: "binary", key: "allow_sd_card", label: "SD card", category: "data", allow: 1, restrict: 0, recommended: "allow" },
  { kind: "binary", key: "allow_usb_tethering", label: "USB tethering", category: "data", allow: 1, restrict: 0, recommended: "restrict" },

  // ------------------------------------------------------------ hardware
  { kind: "binary", key: "allow_camera", label: "Camera", category: "hardware", allow: 1, restrict: 2, recommended: "allow" },
  { kind: "binary", key: "allow_video_record", label: "Video recording", category: "hardware", allow: 1, restrict: 2, recommended: "allow" },
  { kind: "binary", key: "allow_audio_record", label: "Audio recording", category: "hardware", allow: 1, restrict: 2, recommended: "allow" },
  { kind: "binary", key: "allow_microphone", label: "Microphone", category: "hardware", allow: 1, restrict: 0, recommended: "allow" },

  // ------------------------------------------------------------- network
  // Radios use "4" (locked on) rather than full restrict so the device still works.
  { kind: "enum", key: "allow_wifi", label: "Wi-Fi radio", category: "network", options: [{ value: 1, label: "User can toggle" }, { value: 4, label: "Locked on" }], recommended: 1 },
  { kind: "enum", key: "allow_bluetooth", label: "Bluetooth radio", category: "network", options: [{ value: 1, label: "User can toggle" }, { value: 4, label: "Locked on" }], recommended: 1 },
  { kind: "enum", key: "allow_nfc", label: "NFC radio", category: "network", options: [{ value: 1, label: "User can toggle" }, { value: 4, label: "Locked on" }], recommended: 1 },
  { kind: "enum", key: "allow_disabling_gps", label: "GPS / location", category: "network", options: [{ value: 1, label: "User can disable" }, { value: 4, label: "User cannot disable" }], recommended: 4 },
  { kind: "binary", key: "allow_whitelist_wifi_only", label: "Restrict to whitelisted Wi-Fi only", category: "network", allow: 1, restrict: 0, recommended: "allow" },
  { kind: "boolean", key: "set_roaming_always_on", label: "Keep data roaming always on", category: "network", recommended: false },
  { kind: "boolean", key: "allow_data_saver", label: "Data saver", category: "network", recommended: false },

  // ------------------------------------------------------------- display
  { kind: "integer", key: "screen_timeout", label: "Screen auto-lock", category: "display", min: 15, max: 1800, recommended: 60, unit: "seconds" },
  { kind: "integer", key: "brightness_value", label: "Fixed brightness (0 = darkest, 255 = brightest)", category: "display", min: 0, max: 255 },
  { kind: "boolean", key: "adaptive_brightness", label: "Adaptive brightness", category: "display", recommended: true },
];

/**
 * iOS RESTRICTIONS_POLICY (payload "restrictionspolicy", guide section "iOS PROFILES").
 * Every field is a boolean: allow_* true = allowed, false = restricted; force_* true = enforced.
 * A curated subset of the ~100 fields; `supervised` marks ones Apple applies only to
 * supervised devices (Apple Business Manager / Configurator).
 */
export const IOS_RESTRICTIONS: readonly RestrictionDef[] = [
  // ----------------------------------------------------------- security
  { kind: "binary", key: "allow_erase_content_settings", label: "Erase all content and settings", category: "security", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_profile_installation", label: "Install configuration profiles", category: "security", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_account_modification", label: "Add or change accounts (iCloud, Mail)", category: "security", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_modifi_passcode", label: "Change the passcode", category: "security", allow: true, restrict: false, recommended: "allow", supervised: true },
  { kind: "binary", key: "allow_modify_touch_id", label: "Add or remove Touch ID / Face ID", category: "security", allow: true, restrict: false, recommended: "allow", supervised: true },
  { kind: "binary", key: "allow_untrusted_tls_prompt", label: "Accept untrusted certificates", category: "security", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_usb_restriction_mode", label: "Turn off USB restricted mode", category: "security", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "boolean", key: "force_encrypted_backup", label: "Require encrypted backups", category: "security", recommended: true },
  // ---------------------------------------------------------------- apps
  { kind: "binary", key: "allow_app_installation", label: "Install apps from the App Store", category: "apps", allow: true, restrict: false, recommended: "allow", supervised: true },
  { kind: "binary", key: "allow_app_removal", label: "Delete apps", category: "apps", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_inapp_purchase", label: "In-app purchases", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_safari", label: "Safari", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_imessage", label: "iMessage", category: "apps", allow: true, restrict: false, recommended: "allow", supervised: true },
  { kind: "binary", key: "allow_face_time", label: "FaceTime", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_game_center", label: "Game Center", category: "apps", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_assistant", label: "Siri", category: "apps", allow: true, restrict: false, recommended: "allow" },
  // ---------------------------------------------------------------- data
  { kind: "binary", key: "allow_screen_capture", label: "Screenshots and screen recording", category: "data", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_airdrop", label: "AirDrop", category: "data", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_cloud_backup", label: "iCloud backup", category: "data", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_cloud_document_sync", label: "iCloud Drive documents", category: "data", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_cloud_photo_lib", label: "iCloud Photos", category: "data", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_open_doc_in_unmanaged", label: "Open work documents in personal apps", category: "data", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_password_sharing", label: "Share Wi-Fi and passwords over AirDrop", category: "data", allow: true, restrict: false, recommended: "restrict", supervised: true },
  // ------------------------------------------------------------ hardware
  { kind: "binary", key: "allow_use_of_camera", label: "Camera", category: "hardware", allow: true, restrict: false, recommended: "allow" },
  // ------------------------------------------------------- settings/network
  { kind: "binary", key: "allow_modifi_device_name", label: "Rename the device", category: "settings", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "boolean", key: "force_date_time", label: "Set date and time automatically (user can't change)", category: "settings", recommended: true, supervised: true },
  { kind: "binary", key: "allow_bluetooth_modification", label: "Change Bluetooth settings", category: "network", allow: true, restrict: false, recommended: "allow", supervised: true },
  { kind: "binary", key: "allow_vpn_creation", label: "Add VPN configurations", category: "network", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_app_cellular_data", label: "Change mobile data settings for apps", category: "network", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "boolean", key: "force_wifi_whitelisting", label: "Only join Wi-Fi networks sent by MDM", category: "network", recommended: false, supervised: true },

  // ================== Additional keys verified against MDM_Dev_Guide.pdf ==================
  // All names below are copied verbatim from the dev guide's RESTRICTIONS_POLICY table.
  // Default per the guide is almost always true (allowed); recommendation is my call.

  // ----- security / privacy
  { kind: "binary", key: "allow_touch_id", label: "Touch ID / Face ID to unlock", category: "security", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_password_autofill", label: "Password AutoFill in Safari and apps", category: "security", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_password_proximity", label: "Request passwords from nearby devices", category: "security", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_manade_write_unmanaged_contact", label: "Managed contacts can be stored in unmanaged accounts", category: "security", allow: true, restrict: false, recommended: "restrict", hint: "Guide spells it 'manade' — don't correct it." },
  { kind: "binary", key: "allow_unmanaged_read_managed_contact", label: "Unmanaged apps can read managed contacts", category: "security", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_enabling_restriction", label: "User can enable Restrictions / Screen Time", category: "security", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_ota_pki_updates", label: "Automatic updates of trusted certificates", category: "security", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "force_limited_ad_tracking", label: "Force limited ad tracking", category: "security", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_diagnostic_submission", label: "Send diagnostics to Apple", category: "security", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_diag_sub_modification", label: "Modify Diagnostics & Usage settings", category: "security", allow: true, restrict: false, recommended: "restrict" },

  // ----- apps
  { kind: "binary", key: "allow_use_of_youtube", label: "YouTube app", category: "apps", allow: true, restrict: false, recommended: "allow", hint: "Guide notes this is deprecated on newer iOS, but still accepted." },
  { kind: "binary", key: "allow_itunes", label: "iTunes Store", category: "apps", allow: true, restrict: false, recommended: "restrict", supervised: true },
  { kind: "binary", key: "allow_music_service", label: "Apple Music", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_radio_service", label: "Apple Music radio", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_news", label: "Apple News", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_podcasts", label: "Podcasts", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_use_of_ibookstore", label: "iBooks Store", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_managed_book_sync", label: "Enterprise book metadata sync", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_managed_book_backup", label: "Backup enterprise books", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_ibookstore_erotica_media", label: "Explicit iBooks content", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_explicit_content", label: "Explicit music & podcasts", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_managed_app_trust", label: "Trust unauthorized enterprise apps", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_auto_app_download", label: "Auto-download apps across devices (same Apple ID)", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_activity_continuation", label: "Handoff", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_multiplayer_gaming", label: "Multiplayer gaming", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_add_game_center_friend", label: "Add Game Center friends", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "force_istore_pwd_entry", label: "Always require password for App Store / iTunes", category: "apps", allow: true, restrict: false, recommended: "allow" },

  // ----- Siri
  { kind: "binary", key: "allow_assistant_user_content", label: "Siri can query the web", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_assistant_when_locked", label: "Siri while locked", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "force_assist_profanity_filter", label: "Siri profanity filter", category: "apps", allow: true, restrict: false, recommended: "allow", supervised: true },

  // ----- Safari
  { kind: "binary", key: "safari_allow_popups", label: "Safari pop-ups", category: "apps", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "safari_allow_javascript", label: "Safari JavaScript", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "safari_allow_autofill", label: "Safari AutoFill", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "safari_force_fraud_warning", label: "Fraudulent website warning", category: "apps", allow: true, restrict: false, recommended: "allow" },
  { kind: "enum", key: "safari_accept_cookies", label: "Safari cookies", category: "apps", options: [{ value: 0, label: "Never" }, { value: 1, label: "From visited sites" }, { value: 2, label: "Always" }], recommended: 1 },

  // ----- data / iCloud
  { kind: "binary", key: "allow_cloud_keychain_sync", label: "iCloud Keychain", category: "data", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_managed_app_cloud_sync", label: "Managed apps sync to iCloud", category: "data", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_shared_stream", label: "Shared Photo Stream", category: "data", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_photo_stream", label: "iCloud Photo Stream", category: "data", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_sync_while_roaming", label: "Auto-sync while roaming", category: "data", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "force_airdrop_unmanaged", label: "AirDrop from managed apps", category: "data", allow: true, restrict: false, recommended: "restrict" },

  // ----- settings / UI
  { kind: "binary", key: "show_control_center", label: "Control Center on lock screen", category: "settings", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "show_today_view", label: "Today view on lock screen", category: "settings", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "show_notification_center", label: "Notification Center on lock screen", category: "settings", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_passbook_when_locked", label: "Wallet/Passbook on lock screen", category: "settings", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_auto_correction", label: "Auto-Correction", category: "settings", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_predictive_keyboard", label: "Predictive keyboard", category: "settings", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_spellcheck", label: "Spell check", category: "settings", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_dictation", label: "Dictation", category: "settings", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_dictionary_lookup", label: "Dictionary definition lookup", category: "settings", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_voice_dialing", label: "Voice Dial", category: "settings", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_keyboard_shortcut", label: "External keyboard shortcuts", category: "settings", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_find_my_friends_mod", label: "Change Find My Friends", category: "settings", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_spotlight_result", label: "Spotlight internet search", category: "settings", allow: true, restrict: false, recommended: "allow" },

  // ----- AirPrint / AirPlay / Watch
  { kind: "binary", key: "allow_airprint", label: "AirPrint", category: "network", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_airprint_credential_storage", label: "AirPrint credentials in iCloud Keychain", category: "network", allow: true, restrict: false, recommended: "restrict" },
  { kind: "binary", key: "allow_airprint_ibeacon_discovery", label: "AirPrint iBeacon discovery", category: "network", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "force_airprint_tls", label: "AirPrint TLS trust required", category: "network", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "force_airplay_incoming_pwd", label: "Password for incoming AirPlay", category: "network", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "force_airplay_outgoing_pwd", label: "Password for outgoing AirPlay", category: "network", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "allow_paired_watch", label: "Pair with Apple Watch", category: "network", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "force_watch_wrist_detect", label: "Apple Watch wrist detection", category: "network", allow: true, restrict: false, recommended: "allow" },
  { kind: "enum", key: "bluetooth_setting", label: "Bluetooth state", category: "network", options: [{ value: 0, label: "Off" }, { value: 1, label: "On" }, { value: 2, label: "Not configured" }], recommended: 2 },

  // ----- Classroom
  { kind: "binary", key: "allow_classroom_remoteview", label: "Classroom AirPlay / screen view by teacher", category: "data", allow: true, restrict: false, recommended: "allow" },
  { kind: "binary", key: "force_classroom_remoteview", label: "Force Classroom AirPlay without prompt", category: "data", allow: true, restrict: false, recommended: "allow", supervised: true },
  { kind: "binary", key: "force_classroom_appdevicelock", label: "Teacher can lock apps without prompt", category: "data", allow: true, restrict: false, recommended: "allow", supervised: true },
  { kind: "binary", key: "force_classroom_auto_join", label: "Auto-join Classroom without prompt", category: "data", allow: true, restrict: false, recommended: "allow", supervised: true },

  // ----- ratings
  { kind: "boolean", key: "is_rating_enabled", label: "Enable ratings by region", category: "apps", recommended: true },
];

const RESTRICTION_BY_KEY = new Map(ANDROID_RESTRICTIONS.map((r) => [r.key, r] as const));
const IOS_RESTRICTION_BY_KEY = new Map(IOS_RESTRICTIONS.map((r) => [r.key, r] as const));

/**
 * Resolve a user choice into the raw Zoho value for one restriction.
 * selection shape:
 *   binary  -> "allow" | "restrict"
 *   enum    -> the option.value
 *   integer -> number in [min, max]
 *   boolean -> true | false
 */
function resolveRestriction(def: RestrictionDef, choice: unknown): number | boolean {
  switch (def.kind) {
    case "binary":
      if (choice !== "allow" && choice !== "restrict") {
        fail("VALIDATION_FAILED", `${def.key} must be "allow" or "restrict"`);
      }
      return choice === "allow" ? def.allow : def.restrict;
    case "enum": {
      const match = def.options.find((o) => o.value === choice || String(o.value) === String(choice));
      if (!match) fail("VALIDATION_FAILED", `${def.key} must be one of: ${def.options.map((o) => o.value).join(", ")}`);
      return match.value as number;
    }
    case "integer": {
      const n = Number(choice);
      if (!Number.isFinite(n) || n < def.min || n > def.max) {
        fail("VALIDATION_FAILED", `${def.key} must be a number in [${def.min}, ${def.max}]`);
      }
      return n;
    }
    case "boolean":
      if (typeof choice !== "boolean") fail("VALIDATION_FAILED", `${def.key} must be true or false`);
      return choice;
  }
}

export function buildRestrictionsPayload(
  selection: Record<string, unknown>,
  platform: "android" | "ios" = "android",
): Record<string, number | boolean> {
  const catalog = platform === "ios" ? IOS_RESTRICTION_BY_KEY : RESTRICTION_BY_KEY;
  const out: Record<string, number | boolean> = {};
  for (const [key, raw] of Object.entries(selection)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const def = catalog.get(key);
    if (!def) fail("VALIDATION_FAILED", `Unknown restriction: ${key}`);
    out[key] = resolveRestriction(def, raw);
  }
  if (!Object.keys(out).length) fail("VALIDATION_FAILED", "Choose at least one restriction");
  return out;
}

export type KioskApp = { appId: string; packageName: string; name?: string };

// Allowed values for Zoho's enum-typed kiosk fields.
const KIOSK_LAUNCHER_TYPES = [1, 2] as const; // 1 default device launcher, 2 MDM launcher
const KIOSK_SCREEN_ORIENTATIONS = [1, 2, 3, 4] as const; // 1 auto, 2 user, 3 portrait, 4 landscape
const KIOSK_SCREEN_TIMEOUTS = [0, 15, 30, 60, 300, 1800, 2147483647] as const; // 0 user, 2147483647 always on

export function buildKioskPayload(input: {
  mode: "single" | "multi";
  apps: KioskApp[];
  // Hardware buttons (all default true in Zoho → kiosk lockdown should restrict most)
  allowStatusBar?: boolean;
  allowStatusBarExpansion?: boolean;
  allowHomeButton?: boolean;
  allowBackButton?: boolean;
  allowPowerButton?: boolean;
  allowVolumeButton?: boolean;
  allowShutdown?: boolean;
  allowKeyGuard?: boolean;
  // UI chrome
  allowNotification?: boolean;
  allowRecentApps?: boolean;
  allowTaskManager?: boolean;
  allowSystemErrorDialog?: boolean;
  allowCustomSettings?: boolean;
  showMeMdmApp?: boolean;
  // Launcher / display
  launcherType?: 1 | 2;
  screenOrientation?: 1 | 2 | 3 | 4;
  screenTimeout?: number;
  extra?: Record<string, unknown>; // any other kiosk field from the guide, passed through as-is
}) {
  if (!input.apps.length) fail("VALIDATION_FAILED", "Kiosk needs at least one app");
  if (input.mode === "single" && input.apps.length !== 1) fail("VALIDATION_FAILED", "Single-app kiosk takes exactly one app");
  const allowed: Record<string, unknown> = {};
  for (const a of input.apps) {
    if (!/^[a-zA-Z][\w.]+$/.test(a.packageName)) fail("VALIDATION_FAILED", `Invalid package name ${a.packageName}`);
    allowed[a.appId] = {
      SHOW_APP_ICON: true,
      APP_GROUP_ID: a.appId,
      GROUP_DISPLAY_NAME: a.name ?? a.packageName,
      IDENTIFIER: a.packageName,
      APP_TYPE: 1,
      DISPLAY_IMAGE_LOC: "",
    };
  }

  const launcherType = input.launcherType ?? 2;
  const screenOrientation = input.screenOrientation ?? 2;
  const screenTimeout = input.screenTimeout ?? 0;
  if (!KIOSK_LAUNCHER_TYPES.includes(launcherType as 1 | 2)) fail("VALIDATION_FAILED", "launcherType must be 1 or 2");
  if (!KIOSK_SCREEN_ORIENTATIONS.includes(screenOrientation as 1 | 2 | 3 | 4)) fail("VALIDATION_FAILED", "screenOrientation must be 1, 2, 3, or 4");
  if (!KIOSK_SCREEN_TIMEOUTS.includes(screenTimeout as typeof KIOSK_SCREEN_TIMEOUTS[number])) {
    fail("VALIDATION_FAILED", `screenTimeout must be one of: ${KIOSK_SCREEN_TIMEOUTS.join(", ")}`);
  }

  const allowStatusBar = input.allowStatusBar ?? false;
  // Zoho rule: expansion defaults to false whenever the status bar is restricted.
  const allowStatusBarExpansion = input.allowStatusBarExpansion ?? (allowStatusBar ? true : false);
  const allowPowerButton = input.allowPowerButton ?? true;

  // Field names below are the ones fully legible in the guide's ANDROID_KIOSK_POLICY table.
  return {
    kiosk_mode: input.mode === "single" ? 0 : 1, // 0 single app, 1 multi app
    allowed_apps: JSON.stringify(allowed), // the API expects a JSON string
    launcher_type: launcherType,
    screen_orientation: screenOrientation,
    screen_timeout: screenTimeout,
    allow_status_bar: allowStatusBar,
    allow_status_bar_expansion: allowStatusBarExpansion,
    allow_home_button: input.allowHomeButton ?? true,
    allow_back_button: input.allowBackButton ?? true,
    allow_power_button: allowPowerButton,
    // Zoho's spec: allow_shutdown defaults to the value of allow_power_button.
    allow_shutdown: input.allowShutdown ?? allowPowerButton,
    allow_volume_button: input.allowVolumeButton ?? true,
    allow_key_guard: input.allowKeyGuard ?? true,
    allow_notification: input.allowNotification ?? true,
    allow_recent_apps: input.allowRecentApps ?? true,
    allow_task_manager: input.allowTaskManager ?? true,
    allow_system_error_dialog: input.allowSystemErrorDialog ?? false,
    allow_custom_settings: input.allowCustomSettings ?? true,
    show_me_mdm_app: input.showMeMdmApp ?? true,
    ...(input.extra ?? {}),
  };
}

/**
 * ANDROID_PASSCODE_POLICY. Pushes a POLICY — Android will prompt the user to
 * create/update their passcode on the next unlock after `grace_period` minutes.
 * To actually set a passcode value on devices, use the reset_passcode command.
 */
export function buildPasscodePayload(input: {
  passcodeType?: number; // 1 pattern, 2 numbers, 3 alphabets, 4 alphanumeric, 5 complex
  minLength?: number;
  maxFailedAttempts?: number; // -1 = never wipe; 4..16 = wipe after N failures
  autoLockSeconds?: number;
  maxAgeDays?: number;
  history?: number;
  scope?: number; // scope_for_passcode: 0 device-wide, 1 work profile (guide: only these two)
  gracePeriodMinutes?: number; // minutes before the policy becomes enforced
  allowFingerprint?: number; // 0 restrict / 1 allow
  allowFaceUnlock?: boolean;
  allowIrisScan?: boolean;
  allowOneLock?: boolean; // prevent same passcode on device + work profile
}) {
  const p = {
    scope_for_passcode: input.scope ?? 0,
    passcode_type: input.passcodeType ?? 2,
    min_passcode_length: input.minLength ?? 6,
    max_failed_attempts: input.maxFailedAttempts ?? 10,
    auto_lock_idle_for: input.autoLockSeconds ?? 300,
    max_passcode_age: input.maxAgeDays ?? 0,
    no_of_passcode_maintained: input.history ?? 3,
    grace_period: input.gracePeriodMinutes ?? 60,
    allow_fingerprint: input.allowFingerprint ?? 1,
    allow_face_unlock: input.allowFaceUnlock ?? true,
    allow_iris_scan: input.allowIrisScan ?? true,
    allow_one_lock: input.allowOneLock ?? true,
  };
  if (![0, 1].includes(p.scope_for_passcode)) fail("VALIDATION_FAILED", "scope must be 0 (device) or 1 (work profile)");
  if (![1, 2, 3, 4, 5].includes(p.passcode_type)) fail("VALIDATION_FAILED", "passcodeType must be 1–5");
  if (p.min_passcode_length !== -1 && (p.min_passcode_length < 4 || p.min_passcode_length > 16)) {
    fail("VALIDATION_FAILED", "minLength must be -1 (none) or 4–16");
  }
  if (p.max_failed_attempts !== -1 && (p.max_failed_attempts < 4 || p.max_failed_attempts > 16)) {
    fail("VALIDATION_FAILED", "maxFailedAttempts must be -1 or 4–16");
  }
  if (p.auto_lock_idle_for < 5 || p.auto_lock_idle_for > 1800) fail("VALIDATION_FAILED", "autoLockSeconds must be 5–1800");
  if (p.grace_period < 1 || p.grace_period > 1000) fail("VALIDATION_FAILED", "gracePeriodMinutes must be 1–1000");
  if (p.max_passcode_age < 0 || p.max_passcode_age > 1000) fail("VALIDATION_FAILED", "maxAgeDays must be 0–1000");
  if (p.no_of_passcode_maintained < 0 || p.no_of_passcode_maintained > 100) fail("VALIDATION_FAILED", "history must be 0–100");
  if (![0, 1].includes(p.allow_fingerprint)) fail("VALIDATION_FAILED", "allowFingerprint must be 0 or 1");
  return p;
}

/**
 * iOS PASSCODE_POLICY (payload "passcodepolicy"). Ranges from the guide's iOS table.
 * max_failed_attempts: the iPhone ERASES itself after this many wrong passcodes (3–9).
 */
export const IOS_AUTO_LOCK_MINUTES = [1, 2, 3, 4, 5, 10, 15] as const;
export function buildIosPasscodePayload(input: {
  allowSimple?: boolean; // allow 1234 / 1111-style passcodes
  requireAlphanumeric?: boolean;
  minLength?: number; // 1–16
  minComplexChars?: number; // 1–4 special characters
  autoLockMinutes?: number; // one of IOS_AUTO_LOCK_MINUTES
  maxAgeDays?: number; // 1–170
  history?: number; // 1–50 previous passcodes that can't be reused
  gracePeriodMinutes?: number; // 0–240 minutes before the passcode is asked again
  maxFailedAttempts?: number; // 3–9, then the device is erased
}) {
  const p: Record<string, number | boolean> = {
    allow_simple_value: input.allowSimple ?? false,
    require_alphanumeric: input.requireAlphanumeric ?? false,
    min_passcode_length: input.minLength ?? 6,
  };
  const range = (key: string, v: number | undefined, min: number, max: number) => {
    if (v === undefined || v === null) return;
    if (!Number.isInteger(v) || v < min || v > max) fail("VALIDATION_FAILED", `${key} must be ${min}–${max}`);
    p[key] = v;
  };
  range("min_passcode_length", input.minLength ?? 6, 1, 16);
  range("min_complex_chars", input.minComplexChars, 1, 4);
  range("max_passcode_age", input.maxAgeDays, 1, 170);
  range("no_of_passcode_maintained", input.history, 1, 50);
  range("max_grace_period", input.gracePeriodMinutes, 0, 240);
  range("max_failed_attempts", input.maxFailedAttempts, 3, 9);
  if (input.autoLockMinutes !== undefined) {
    if (!IOS_AUTO_LOCK_MINUTES.includes(input.autoLockMinutes as typeof IOS_AUTO_LOCK_MINUTES[number])) {
      fail("VALIDATION_FAILED", `autoLockMinutes must be one of ${IOS_AUTO_LOCK_MINUTES.join(", ")}`);
    }
    p.auto_lock_idle_for = input.autoLockMinutes;
  }
  return p;
}

/** Enterprise Factory Reset Protection: only these Google accounts can set up a reset device. */
export function buildFrpPayload(accounts: { emailUserId: string; email: string }[]) {
  if (!accounts.length) fail("VALIDATION_FAILED", "Add at least one FRP Google account");
  return {
    efrp_details: JSON.stringify(accounts.map((a) => ({ EMAIL_USER_ID: a.emailUserId, EMAIL_ID: a.email }))),
  };
}

// --------------------------------------------------------------- iOS kiosk
/** One entry in `allowed_apps` / `autonomous_kiosk_apps` per the applockpolicy guide table.
 *  app_id is Zoho's numeric app_id from /apps (NOT a bundle identifier).
 *  Bundle-id-only sources (common-apps catalog, installed-apps scan) can't be used here —
 *  the app has to be uploaded to the Zoho app repo first so it has an app_id. */
export type IosKioskApp = { appId: string | number; isSystemApp?: boolean; displayName?: string };

/**
 * iOS kiosk (`applockpolicy`, supervised only). Field names and structure verbatim
 * from MDM_Dev_Guide.pdf line 14237, APPLOCK_POLICY table.
 */
export function buildIosKioskPayload(input: {
  mode: "single" | "multi";
  apps: IosKioskApp[];
  disableTouch?: boolean;
  disableDeviceRotation?: boolean;
  disableVolumeButtons?: boolean;
  disableRingerSwitch?: boolean;
  disableSleepButton?: boolean;
  disableAutoLock?: boolean;
  voiceOver?: boolean;
  zoom?: boolean;
  invertColors?: boolean;
  asstTouch?: boolean;
  enableSpeakSelection?: boolean;
  enableMonoAudio?: boolean;
}) {
  if (!input.apps.length) fail("VALIDATION_FAILED", "iOS kiosk needs at least one app");
  if (input.mode === "single" && input.apps.length !== 1) fail("VALIDATION_FAILED", "Single-app kiosk takes exactly one app");
  for (const a of input.apps) {
    if (!a.appId || !/^\d+$/.test(String(a.appId))) {
      fail("VALIDATION_FAILED", `iOS kiosk needs the numeric app_id from the Zoho app repo. '${a.appId}' isn't one. Upload the app to Zoho first.`);
    }
  }
  const appsJson = JSON.stringify(input.apps.map((a) => ({
    app_id: Number(a.appId),
    is_system_app: a.isSystemApp ?? false,
    group_display_name: a.displayName ?? String(a.appId),
  })));
  // Guide: kiosk_mode is 1 (single) or 2 (multi).
  const base: Record<string, unknown> = {
    kiosk_mode: input.mode === "single" ? 1 : 2,
    disable_auto_lock: input.disableAutoLock ?? true,
  };
  if (input.mode === "single") {
    // Guide: all the toggle fields below are "Applicable only for kiosk_mode 1".
    base.allowed_apps = appsJson;
    base.disable_touch = input.disableTouch ?? false;
    base.disable_device_rotation = input.disableDeviceRotation ?? false;
    base.disable_volume_buttons = input.disableVolumeButtons ?? false;
    base.disable_ringer_switch = input.disableRingerSwitch ?? false;
    base.disable_sleep_button = input.disableSleepButton ?? false;
    base.voice_over = input.voiceOver ?? false;
    base.zoom = input.zoom ?? false;
    base.invert_colors = input.invertColors ?? false;
    base.asst_touch = input.asstTouch ?? false;
    base.enable_speak_selection = input.enableSpeakSelection ?? false;
    base.enable_mono_audio = input.enableMonoAudio ?? false;
  } else {
    base.autonomous_kiosk_apps = appsJson;
  }
  return base;
}

// ---------------------------------------------------------------- iOS Wi-Fi
const IOS_WIFI_ENCRYPTIONS = ["WEP", "WPA", "WPA2", "Any", "None"] as const;
export function buildIosWifiPayload(input: {
  ssid: string;
  encryption?: typeof IOS_WIFI_ENCRYPTIONS[number];
  password?: string;
  hiddenNetwork?: boolean;
  autoJoin?: boolean;
  proxyType?: "None" | "Manual" | "Auto";
  proxyServer?: string;
  proxyPort?: number;
  proxyUser?: string;
  proxyPassword?: string;
}) {
  if (!input.ssid || !input.ssid.trim()) fail("VALIDATION_FAILED", "Wi-Fi SSID is required");
  const enc = input.encryption ?? "WPA2";
  if (!IOS_WIFI_ENCRYPTIONS.includes(enc)) fail("VALIDATION_FAILED", `encryption must be one of ${IOS_WIFI_ENCRYPTIONS.join(", ")}`);
  if (enc !== "None" && !input.password) fail("VALIDATION_FAILED", "Password is required for encrypted Wi-Fi");
  const p: Record<string, unknown> = {
    ssid_str: input.ssid.trim(),
    encryption_type: enc,
    hidden_network: input.hiddenNetwork ?? false,
    auto_join: input.autoJoin ?? true,
  };
  if (enc !== "None") p.password = input.password;
  if (input.proxyType && input.proxyType !== "None") {
    p.proxy_type = input.proxyType;
    if (input.proxyType === "Manual") {
      if (!input.proxyServer) fail("VALIDATION_FAILED", "Proxy server is required for Manual proxy");
      if (!input.proxyPort || input.proxyPort < 1 || input.proxyPort > 65535) fail("VALIDATION_FAILED", "Proxy port must be 1–65535");
      p.proxy_server = input.proxyServer;
      p.proxy_server_port = input.proxyPort;
      if (input.proxyUser) p.proxy_username = input.proxyUser;
      if (input.proxyPassword) p.proxy_password = input.proxyPassword;
    }
  }
  return p;
}

// -------------------------------------------------- iOS Web content filter
/**
 * iOS Web Content Filter (`webcontentfilterpolicy`, supervised only).
 * Two modes: allow-only (specific sites) vs block-all-adult + optional allowlist.
 */
export function buildIosWebFilterPayload(input: {
  mode: "allow-only" | "limit-adult";
  allowedUrls?: { title: string; url: string }[]; // bookmarks shown
  permittedUrls?: string[]; // only these allowed (allow-only mode)
  blacklistedUrls?: string[]; // explicitly denied
}) {
  const urlOk = (u: string) => /^https?:\/\/[^\s]+$/i.test(u);
  if (input.mode === "allow-only") {
    const urls = (input.permittedUrls ?? []).filter(Boolean);
    if (!urls.length) fail("VALIDATION_FAILED", "Allow-only mode needs at least one permitted URL");
    for (const u of urls) if (!urlOk(u)) fail("VALIDATION_FAILED", `Invalid URL ${u}`);
    const bookmarks = (input.allowedUrls ?? []).map((b) => {
      if (!urlOk(b.url)) fail("VALIDATION_FAILED", `Invalid bookmark URL ${b.url}`);
      return { title: b.title.trim() || b.url, url: b.url };
    });
    return {
      filter_type: "allow-only",
      permitted_urls: JSON.stringify(urls),
      bookmarks: JSON.stringify(bookmarks),
    };
  }
  const black = (input.blacklistedUrls ?? []).filter(Boolean);
  for (const u of black) if (!urlOk(u)) fail("VALIDATION_FAILED", `Invalid URL ${u}`);
  const extra = (input.allowedUrls ?? []).map((b) => {
    if (!urlOk(b.url)) fail("VALIDATION_FAILED", `Invalid bookmark URL ${b.url}`);
    return { title: b.title.trim() || b.url, url: b.url };
  });
  return {
    filter_type: "limit-adult-content",
    blacklisted_urls: JSON.stringify(black),
    permitted_urls: JSON.stringify(extra),
  };
}

// ------------------------------------------------------------------ iOS VPN
const IOS_VPN_TYPES = ["L2TP", "PPTP", "IPSec", "IKEv2", "AlwaysOn"] as const;
const IOS_VPN_AUTH = ["Password", "RSA", "Certificate"] as const;
export function buildIosVpnPayload(input: {
  connectionName: string;
  type?: typeof IOS_VPN_TYPES[number];
  server: string;
  account?: string;
  password?: string;
  sharedSecret?: string;
  authentication?: typeof IOS_VPN_AUTH[number];
  sendAllTraffic?: boolean;
  disconnectOnIdle?: boolean;
  proxyServer?: string;
  proxyPort?: number;
}) {
  if (!input.connectionName?.trim()) fail("VALIDATION_FAILED", "VPN connection name is required");
  if (!input.server?.trim()) fail("VALIDATION_FAILED", "VPN server is required");
  const type = input.type ?? "IKEv2";
  if (!IOS_VPN_TYPES.includes(type)) fail("VALIDATION_FAILED", `type must be one of ${IOS_VPN_TYPES.join(", ")}`);
  const auth = input.authentication ?? "Password";
  if (!IOS_VPN_AUTH.includes(auth)) fail("VALIDATION_FAILED", `authentication must be one of ${IOS_VPN_AUTH.join(", ")}`);
  const p: Record<string, unknown> = {
    connection_name: input.connectionName.trim(),
    connection_type: type,
    server: input.server.trim(),
    user_authentication: auth,
    send_all_traffic: input.sendAllTraffic ?? false,
    disconnect_on_idle: input.disconnectOnIdle ?? false,
  };
  if (input.account) p.account = input.account;
  if (input.password) p.password = input.password;
  if (input.sharedSecret) p.shared_secret = input.sharedSecret;
  if (input.proxyServer) {
    if (!input.proxyPort || input.proxyPort < 1 || input.proxyPort > 65535) fail("VALIDATION_FAILED", "Proxy port must be 1–65535");
    p.proxy_server = input.proxyServer;
    p.proxy_server_port = input.proxyPort;
  }
  return p;
}

// ---------------------------------------------------------------- iOS Email
const IOS_EMAIL_PROTOCOLS = ["IMAP", "POP"] as const;
export function buildIosEmailPayload(input: {
  accountDescription: string;
  accountType?: typeof IOS_EMAIL_PROTOCOLS[number];
  userDisplayName?: string;
  emailAddress: string;
  incomingMailServer: string;
  incomingMailPort?: number;
  incomingUseSsl?: boolean;
  incomingAuthentication?: "Password" | "None";
  incomingUsername?: string;
  outgoingMailServer: string;
  outgoingMailPort?: number;
  outgoingUseSsl?: boolean;
  outgoingAuthentication?: "Password" | "None";
  outgoingUsername?: string;
  preventMove?: boolean;
  preventAppSheet?: boolean;
  disableMailDrop?: boolean;
}) {
  const req = ["accountDescription", "emailAddress", "incomingMailServer", "outgoingMailServer"] as const;
  for (const k of req) if (!String((input as Record<string, unknown>)[k] ?? "").trim()) fail("VALIDATION_FAILED", `${k} is required`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.emailAddress)) fail("VALIDATION_FAILED", "emailAddress is not valid");
  const type = input.accountType ?? "IMAP";
  if (!IOS_EMAIL_PROTOCOLS.includes(type)) fail("VALIDATION_FAILED", `accountType must be IMAP or POP`);
  return {
    email_account_description: input.accountDescription.trim(),
    email_account_type: `EmailType${type}`,
    user_display_name: input.userDisplayName ?? input.emailAddress,
    email_address: input.emailAddress.trim(),
    incoming_mail_server_hostname: input.incomingMailServer.trim(),
    incoming_mail_server_port: input.incomingMailPort ?? (type === "IMAP" ? 993 : 995),
    incoming_mail_server_use_ssl: input.incomingUseSsl ?? true,
    incoming_mail_server_authentication: `EmailAuth${input.incomingAuthentication ?? "Password"}`,
    incoming_mail_server_username: input.incomingUsername ?? input.emailAddress,
    outgoing_mail_server_hostname: input.outgoingMailServer.trim(),
    outgoing_mail_server_port: input.outgoingMailPort ?? 587,
    outgoing_mail_server_use_ssl: input.outgoingUseSsl ?? true,
    outgoing_mail_server_authentication: `EmailAuth${input.outgoingAuthentication ?? "Password"}`,
    outgoing_mail_server_username: input.outgoingUsername ?? input.emailAddress,
    prevent_move: input.preventMove ?? false,
    prevent_app_sheet: input.preventAppSheet ?? false,
    disable_mail_recents_syncing: input.disableMailDrop ?? false,
  };
}

// ------------------------------------------------------- iOS Global HTTP Proxy
export function buildIosProxyPayload(input: {
  proxyType: "manual" | "auto";
  server?: string;
  port?: number;
  username?: string;
  password?: string;
  pacUrl?: string;
  allowBypass?: boolean;
}) {
  if (input.proxyType === "manual") {
    if (!input.server?.trim()) fail("VALIDATION_FAILED", "Proxy server is required");
    if (!input.port || input.port < 1 || input.port > 65535) fail("VALIDATION_FAILED", "Proxy port must be 1–65535");
    const p: Record<string, unknown> = {
      proxy_type: "manual",
      proxy_server: input.server.trim(),
      proxy_server_port: input.port,
      allow_bypass: input.allowBypass ?? false,
    };
    if (input.username) p.proxy_username = input.username;
    if (input.password) p.proxy_password = input.password;
    return p;
  }
  if (!input.pacUrl?.trim() || !/^https?:\/\//i.test(input.pacUrl)) fail("VALIDATION_FAILED", "PAC URL must be an http(s) URL");
  return {
    proxy_type: "auto",
    proxy_pac_url: input.pacUrl.trim(),
    allow_bypass: input.allowBypass ?? true,
  };
}

export function payloadNameFor(platform: "android" | "ios", purpose: Purpose): string | null {
  if (purpose === "custom") return null;
  if (purpose === "apps") return APP_PROFILE_PAYLOAD;
  if (purpose === "app_blacklist") return APP_BLACKLIST_PAYLOAD;
  const table = PAYLOAD[platform] as Record<string, string>;
  return table[purpose] ?? null;
}
