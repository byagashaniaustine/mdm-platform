import { del, get, post, uploadFile } from "../api.js";
import { COMMON_ANDROID_APPS, COMMON_IOS_APPS } from "../common-apps.js";
import { ago, badge, clear, emptyState, field, h, icon, input, loading, modal, pageHeader, responsive, select, toast, toastError, toastEvent } from "../ui.js";

let catalogCache = null;

export async function profilesView(el, ctx) {
  clear(el, loading());
  const mountToken = Symbol("profiles-view");
  el.__viewToken = mountToken;
  const catalog = await (catalogCache ??= get("/api/profiles/catalog"));
  const admin = ctx.can("admin");
  const newBtn = admin ? h("button", { class: "btn btn-primary", type: "button", onclick: () => profileWizard(el, ctx, catalog) }, icon("plus"), "New profile") : null;

  const render = (profiles) => clear(
    el,
    pageHeader("Profiles", "One purpose per profile: restrictions, kiosk, passcode or factory-reset protection. Create it, publish it, then assign it to groups.", [newBtn]),
    profiles.length
      ? h("section", { class: "card card-flush" }, h("div", { class: "table-wrap" }, responsive(h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Purpose"), h("th", {}, "State"), h("th", {}, "Groups"), h("th", {}, "Updated"), h("th", {}, ""))),
        h("tbody", {}, profiles.map((p) =>
          h("tr", {},
            h("td", {}, h("strong", {}, p.name), p.description ? h("div", { class: "muted" }, p.description) : null),
            h("td", {}, p.purpose, h("div", { class: "muted small" }, (p.payload_names ?? []).join(", "))),
            h("td", {}, badge(p.state)),
            h("td", {}, (p.profile_groups ?? []).map((pg) => badge(pg.groups?.name ?? "", "muted"))),
            h("td", { class: "muted" }, ago(p.updated_at)),
            h("td", { class: "actions" },
              h("button", { class: "btn btn-sm", type: "button", onclick: () => viewProfile(ctx, catalog, p.id) }, "View"),
              admin && p.state !== "published" ? h("button", {
                class: "btn btn-sm btn-primary",
                type: "button",
                disabled: !(p.payload_names ?? []).length || undefined,
                title: !(p.payload_names ?? []).length ? "Add a policy first — this draft has no payloads attached." : "",
                onclick: async () => {
                  try {
                    toastEvent(await post(`/api/profiles/${p.id}/publish`, {}), "Published");
                    profilesView(el, ctx);
                  } catch (err) { toastError(err); }
                },
              }, p.state === "modified" ? "Re-publish" : "Publish") : null,
              admin ? h("button", { class: "btn btn-sm", type: "button", onclick: () => profileWizard(el, ctx, catalog, p) }, "Add policy") : null,
              ctx.can("owner") ? h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => modal("Delete profile?", h("p", {}, `Delete "${p.name}"? It is removed from all groups and hidden from this view immediately.`), [
                { label: "Cancel" },
                { label: "Delete", tone: "danger", onClick: async () => {
                  toastEvent(await del(`/api/profiles/${p.id}`), "Profile deleted");
                  profilesView(el, ctx);
                } },
              ]) }, "Delete") : null,
            ),
          )
        )),
      ))))
      : emptyState("No profiles yet", "Start with a Baseline – Security profile: restrictions + passcode.", newBtn),
  );

  const fetchAndRender = async () => { try { render(await get("/api/profiles")); } catch (_) {} };
  await fetchAndRender();
  const timer = setInterval(() => {
    if (el.__viewToken !== mountToken) { clearInterval(timer); return; }
    if (document.hidden) return;
    fetchAndRender();
  }, 10_000);
}

/** Create a profile, or add a policy to an existing one (when `existing` is passed). */
function profileWizard(el, ctx, catalog, existing) {
  const name = input({ maxlength: 100, required: true, placeholder: "Baseline – Security", value: existing?.name ?? "" });
  const desc = input({ maxlength: 300 });
  const platform = select([{ value: "android", label: "Android" }, { value: "ios", label: "Apple (iPhone / iPad)" }]);
  if (existing?.platform) platform.value = existing.platform;
  const plat = () => platform.value;
  const purpose = select([]);
  // Only offer policies the chosen platform supports (Apple: restrictions, passcode, custom).
  const fillPurposes = () => {
    const keep = purpose.value;
    purpose.replaceChildren(...catalog.purposes
      .filter((p) => !p.platforms || p.platforms.includes(plat()))
      .map((p) => h("option", { value: p.id }, p.label)));
    if ([...purpose.options].some((o) => o.value === keep)) purpose.value = keep;
  };
  fillPurposes();
  platform.addEventListener("change", () => {
    fillPurposes();
    renderForm();
  });
  const formBox = h("div", { class: "stack" });
  let collect = () => ({});

  const renderForm = () => {
    const kind = purpose.value;
    if (kind === "passcode" && plat() === "ios") {
      renderIosPasscode();
    } else if (kind === "kiosk" && plat() === "ios") {
      renderIosKiosk();
    } else if (kind === "wifi" && plat() === "ios") {
      renderIosWifi();
    } else if (kind === "webfilter" && plat() === "ios") {
      renderIosWebFilter();
    } else if (kind === "vpn" && plat() === "ios") {
      renderIosVpn();
    } else if (kind === "email" && plat() === "ios") {
      renderIosEmail();
    } else if (kind === "proxy" && plat() === "ios") {
      renderIosProxy();
    } else if (kind === "lockscreen_message" && plat() === "ios") {
      renderIosLockscreenMessage();
    } else if (kind === "wallpaper") {
      renderWallpaper();
    } else if (kind === "restrictions") {
      const restrictionList = plat() === "ios" ? catalog.ios.restrictions : catalog.restrictions;
      // Per restriction kind: binary / enum use <select>, integer uses <input type=number>,
      // boolean uses a tri-state <select> (not managed / on / off) so admins can still skip it.
      const choices = {};
      const read = {};
      const apply = {};
      const rowFor = (r) => {
        let control;
        if (r.kind === "boolean") {
          const s = select([{ value: "", label: "Not managed" }, { value: "true", label: "On" }, { value: "false", label: "Off" }], { "aria-label": r.label });
          control = s;
          read[r.key] = () => s.value === "" ? undefined : s.value === "true";
          apply[r.key] = (v) => { s.value = v === undefined ? "" : (v ? "true" : "false"); };
        } else if (r.kind === "integer") {
          const inp = input({ type: "number", min: r.min, max: r.max, placeholder: `${r.min}–${r.max}` });
          control = inp;
          read[r.key] = () => inp.value === "" ? undefined : Number(inp.value);
          apply[r.key] = (v) => { inp.value = v === undefined ? "" : String(v); };
        } else if (r.kind === "enum") {
          const opts = [{ value: "", label: "Not managed" }, ...r.options.map((o) => ({ value: String(o.value), label: o.label }))];
          const s = select(opts, { "aria-label": r.label });
          control = s;
          read[r.key] = () => {
            if (s.value === "") return undefined;
            const match = r.options.find((o) => String(o.value) === s.value);
            return match ? match.value : s.value;
          };
          apply[r.key] = (v) => { s.value = v === undefined ? "" : String(v); };
        } else {
          const s = select([{ value: "", label: "Not managed" }, { value: "allow", label: "Allow" }, { value: "restrict", label: "Restrict" }], { "aria-label": r.label });
          control = s;
          read[r.key] = () => s.value || undefined;
          apply[r.key] = (v) => { s.value = v ?? ""; };
        }
        choices[r.key] = control;
        const unit = r.kind === "integer" && r.unit ? h("span", { class: "muted small" }, ` ${r.unit}`) : null;
        const hint = r.hint ? h("div", { class: "muted small" }, r.hint) : null;
        const sup = r.supervised ? [" ", badge("supervised only", "muted")] : null;
        return h("div", { class: "restriction" },
          h("span", {}, r.label, sup, hint),
          h("span", {}, control, unit),
        );
      };
      // Group rows by category so the long list stays navigable.
      const byCat = restrictionList.reduce((acc, r) => {
        (acc[r.category] ??= []).push(r);
        return acc;
      }, {});
      const sections = Object.entries(byCat).map(([cat, defs]) =>
        h("div", { class: "stack" }, h("h4", { class: "section-head" }, cat), h("div", { class: "restrictions" }, defs.map(rowFor))),
      );
      const preset = h("button", { class: "btn btn-sm", type: "button", onclick: () => {
        for (const r of restrictionList) if (r.recommended !== undefined) apply[r.key](r.recommended);
        toast("Recommended corporate baseline applied", "info");
      } }, "Use recommended baseline");
      clear(formBox,
        h("div", { class: "row" }, h("h3", {}, "Restrictions"), preset),
        plat() === "ios" ? h("p", { class: "muted small" }, "Items marked \u201csupervised only\u201d are ignored by Apple on iPhones that weren\u2019t enrolled through Apple Business Manager.") : null,
        ...sections);
      collect = () => {
        const restrictions = {};
        for (const [k, get] of Object.entries(read)) {
          const v = get();
          if (v !== undefined) restrictions[k] = v;
        }
        return { restrictions };
      };
    } else if (kind === "kiosk") {
      const mode = select([{ value: "single", label: "Single app" }, { value: "multi", label: "Multiple apps" }]);
      const appsBox = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading apps from Zoho…"));
      // Each pick: Zoho-repo entry (cb + pkg) or manual entry (name + pkg, always on).
      const picks = [];
      let nextManualId = 1;

      const manualRow = () => {
        const id = `manual-${Date.now()}-${nextManualId++}`;
        const name = input({ placeholder: "App display name" });
        const pkg = input({ placeholder: "package name, e.g. com.acme.pos" });
        const row = h("div", { class: "kiosk-app" },
          h("span", {}, "✱ manual"),
          name,
          pkg,
          h("button", { class: "btn btn-xs", type: "button", onclick: () => { picks.splice(picks.findIndex((p) => p.a.app_id === id), 1); row.remove(); } }, "Remove"),
        );
        picks.push({ a: { app_id: id, app_name: null }, cb: { checked: true }, pkg, name, manual: true });
        return row;
      };

      const addManual = h("button", { class: "btn btn-sm", type: "button", onclick: () => appsBox.appendChild(manualRow()) }, "+ Add app by package name");

      const renderRepoRows = (apps) => apps.map((a) => {
        const cb = h("input", { type: "checkbox" });
        const pkg = input({ placeholder: "package name, e.g. com.acme.pos", value: a.bundle_identifier ?? a.identifier ?? "" });
        picks.push({ a, cb, pkg, manual: false });
        return h("div", { class: "kiosk-app" }, h("label", { class: "pick" }, cb, h("span", {}, a.app_name)), pkg);
      });
      const renderInstalledRows = (apps) => apps.map((a) => {
        const cb = h("input", { type: "checkbox" });
        const pkg = input({ placeholder: "package name", value: a.identifier ?? "" });
        picks.push({ a: { app_id: `installed-${a.identifier}`, app_name: a.app_name }, cb, pkg, manual: false });
        return h("div", { class: "kiosk-app" },
          h("label", { class: "pick" }, cb, h("span", {}, a.app_name, h("span", { class: "muted small" }, ` · on ${a.devices} device${a.devices === 1 ? "" : "s"}`))),
          pkg,
        );
      });
      const renderCommonRows = (apps) => apps.map((a) => {
        const cb = h("input", { type: "checkbox" });
        const pkg = input({ placeholder: "package name", value: a.identifier });
        picks.push({ a: { app_id: `common-${a.identifier}`, app_name: a.app_name }, cb, pkg, manual: false });
        return h("div", { class: "kiosk-app" }, h("label", { class: "pick" }, cb, h("span", {}, a.app_name)), pkg);
      });
      const commonSection = () => h("div", { class: "stack" },
        h("h4", { class: "section-head" }, "common apps"),
        ...renderCommonRows(COMMON_ANDROID_APPS),
      );

      get("/api/apps").then(async (apps) => {
        const android = apps.filter((a) => Number(a.platform_type) === 2 || a.platform_type === undefined);
        if (android.length) {
          clear(appsBox, ...renderRepoRows(android), commonSection(), addManual);
          return;
        }
        clear(appsBox, h("p", { class: "muted" }, "Zoho app repo is empty. Scanning enrolled devices…"));
        try {
          const installed = await get("/api/apps/installed?platform=2");
          if (installed?.length) {
            clear(appsBox,
              h("p", { class: "muted small" }, "Showing apps installed on your enrolled Android devices."),
              ...renderInstalledRows(installed),
              commonSection(),
              addManual,
            );
          } else {
            clear(appsBox,
              h("p", { class: "muted small" }, "Zoho's app repo is empty and no installed apps were reported from enrolled devices. Pick from the common apps below, or add a package manually."),
              commonSection(),
              addManual,
            );
          }
        } catch (err) {
          clear(appsBox,
            h("p", { class: "muted small" }, "Could not scan enrolled devices. Pick from the common apps below, or add a package manually."),
            commonSection(),
            addManual,
          );
          toastError(err);
        }
      }).catch((err) => {
        clear(appsBox,
          h("p", { class: "muted" }, "Could not load apps from Zoho. Pick from the common apps below, or add a package manually."),
          commonSection(),
          addManual,
        );
        toastError(err);
      });

      // Hardware buttons — Zoho defaults all true; most kiosk deployments restrict most.
      const statusBar = h("input", { type: "checkbox" });
      const statusBarExpansion = h("input", { type: "checkbox" });
      const homeButton = h("input", { type: "checkbox", checked: true });
      const backButton = h("input", { type: "checkbox", checked: true });
      const powerButton = h("input", { type: "checkbox", checked: true });
      const shutdown = h("input", { type: "checkbox", checked: true });
      const keyGuard = h("input", { type: "checkbox", checked: true });
      // UI chrome
      const notification = h("input", { type: "checkbox", checked: true });
      const recentApps = h("input", { type: "checkbox", checked: true });
      const taskManager = h("input", { type: "checkbox", checked: true });
      const systemError = h("input", { type: "checkbox" });
      const customSettings = h("input", { type: "checkbox", checked: true });
      const mdmApp = h("input", { type: "checkbox", checked: true });
      // Launcher / display
      const launcher = select([{ value: "2", label: "MDM launcher" }, { value: "1", label: "Default device launcher" }]);
      const orientation = select([{ value: "2", label: "User controlled" }, { value: "1", label: "Auto rotate" }, { value: "3", label: "Portrait" }, { value: "4", label: "Landscape" }]);
      const timeout = select([
        { value: "0", label: "User controlled" }, { value: "15", label: "15 seconds" }, { value: "30", label: "30 seconds" }, { value: "60", label: "1 minute" },
        { value: "300", label: "5 minutes" }, { value: "1800", label: "30 minutes" }, { value: "2147483647", label: "Always on" },
      ]);

      const checkbox = (el, label) => h("label", { class: "pick" }, el, h("span", {}, label));

      const lockdown = h("button", { class: "btn btn-sm", type: "button", onclick: () => {
        // Classic kiosk lockdown: hide every button + chrome, keep power + volume.
        statusBar.checked = false; statusBarExpansion.checked = false;
        homeButton.checked = false; backButton.checked = false;
        powerButton.checked = true; shutdown.checked = false; keyGuard.checked = false;
        notification.checked = false; recentApps.checked = false; taskManager.checked = false;
        systemError.checked = false; customSettings.checked = false; mdmApp.checked = false;
        launcher.value = "2"; orientation.value = "2"; timeout.value = "2147483647";
        toast("Lockdown preset applied", "info");
      } }, "Use lockdown preset");

      clear(formBox,
        field("Mode", mode),
        h("h3", {}, "Apps"),
        appsBox,
        h("div", { class: "row" }, h("h3", {}, "Device behavior"), lockdown),
        h("h4", { class: "section-head" }, "launcher"),
        field("Launcher", launcher),
        field("Screen orientation", orientation),
        field("Screen timeout", timeout),
        h("h4", { class: "section-head" }, "hardware buttons"),
        h("div", { class: "restrictions" },
          checkbox(statusBar, "Allow status bar"),
          checkbox(statusBarExpansion, "Allow pulling status bar down for quick settings"),
          checkbox(homeButton, "Allow home button"),
          checkbox(backButton, "Allow back button"),
          checkbox(powerButton, "Allow power button"),
          checkbox(shutdown, "Allow shutdown"),
          checkbox(keyGuard, "Allow unlock without passcode (key guard)"),
        ),
        h("h4", { class: "section-head" }, "ui chrome"),
        h("div", { class: "restrictions" },
          checkbox(notification, "Allow notifications"),
          checkbox(recentApps, "Allow recent apps switcher"),
          checkbox(taskManager, "Allow task manager"),
          checkbox(systemError, "Show app crash dialogs"),
          checkbox(customSettings, "Allow MDM custom settings app"),
          checkbox(mdmApp, "Show ME MDM app on home screen"),
        ),
      );

      collect = () => {
        // Dedup by packageName so the same bundle picked in two sections (installed + common) → one entry.
        const seenPkg = new Set();
        const apps = [];
        for (const p of picks) {
          if (!p.cb.checked) continue;
          const pkg = p.pkg.value.trim();
          if (!pkg || seenPkg.has(pkg)) continue;
          seenPkg.add(pkg);
          apps.push({
            appId: String(p.a.app_id),
            packageName: pkg,
            name: p.manual ? (p.name.value.trim() || pkg) : p.a.app_name,
          });
        }
        return ({
        mode: mode.value,
        apps,
        allowStatusBar: statusBar.checked,
        allowStatusBarExpansion: statusBarExpansion.checked,
        allowHomeButton: homeButton.checked,
        allowBackButton: backButton.checked,
        allowPowerButton: powerButton.checked,
        allowShutdown: shutdown.checked,
        allowKeyGuard: keyGuard.checked,
        allowNotification: notification.checked,
        allowRecentApps: recentApps.checked,
        allowTaskManager: taskManager.checked,
        allowSystemErrorDialog: systemError.checked,
        allowCustomSettings: customSettings.checked,
        showMeMdmApp: mdmApp.checked,
        launcherType: Number(launcher.value),
        screenOrientation: Number(orientation.value),
        screenTimeout: Number(timeout.value),
      });
      };
    } else if (kind === "passcode") {
      const type = select([{ value: "2", label: "Numbers" }, { value: "4", label: "Alphanumeric" }, { value: "5", label: "Complex" }]);
      const len = input({ type: "number", min: 4, max: 16, value: 6 });
      const wipe = input({ type: "number", min: -1, max: 16, value: 10 });
      const lock = input({ type: "number", min: 5, max: 1800, value: 300 });
      const grace = input({ type: "number", min: 1, max: 1000, value: 60 });
      const fingerprint = h("input", { type: "checkbox", checked: true });
      const faceUnlock = h("input", { type: "checkbox", checked: true });
      clear(formBox,
        h("p", { class: "muted small" }, "Enforces passcode rules only — it does not create a passcode. To actually set one, use ", h("strong", {}, "Set passcode on all members"), " from the group page."),
        field("Passcode type", type),
        field("Minimum length", len),
        field("Wipe after failed attempts", wipe, "4–16 wrong attempts fully wipe the device. −1 disables wipe."),
        field("Auto-lock after (seconds)", lock),
        field("Grace period (minutes)", grace, "Minutes before Android starts prompting the user to comply."),
        h("label", { class: "pick" }, fingerprint, h("span", {}, "Allow fingerprint unlock")),
        h("label", { class: "pick" }, faceUnlock, h("span", {}, "Allow face unlock")),
      );
      collect = () => ({
        passcodeType: Number(type.value),
        minLength: Number(len.value),
        maxFailedAttempts: Number(wipe.value),
        autoLockSeconds: Number(lock.value),
        gracePeriodMinutes: Number(grace.value),
        allowFingerprint: fingerprint.checked ? 1 : 0,
        allowFaceUnlock: faceUnlock.checked,
      });
    } else if (kind === "frp") {
      const id = input({ placeholder: "Google account user id (from Zoho FRP help)" });
      const em = input({ type: "email", placeholder: "frp-admin@company.co.tz" });
      clear(formBox, h("p", { class: "muted" }, "After a factory reset, only this Google account can set the device up again."), field("Account user id", id), field("Account email", em));
      collect = () => ({ accounts: [{ emailUserId: id.value.trim(), email: em.value.trim() }] });
    } else {
      const pn = input({ placeholder: "e.g. ANDROID_WIFI_POLICY" });
      const json = h("textarea", { rows: 10, class: "mono", placeholder: '{ "ssid": "Office" }' });
      clear(formBox, h("p", { class: "muted" }, "Payload name and fields exactly as in the MDM developer guide."), field("Payload name", pn), field("Payload JSON", json));
      collect = () => {
        try {
          return { payloadName: pn.value.trim(), payload: JSON.parse(json.value || "{}") };
        } catch {
          throw Object.assign(new Error("Payload JSON is not valid"), { code: "VALIDATION_FAILED" });
        }
      };
    }
  };
  function renderIosKiosk() {
    const mode = select([{ value: "single", label: "Single app" }, { value: "multi", label: "Multiple apps" }]);
    const appsBox = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading apps from Zoho…"));
    const picks = [];
    const modeHint = h("p", { class: "muted small" }, "Pick the apps allowed to run in kiosk.");
    const refreshHint = () => {
      modeHint.textContent = mode.value === "single"
        ? "Pick exactly one app. The device will be locked to it."
        : "Pick one or more apps. They'll be allowed to run in kiosk (implemented via Apple's Autonomous Single App Mode).";
    };
    mode.addEventListener("change", refreshHint);
    refreshHint();

    // Single mode = pick exactly one; ticking a second unchecks the first (radio-like).
    const enforceSingle = (justChecked) => {
      if (mode.value !== "single") return;
      for (const p of picks) if (p.cb !== justChecked && p.cb.checked) p.cb.checked = false;
    };
    mode.addEventListener("change", () => {
      if (mode.value !== "single") return;
      let keptOne = false;
      for (const p of picks) {
        if (!p.cb.checked) continue;
        if (keptOne) p.cb.checked = false;
        else keptOne = true;
      }
    });

    // iOS kiosk requires Zoho's numeric app_id — NOT a bundle identifier — per the
    // applockpolicy spec. So only apps uploaded to the Zoho app repo work; the
    // common-apps catalog, enrolled-devices scan and manual-bundle add used
    // elsewhere don't apply here (none of them carries a Zoho app_id).
    const renderRepoRow = (a) => {
      const cb = h("input", { type: "checkbox" });
      cb.addEventListener("change", () => { if (cb.checked) enforceSingle(cb); });
      picks.push({ a, cb });
      return h("div", { class: "kiosk-app" },
        h("label", { class: "pick" }, cb, h("span", {}, a.app_name, h("span", { class: "muted small" }, ` · app_id ${a.app_id}`))),
      );
    };

    get("/api/apps").then((apps) => {
      const all = apps ?? [];
      const ios = all.filter((a) => Number(a.platform_type) === 1);
      const otherPlatformCount = all.length - ios.length;
      const platformChip = (pt) => {
        const n = Number(pt);
        if (n === 1) return "iOS";
        if (n === 2) return "Android";
        if (n === 3) return "Windows";
        if (n === 4) return "macOS";
        return `platform ${pt ?? "?"}`;
      };
      const header = h("div", { class: "row", style: "align-items:baseline; gap:12px" },
        h("p", { class: "muted small", style: "margin:0" },
          `${ios.length} iOS app${ios.length === 1 ? "" : "s"} in your Zoho repo`,
          otherPlatformCount ? ` (${otherPlatformCount} non-iOS hidden)` : "",
          ".",
        ),
        h("a", {
          class: "btn btn-xs",
          href: "https://mdm.manageengine.com/mdm/webclient/AppRepository.do",
          target: "_blank",
          rel: "noopener noreferrer",
        }, "+ Add in Zoho"),
      );
      if (ios.length) {
        clear(appsBox, header, ...ios.map(renderRepoRow));
        return;
      }
      // No iOS apps — show what IS there (likely only the ME MDM Self Service app)
      // so admin can see the repo isn't broken, just lacks iOS entries.
      const otherRows = all.length
        ? [
          h("p", { class: "muted small" }, "What's in the repo right now (none are iOS, so they can't be picked for iOS kiosk):"),
          h("ul", { class: "list" }, all.map((a) =>
            h("li", {},
              h("strong", {}, a.app_name ?? "App"),
              h("span", { class: "muted small" }, ` · ${platformChip(a.platform_type)} · app_id ${a.app_id}`),
            ),
          )),
        ]
        : [h("p", { class: "muted small" }, "The repo is empty.")];
      clear(appsBox,
        h("div", { class: "banner banner-warn" },
          h("div", {},
            h("strong", {}, "No iOS apps in your Zoho app repo yet. "),
            "iOS kiosk needs the numeric app_id Zoho assigns when an app is uploaded. ",
            "Add the kiosk app in the ME MDM console: ",
            h("em", {}, "Device Mgmt → App Repository → Add App → Select Apple → either Add Store App or Enterprise App"),
            ". For a free App Store app, you just need the bundle id (e.g. com.google.chrome.ios). Once added, reload this form.",
          ),
        ),
        ...otherRows,
      );
    }).catch((err) => {
      clear(appsBox, h("p", { class: "muted" }, "Could not load apps from Zoho."));
      toastError(err);
    });

    const disableTouch = h("input", { type: "checkbox" });
    const disableRotation = h("input", { type: "checkbox" });
    const disableVolume = h("input", { type: "checkbox" });
    const disableRinger = h("input", { type: "checkbox" });
    const disableSleep = h("input", { type: "checkbox" });
    const disableAutoLock = h("input", { type: "checkbox", checked: true });
    const voiceOver = h("input", { type: "checkbox" });
    const zoom = h("input", { type: "checkbox" });
    const invert = h("input", { type: "checkbox" });
    const assistive = h("input", { type: "checkbox" });
    const speakSel = h("input", { type: "checkbox" });
    const monoAudio = h("input", { type: "checkbox" });

    const checkbox = (el, label) => h("label", { class: "pick" }, el, h("span", {}, label));

    const lockdown = h("button", { class: "btn btn-sm", type: "button", onclick: () => {
      mode.value = "single"; mode.dispatchEvent(new Event("change"));
      disableTouch.checked = false; disableRotation.checked = true;
      disableVolume.checked = true; disableRinger.checked = true;
      disableSleep.checked = true; disableAutoLock.checked = true;
      toast("Lockdown preset applied", "info");
    } }, "Use lockdown preset");

    clear(formBox,
      h("p", { class: "muted small" }, "iOS kiosk is supervised-only (requires Apple Business Manager / Apple Configurator)."),
      field("Mode", mode),
      h("h3", {}, "Apps"),
      modeHint,
      appsBox,
      h("div", { class: "row" }, h("h3", {}, "Device behavior"), lockdown),
      h("h4", { class: "section-head" }, "hardware"),
      h("div", { class: "restrictions" },
        checkbox(disableTouch, "Disable touch screen"),
        checkbox(disableRotation, "Disable auto-rotation"),
        checkbox(disableVolume, "Disable volume buttons"),
        checkbox(disableRinger, "Disable ringer switch"),
        checkbox(disableSleep, "Disable sleep/wake button"),
        checkbox(disableAutoLock, "Disable auto-lock (screen stays on)"),
      ),
      h("h4", { class: "section-head" }, "accessibility (visible as toggles in kiosk)"),
      h("div", { class: "restrictions" },
        checkbox(voiceOver, "VoiceOver"),
        checkbox(zoom, "Zoom"),
        checkbox(invert, "Invert colors"),
        checkbox(assistive, "AssistiveTouch"),
        checkbox(speakSel, "Speak Selection"),
        checkbox(monoAudio, "Mono Audio"),
      ),
    );
    collect = () => {
      const chosen = picks.filter((p) => p.cb.checked);
      if (mode.value === "single" && chosen.length !== 1) {
        throw Object.assign(new Error("Single-app kiosk needs exactly one app picked"), { code: "VALIDATION_FAILED" });
      }
      if (mode.value === "multi" && !chosen.length) {
        throw Object.assign(new Error("Multi-app kiosk needs at least one app picked"), { code: "VALIDATION_FAILED" });
      }
      return {
        mode: mode.value,
        apps: chosen.map((p) => ({
          appId: String(p.a.app_id),
          displayName: p.a.app_name ?? String(p.a.app_id),
          isSystemApp: false,
        })),
        disableTouch: disableTouch.checked,
        disableDeviceRotation: disableRotation.checked,
        disableVolumeButtons: disableVolume.checked,
        disableRingerSwitch: disableRinger.checked,
        disableSleepButton: disableSleep.checked,
        disableAutoLock: disableAutoLock.checked,
        voiceOver: voiceOver.checked,
        zoom: zoom.checked,
        invertColors: invert.checked,
        asstTouch: assistive.checked,
        enableSpeakSelection: speakSel.checked,
        enableMonoAudio: monoAudio.checked,
      };
    };
  }

  function renderIosWifi() {
    const ssid = input({ placeholder: "Office-WiFi" });
    const enc = select([{ value: "WPA2", label: "WPA2 / WPA3 Personal" }, { value: "WPA", label: "WPA Personal" }, { value: "WEP", label: "WEP" }, { value: "Any", label: "Any" }, { value: "None", label: "Open (no password)" }]);
    const pw = input({ type: "password", placeholder: "Wi-Fi password" });
    const hidden = h("input", { type: "checkbox" });
    const autoJoin = h("input", { type: "checkbox", checked: true });
    const proxyType = select([{ value: "None", label: "No proxy" }, { value: "Manual", label: "Manual" }, { value: "Auto", label: "Automatic (PAC)" }]);
    const proxyServer = input({ placeholder: "proxy.company.local" });
    const proxyPort = input({ type: "number", min: 1, max: 65535, placeholder: "8080" });
    const proxyUser = input({ placeholder: "optional" });
    const proxyPass = input({ type: "password", placeholder: "optional" });
    const proxyWrap = h("div", { class: "stack", style: "display:none" },
      field("Proxy server", proxyServer),
      field("Proxy port", proxyPort),
      field("Proxy username", proxyUser),
      field("Proxy password", proxyPass),
    );
    proxyType.addEventListener("change", () => {
      proxyWrap.style.display = proxyType.value === "Manual" ? "" : "none";
    });
    clear(formBox,
      field("Network name (SSID)", ssid),
      field("Security", enc),
      field("Password", pw),
      h("label", { class: "pick" }, hidden, h("span", {}, "Hidden network (SSID not broadcast)")),
      h("label", { class: "pick" }, autoJoin, h("span", {}, "Auto-join this network")),
      field("Proxy", proxyType),
      proxyWrap,
    );
    collect = () => ({
      ssid: ssid.value.trim(),
      encryption: enc.value,
      password: pw.value,
      hiddenNetwork: hidden.checked,
      autoJoin: autoJoin.checked,
      proxyType: proxyType.value,
      proxyServer: proxyServer.value.trim(),
      proxyPort: proxyPort.value ? Number(proxyPort.value) : undefined,
      proxyUser: proxyUser.value.trim(),
      proxyPassword: proxyPass.value,
    });
  }

  function renderIosWebFilter() {
    const mode = select([{ value: "limit-adult", label: "Limit adult content (Apple's filter + custom lists)" }, { value: "allow-only", label: "Allow specific websites only" }]);
    const allowed = h("textarea", { rows: 6, class: "mono", placeholder: "https://docs.company.com\nhttps://portal.company.com" });
    const blocked = h("textarea", { rows: 4, class: "mono", placeholder: "https://news.example.com" });
    const bookmarks = h("textarea", { rows: 4, class: "mono", placeholder: "Company Portal | https://portal.company.com\nSupport | https://help.company.com" });
    const allowOnlyWrap = h("div", { class: "stack", style: "display:none" }, field("Permitted URLs (one per line)", allowed, "Only these URLs load in Safari."));
    const limitWrap = h("div", { class: "stack" }, field("Blocked URLs (one per line)", blocked, "In addition to Apple's auto-adult filter."));
    const toggle = () => {
      allowOnlyWrap.style.display = mode.value === "allow-only" ? "" : "none";
      limitWrap.style.display = mode.value === "limit-adult" ? "" : "none";
    };
    mode.addEventListener("change", toggle);
    clear(formBox,
      h("p", { class: "muted small" }, "Supervised-only. Shapes Safari browsing on managed iPads/iPhones."),
      field("Mode", mode),
      allowOnlyWrap,
      limitWrap,
      field("Bookmarks (one per line: Title | URL)", bookmarks),
    );
    const parseBm = (txt) => txt.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [t, u] = l.split("|").map((s) => (s || "").trim());
      return u ? { title: t, url: u } : { title: t, url: t };
    });
    collect = () => ({
      mode: mode.value,
      permittedUrls: mode.value === "allow-only" ? allowed.value.split("\n").map((s) => s.trim()).filter(Boolean) : undefined,
      blacklistedUrls: mode.value === "limit-adult" ? blocked.value.split("\n").map((s) => s.trim()).filter(Boolean) : undefined,
      allowedUrls: parseBm(bookmarks.value),
    });
  }

  function renderIosVpn() {
    const name = input({ placeholder: "Office VPN" });
    const type = select([{ value: "IKEv2", label: "IKEv2" }, { value: "IPSec", label: "IPSec (Cisco)" }, { value: "L2TP", label: "L2TP" }, { value: "PPTP", label: "PPTP" }, { value: "AlwaysOn", label: "Always-On (supervised)" }]);
    const server = input({ placeholder: "vpn.company.co.tz" });
    const account = input({ placeholder: "username" });
    const pw = input({ type: "password", placeholder: "password" });
    const secret = input({ type: "password", placeholder: "shared secret / PSK" });
    const auth = select([{ value: "Password", label: "Password" }, { value: "RSA", label: "RSA SecurID" }, { value: "Certificate", label: "Certificate" }]);
    const sendAll = h("input", { type: "checkbox", checked: true });
    const idle = h("input", { type: "checkbox" });
    const proxyServer = input({ placeholder: "optional proxy" });
    const proxyPort = input({ type: "number", min: 1, max: 65535, placeholder: "optional" });
    clear(formBox,
      field("Connection name", name),
      field("Type", type),
      field("Server", server),
      field("User authentication", auth),
      field("Account", account),
      field("Password", pw),
      field("Shared secret / PSK", secret),
      h("label", { class: "pick" }, sendAll, h("span", {}, "Send all traffic over VPN")),
      h("label", { class: "pick" }, idle, h("span", {}, "Disconnect when idle")),
      field("Proxy server", proxyServer),
      field("Proxy port", proxyPort),
    );
    collect = () => ({
      connectionName: name.value.trim(),
      type: type.value,
      server: server.value.trim(),
      account: account.value.trim(),
      password: pw.value,
      sharedSecret: secret.value,
      authentication: auth.value,
      sendAllTraffic: sendAll.checked,
      disconnectOnIdle: idle.checked,
      proxyServer: proxyServer.value.trim() || undefined,
      proxyPort: proxyPort.value ? Number(proxyPort.value) : undefined,
    });
  }

  function renderIosEmail() {
    const descr = input({ placeholder: "Work mail" });
    const type = select([{ value: "IMAP", label: "IMAP" }, { value: "POP", label: "POP" }]);
    const displayName = input({ placeholder: "Jane Doe" });
    const addr = input({ type: "email", placeholder: "jane@company.co.tz" });
    const inHost = input({ placeholder: "imap.company.co.tz" });
    const inPort = input({ type: "number", min: 1, max: 65535, value: 993 });
    const inSsl = h("input", { type: "checkbox", checked: true });
    const inAuth = select([{ value: "Password", label: "Password" }, { value: "None", label: "None" }]);
    const inUser = input({ placeholder: "same as email by default" });
    const outHost = input({ placeholder: "smtp.company.co.tz" });
    const outPort = input({ type: "number", min: 1, max: 65535, value: 587 });
    const outSsl = h("input", { type: "checkbox", checked: true });
    const outAuth = select([{ value: "Password", label: "Password" }, { value: "None", label: "None" }]);
    const outUser = input({ placeholder: "same as email by default" });
    const preventMove = h("input", { type: "checkbox" });
    const preventSheet = h("input", { type: "checkbox" });
    const noDrop = h("input", { type: "checkbox" });
    clear(formBox,
      field("Account description", descr),
      field("Protocol", type),
      field("Display name", displayName),
      field("Email address", addr),
      h("h4", { class: "section-head" }, "incoming server"),
      field("Host", inHost),
      field("Port", inPort),
      h("label", { class: "pick" }, inSsl, h("span", {}, "Use SSL")),
      field("Authentication", inAuth),
      field("Username", inUser),
      h("h4", { class: "section-head" }, "outgoing server"),
      field("Host", outHost),
      field("Port", outPort),
      h("label", { class: "pick" }, outSsl, h("span", {}, "Use SSL")),
      field("Authentication", outAuth),
      field("Username", outUser),
      h("h4", { class: "section-head" }, "restrictions"),
      h("label", { class: "pick" }, preventMove, h("span", {}, "Prevent moving messages to other accounts")),
      h("label", { class: "pick" }, preventSheet, h("span", {}, "Prevent sending from third-party apps")),
      h("label", { class: "pick" }, noDrop, h("span", {}, "Disable Mail Drop")),
    );
    collect = () => ({
      accountDescription: descr.value.trim(),
      accountType: type.value,
      userDisplayName: displayName.value.trim() || undefined,
      emailAddress: addr.value.trim(),
      incomingMailServer: inHost.value.trim(),
      incomingMailPort: Number(inPort.value),
      incomingUseSsl: inSsl.checked,
      incomingAuthentication: inAuth.value,
      incomingUsername: inUser.value.trim() || undefined,
      outgoingMailServer: outHost.value.trim(),
      outgoingMailPort: Number(outPort.value),
      outgoingUseSsl: outSsl.checked,
      outgoingAuthentication: outAuth.value,
      outgoingUsername: outUser.value.trim() || undefined,
      preventMove: preventMove.checked,
      preventAppSheet: preventSheet.checked,
      disableMailDrop: noDrop.checked,
    });
  }

  function renderIosProxy() {
    const mode = select([{ value: "manual", label: "Manual (server + port)" }, { value: "auto", label: "Automatic (PAC URL)" }]);
    const server = input({ placeholder: "proxy.company.local" });
    const port = input({ type: "number", min: 1, max: 65535, placeholder: "8080" });
    const user = input({ placeholder: "optional" });
    const pw = input({ type: "password", placeholder: "optional" });
    const pac = input({ placeholder: "https://proxy.company.local/wpad.dat" });
    const bypass = h("input", { type: "checkbox", checked: true });
    const manualWrap = h("div", { class: "stack" }, field("Server", server), field("Port", port), field("Username", user), field("Password", pw));
    const autoWrap = h("div", { class: "stack", style: "display:none" }, field("PAC URL", pac, "Where the device fetches its proxy auto-config."));
    const toggle = () => {
      manualWrap.style.display = mode.value === "manual" ? "" : "none";
      autoWrap.style.display = mode.value === "auto" ? "" : "none";
    };
    mode.addEventListener("change", toggle);
    clear(formBox,
      h("p", { class: "muted small" }, "Supervised-only. Forces all HTTP traffic on the device through a proxy."),
      field("Proxy type", mode),
      manualWrap,
      autoWrap,
      h("label", { class: "pick" }, bypass, h("span", {}, "Allow bypassing the proxy to access captive networks")),
    );
    collect = () => ({
      proxyType: mode.value,
      server: server.value.trim(),
      port: port.value ? Number(port.value) : undefined,
      username: user.value.trim() || undefined,
      password: pw.value || undefined,
      pacUrl: pac.value.trim(),
      allowBypass: bypass.checked,
    });
  }

  function renderWallpaper() {
    // Admin picks an image → we upload to /api/profiles/wallpaper-upload →
    // backend uploads to Zoho /emsapi/files → returns a fileID → we attach it
    // to the wallpaper policy on submit. Supports both platforms; iOS has an
    // extra position selector (lock vs home vs both vs different per screen).
    const isIos = plat() === "ios";

    const homeFile = h("input", { type: "file", accept: "image/png,image/jpeg" });
    const lockFile = h("input", { type: "file", accept: "image/png,image/jpeg" });
    const homePreview = h("img", { style: "max-width:140px; max-height:200px; border-radius:8px; display:none;" });
    const lockPreview = h("img", { style: "max-width:140px; max-height:200px; border-radius:8px; display:none;" });
    const homeStatus = h("span", { class: "muted small" }, "no image chosen");
    const lockStatus = h("span", { class: "muted small" }, "no image chosen");
    let homeFileId = null;
    let lockFileId = null;

    const position = isIos
      ? select([
          { value: "3", label: "Both screens (same image)" },
          { value: "1", label: "Lock screen only" },
          { value: "2", label: "Home screen only" },
          { value: "4", label: "Different image for each" },
        ])
      : select([
          { value: "3", label: "Tile (repeat)" },
          { value: "1", label: "Center" },
          { value: "2", label: "Stretch to fill" },
        ]);
    const allowChange = h("input", { type: "checkbox" });

    function previewLocal(file, img) {
      if (!file) { img.style.display = "none"; return; }
      const url = URL.createObjectURL(file);
      img.src = url;
      img.style.display = "block";
    }

    async function uploadOne(file, statusEl, target) {
      if (!file) return null;
      if (file.size > 2_000_000) { statusEl.textContent = "image too big (max 2 MB)"; return null; }
      statusEl.textContent = "uploading…";
      try {
        const r = await uploadFile("/api/profiles/wallpaper-upload", file);
        statusEl.textContent = `✓ uploaded (${file.name})`;
        if (target === "home") homeFileId = r.fileId;
        if (target === "lock") lockFileId = r.fileId;
        return r.fileId;
      } catch (err) {
        statusEl.textContent = `upload failed: ${err.message}`;
        toastError(err);
        return null;
      }
    }

    homeFile.addEventListener("change", async () => {
      const f = homeFile.files?.[0] ?? null;
      previewLocal(f, homePreview);
      await uploadOne(f, homeStatus, "home");
    });
    lockFile.addEventListener("change", async () => {
      const f = lockFile.files?.[0] ?? null;
      previewLocal(f, lockPreview);
      await uploadOne(f, lockStatus, "lock");
    });

    const rerender = () => {
      // iOS positions 1 and 4 require a lock image; 2 and 3 use home only; 4 needs both.
      const pos = Number(position.value);
      const showHome = !isIos || pos !== 1;
      const showLock = isIos && (pos === 1 || pos === 4);
      lockGroup.style.display = showLock ? "" : "none";
      homeGroup.style.display = showHome ? "" : "none";
    };
    const homeGroup = h("div", { class: "stack" },
      field(isIos ? "Home-screen image" : "Image", h("div", { class: "row", style: "gap:12px; align-items:center" }, homeFile, homeStatus)),
      homePreview,
    );
    const lockGroup = h("div", { class: "stack" },
      field("Lock-screen image", h("div", { class: "row", style: "gap:12px; align-items:center" }, lockFile, lockStatus)),
      lockPreview,
    );
    position.addEventListener("change", rerender);

    const androidLockNote = isIos ? null : h("div", { class: "banner banner-info", style: "margin-bottom:8px" }, h("div", {},
      h("strong", {}, "Need a lock-screen message? "),
      "Android has no dedicated lock-screen-message profile in Zoho (iOS does — use the “Lock-screen message” purpose there). ",
      "The workaround is to bake the text into the wallpaper image itself (e.g. in Figma, Photoshop, or Canva) and upload that. ",
      "Most Android launchers reuse the home wallpaper on the lock screen, so a line like ",
      h("em", {}, "“Property of Acme POS — call +255 712 345 678”"),
      " shows up when the device is locked.",
    ));
    clear(formBox,
      h("p", { class: "muted small" }, isIos
        ? "Push a wallpaper image to iOS devices. PNG or JPEG, under 2 MB, RGB (greyscale is rejected by Apple)."
        : "Push a wallpaper image to Android devices. PNG or JPEG, under 2 MB. 960×800 is Zoho's recommended resolution."),
      ...(androidLockNote ? [androidLockNote] : []),
      field("Position", position),
      homeGroup,
      lockGroup,
      h("label", { class: "pick" }, allowChange, h("span", {}, "Let the user change wallpaper from Settings")),
    );
    rerender();

    collect = () => {
      if (isIos) {
        const pos = Number(position.value);
        const needHome = pos !== 1;
        const needLock = pos === 1 || pos === 4;
        if (needHome && !homeFileId) throw Object.assign(new Error("Upload a home-screen image first"), { code: "VALIDATION_FAILED" });
        if (needLock && !lockFileId) throw Object.assign(new Error("Upload a lock-screen image first"), { code: "VALIDATION_FAILED" });
        return { position: pos, homeFileId, lockFileId, allowChange: allowChange.checked };
      }
      if (!homeFileId) throw Object.assign(new Error("Upload an image first"), { code: "VALIDATION_FAILED" });
      return { fileId: homeFileId, position: Number(position.value), allowChange: allowChange.checked };
    };
  }

  function renderIosLockscreenMessage() {
    const msg = h("textarea", { rows: 3, maxlength: 500, placeholder: "e.g. This device belongs to Acme POS. For help call +255 712 345 678." });
    const bg = input({ type: "color", value: "#1F3A5F" });
    const fg = input({ type: "color", value: "#FFFFFF" });
    const orientation = select([{ value: "1", label: "Portrait" }, { value: "2", label: "Landscape" }]);
    // 0 = very top (behind status bar on iPhone — don't use), 35 = guide default,
    // 50 = middle, 100 = bottom. Anything < 15 risks hiding behind the notch/status bar.
    const offset = input({ type: "range", min: 0, max: 100, step: 5, value: 35 });
    const offsetLabel = h("span", { class: "muted small" }, "35% (default)");
    // iPhone-shaped preview — matches real iPhone 11 → 18 metrics so the text
    // position in the preview matches what shows on the device:
    //  - 19.5:9 aspect ratio (all iPhones since X)
    //  - ~54px corner radius scaled to our width (iPhone has 47.33pt / 55px)
    //  - 7px bezel (titanium / stainless frame)
    //  - Dynamic Island (14 Pro / 15 / 16 / 17 / 18) OR notch (11-14 non-Pro) at top
    //  - Time + status chrome at the top safe area so admins see the clash
    const previewText = h("div", {
      style: "padding:12px 20px; font-weight:500; text-align:center; white-space:pre-wrap; font-size:13px;",
    }, "This device belongs to Acme POS. For help call +255 712 345 678.");
    const topFiller = h("div", { style: "flex:0" });
    const bottomFiller = h("div", { style: "flex:1" });
    // Time (left) + status glyphs (right), typical iOS lock screen chrome.
    const timeDisplay = h("div", { style: "font-size:11px; font-weight:600; opacity:0.9" }, "9:41");
    const statusGlyphs = h("div", { style: "font-size:10px; opacity:0.9; letter-spacing:3px" }, "••••  5G  🔋");
    const statusBar = h("div", { style: "padding:14px 32px 6px; display:flex; justify-content:space-between; align-items:center;" }, timeDisplay, statusGlyphs);
    // Dynamic Island — black pill, centered, below the status chrome.
    const island = h("div", { style: "width:112px; height:34px; border-radius:20px; background:#000; margin:0 auto 10px; position:relative; z-index:2;" });
    const screen = h("div", {
      class: "lockscreen-preview",
      style: "border-radius:46px; display:flex; flex-direction:column; background:#1F3A5F; color:#FFFFFF; overflow:hidden; aspect-ratio:9/19.5;",
    }, statusBar, island, topFiller, previewText, bottomFiller);
    // iPhone body — black bezel around the screen.
    const preview = h("div", {
      style: "max-width:240px; margin:0 auto; padding:6px; background:#1a1a1c; border-radius:54px; box-shadow:0 20px 60px -20px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08) inset;",
    }, screen);

    const refresh = () => {
      screen.style.background = bg.value;
      screen.style.color = fg.value;
      timeDisplay.style.color = fg.value;
      statusGlyphs.style.color = fg.value;
      previewText.textContent = msg.value.trim() || "Your message will show here on the lock screen.";
      const pct = Number(offset.value);
      // Space above text (safe area + top filler) = pct; space below = 100 - pct.
      topFiller.style.flex = String(pct);
      bottomFiller.style.flex = String(100 - pct);
      offsetLabel.textContent = `${pct}%${pct === 35 ? " (default)" : pct < 15 ? " — risks hiding behind the Dynamic Island / notch" : ""}`;
    };
    for (const el of [msg, bg, fg, offset]) el.addEventListener("input", refresh);
    refresh();

    clear(formBox,
      h("p", { class: "muted small" }, "iOS supervised-only. Shows a persistent message on the device lock screen. Pair with iOS Kiosk mode to lock the device to one app AND display help info."),
      h("div", { class: "banner banner-info", style: "margin-bottom:8px" }, h("div", {},
        h("strong", {}, "Heads up — this rewrites the iOS lock-screen wallpaper. "),
        "When you later Delete this profile, the dashboard automatically pushes a plain black wallpaper first so the branded banner doesn't linger. The user's ",
        h("em", {}, "original"),
        " wallpaper can't be restored (Apple's MDM has no revert primitive), but they end up with a clean lock screen instead of your corporate graphic.",
      )),
      field("Message", msg, "Up to 500 characters. Keep it short so it stays legible."),
      field("Background colour", bg),
      field("Text colour", fg),
      field("Vertical position", h("div", { class: "row", style: "gap:8px; align-items:center" }, offset, offsetLabel),
        "0% = very top (hidden by status bar), 35% ≈ upper third (default), 50% = middle, 100% = bottom."),
      field("Orientation", orientation),
      h("h4", { class: "section-head" }, "preview"),
      preview,
    );
    collect = () => {
      const text = msg.value.trim();
      if (!text) throw Object.assign(new Error("Write a lock-screen message first"), { code: "VALIDATION_FAILED" });
      return {
        bgColour: bg.value,
        orientation: Number(orientation.value),
        messages: [{ message: text, textColour: fg.value, offsetPosition: Number(offset.value) }],
      };
    };
  }

  function renderIosPasscode() {
    const simple = h("input", { type: "checkbox" });
    const alnum = h("input", { type: "checkbox" });
    const len = input({ type: "number", min: 1, max: 16, value: 6 });
    const lock = select(catalog.ios.autoLockMinutes.map((m) => ({ value: String(m), label: `${m} minute${m === 1 ? "" : "s"}` })));
    lock.value = "5";
    const wipe = select([{ value: "", label: "Never erase" }, ...[3, 4, 5, 6, 7, 8, 9].map((n) => ({ value: String(n), label: `Erase after ${n} wrong attempts` }))]);
    wipe.value = "9";
    const age = input({ type: "number", min: 1, max: 170, placeholder: "never" });
    const history = input({ type: "number", min: 1, max: 50, placeholder: "off" });
    const grace = input({ type: "number", min: 0, max: 240, placeholder: "Apple default" });
    clear(formBox,
      h("p", { class: "muted small" }, "Sets the passcode rules on iPhones and iPads. Users are asked to choose a passcode that meets them."),
      h("label", { class: "pick" }, simple, h("span", {}, "Allow simple passcodes (1234, 1111)")),
      h("label", { class: "pick" }, alnum, h("span", {}, "Require letters and numbers")),
      field("Minimum length", len),
      field("Auto-lock after", lock),
      field("Wrong attempts before the iPhone is erased", wipe, "Apple erases the whole device after this many wrong passcodes. Choose \u201cNever erase\u201d if users may forget theirs."),
      field("Passcode expires after (days)", age, "Leave empty for no expiry."),
      field("Remember previous passcodes", history, "Users can't reuse this many old passcodes. Leave empty to allow reuse."),
      field("Ask for passcode after (minutes)", grace, "How long the phone can stay unlocked after waking. 0 = immediately."),
    );
    const num = (el) => (el.value === "" ? undefined : Number(el.value));
    collect = () => ({
      allowSimple: simple.checked,
      requireAlphanumeric: alnum.checked,
      minLength: Number(len.value),
      autoLockMinutes: Number(lock.value),
      maxFailedAttempts: num(wipe),
      maxAgeDays: num(age),
      history: num(history),
      gracePeriodMinutes: num(grace),
    });
  }

  purpose.addEventListener("change", renderForm);
  renderForm();

  const header = existing
    ? [h("p", { class: "muted" }, `Adds another policy to "${existing.name}". Re-publish afterwards to apply it.`), field("Policy", purpose)]
    : [field("Name", name), field("Description", desc), field("Platform", platform), field("Purpose", purpose)];

  modal(existing ? "Add policy" : "New profile", h("div", { class: "stack" }, header, formBox), [
    { label: "Cancel" },
    {
      label: existing ? "Add policy" : "Create draft",
      tone: "primary",
      onClick: async () => {
        if (!existing && !name.value.trim()) {
          name.focus();
          throw Object.assign(new Error("Give the profile a name (e.g. “Baseline – Security”)"), { code: "VALIDATION_FAILED" });
        }
        const config = collect();
        const res = existing
          ? await post(`/api/profiles/${existing.id}/policies`, { purpose: purpose.value, config })
          : await post("/api/profiles", { name: name.value.trim(), description: desc.value.trim(), platform: platform.value, purpose: purpose.value, config });
        toastEvent(res, existing ? "Policy added — re-publish to apply" : "Profile created as draft — publish it next");
        profilesView(el, ctx);
      },
    },
  ]);
}

// --------------------------------------------- read-only payload inspector
// Shows what's actually stored in a profile's payloads. Uses the restrictions
// catalog to map raw Zoho keys/values back to human labels when it recognises
// them; falls back to raw key: value otherwise.
async function viewProfile(ctx, catalog, profileId) {
  let p;
  try {
    p = await get(`/api/profiles/${profileId}`);
  } catch (err) {
    toastError(err);
    return;
  }
  const restrictionBy = Object.fromEntries(((p.platform === "ios" ? catalog.ios?.restrictions : catalog.restrictions) ?? []).map((r) => [r.key, r]));
  const prettyRestriction = (key, val) => {
    const def = restrictionBy[key];
    if (!def) return [key, String(val)];
    if (def.kind === "binary") {
      const label = String(val) === String(def.allow) ? "Allow" : String(val) === String(def.restrict) ? "Restrict" : String(val);
      return [def.label, label];
    }
    if (def.kind === "enum") {
      const match = def.options.find((o) => String(o.value) === String(val));
      return [def.label, match ? match.label : String(val)];
    }
    if (def.kind === "integer") {
      return [def.label, def.unit ? `${val} ${def.unit}` : String(val)];
    }
    return [def.label, val ? "On" : "Off"];
  };

  const payloadCfg = p.payload_config ?? {};
  const payloadNames = (p.payload_names ?? []).length ? p.payload_names : Object.keys(payloadCfg);

  const sections = payloadNames.length ? payloadNames.map((pname) => {
    const body = payloadCfg[pname] ?? {};
    const entries = Object.entries(body).filter(([k]) => k !== "payload_id");
    if (!entries.length) {
      return h("section", { class: "card" },
        h("h3", {}, pname),
        h("p", { class: "muted" }, "No values mirrored yet. Trigger a sync, then re-open."),
      );
    }
    const isRestrictions = pname === "androidrestrictionspolicy";
    const rows = entries.map(([k, v]) => {
      const [label, display] = isRestrictions ? prettyRestriction(k, v) : [k, typeof v === "object" ? JSON.stringify(v) : String(v)];
      return h("tr", {},
        h("td", {}, label),
        h("td", { class: "mono small" }, display),
      );
    });
    return h("section", { class: "card" },
      h("h3", {}, pname, h("span", { class: "muted small" }, ` · ${entries.length} field${entries.length === 1 ? "" : "s"}`)),
      h("table", { class: "kv" }, h("tbody", {}, rows)),
    );
  }) : [h("p", { class: "muted" }, "No payloads on this profile.")];

  modal(`${p.name}`, h("div", { class: "stack" },
    h("p", { class: "muted small" }, `Values mirrored from Zoho${p.last_synced_at ? ` · last synced ${new Date(p.last_synced_at).toLocaleString()}` : ""}. Use "Add policy" or edit in the Zoho console to change them.`),
    ...sections,
  ), [{ label: "Close" }]);
}
