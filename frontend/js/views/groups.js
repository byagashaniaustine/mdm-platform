import { del, get, post } from "../api.js";
import { confirmDestructive } from "../confirm.js";
import { badge, clear, emptyState, field, filterableList, h, icon, input, loading, modal, multiPicker, pageHeader, select, table, toast, toastError, toastEvent } from "../ui.js";

const KINDS = [
  { value: "department", label: "Department (e.g. Finance, Sales)" },
  { value: "function", label: "Function (e.g. Kiosk POS, Field data)" },
  { value: "baseline", label: "Baseline (all corporate devices)" },
  { value: "other", label: "Other" },
];
// Where a profile ↔ group link came from (see database/003_profile_group_sync.sql).
const SOURCE = {
  zoho: { label: "from Zoho", hint: "Assigned in the Zoho console" },
  inferred: { label: "detected", hint: "Assigned in the Zoho console; seen on every device in this group" },
};
const kindTone = (k) => (k === "function" ? "info" : k === "baseline" ? "ok" : "muted");

export async function groupsView(el, ctx) {
  clear(el, loading());
  const groups = await get("/api/groups");
  const createBtn = ctx.can("admin") ? h("button", { class: "btn btn-primary", type: "button", onclick: () => createGroup(ctx) }, icon("plus"), "New group") : null;

  clear(
    el,
    pageHeader("Groups", "Settings go to groups, not single devices. A profile assigned to a group reaches every device in it.", [createBtn]),
    groups.length
      ? h("div", { class: "cards" }, groups.map((g) =>
        h("a", { class: "card group-card", href: `#/groups/${g.id}` },
          h("div", { class: "row" }, h("h2", {}, g.name), badge(g.kind, kindTone(g.kind))),
          g.description ? h("p", { class: "muted small" }, g.description) : null,
          h("div", { class: "meta" }, `${g.member_count} device(s) · ${(g.profile_groups ?? []).length} profile(s)`, g.zoho_group_id ? null : " · not yet in Zoho"),
          (g.profile_groups ?? []).length ? h("div", { class: "chips" }, g.profile_groups.map((pg) => badge(pg.profiles?.name ?? "profile", "info"))) : null,
        )))
      : h("section", { class: "card" }, emptyState("No groups yet", "Start with a baseline group for all corporate devices, then one group per department or function.", createBtn)),
  );
}

function createGroup(ctx) {
  const name = input({ maxlength: 100, placeholder: "Field Ops" });
  const kind = select(KINDS);
  const desc = input({ maxlength: 300 });
  modal("New group", h("div", { class: "stack" }, field("Name", name), field("Type", kind), field("Description", desc)), [
    { label: "Cancel" },
    { label: "Create", tone: "primary", onClick: async () => {
      const res = await post("/api/groups", { name: name.value, kind: kind.value, description: desc.value });
      toastEvent(res, "Group created in Zoho");
      const id = res.data?.groupId;
      ctx.go(id ? `#/groups/${id}` : "#/groups");
    } },
  ]);
}

export async function groupDetailView(el, ctx, id) {
  clear(el, loading());
  const [g, allDevices, allProfiles] = await Promise.all([get(`/api/groups/${id}`), get("/api/devices"), get("/api/profiles")]);
  const memberIds = new Set(g.devices.map((x) => x.devices?.id));
  const attachedIds = new Set(g.profiles.map((x) => x.profiles?.id));
  const admin = ctx.can("admin");
  const reload = () => groupDetailView(el, ctx, id);
  const guard = (fn) => async () => {
    try {
      await fn();
      reload();
    } catch (err) {
      toastError(err);
    }
  };

  const addDevices = () => {
    const picker = multiPicker(allDevices.filter((d) => !memberIds.has(d.id)), { label: (d) => `${d.device_name} · ${d.mdm_users?.user_name ?? "unassigned"}`, empty: "All devices are already in this group" });
    modal(`Add devices to ${g.name}`, picker.el, [{ label: "Cancel" }, { label: "Add", tone: "primary", onClick: async () => {
      toastEvent(await post(`/api/groups/${id}/devices`, { deviceIds: picker.values() }), "Devices added");
      reload();
    } }]);
  };
  const addProfiles = () => {
    const ready = allProfiles.filter((p) => p.state === "published" && !attachedIds.has(p.id));
    const picker = multiPicker(ready, { label: (p) => `${p.name} (${p.purpose})`, empty: "No published profiles left. Publish one in Profiles first." });
    modal(`Assign profiles to ${g.name}`, picker.el, [{ label: "Cancel" }, { label: "Assign", tone: "primary", onClick: async () => {
      toastEvent(await post(`/api/groups/${id}/profiles`, { profileIds: picker.values() }), "Profiles assigned");
      reload();
    } }]);
  };

  const PLATFORM_CODE = { android: 2, ios: 1, windows: 3 };
  const PLATFORM_CHIPS = [
    { value: "android", label: "Android" }, { value: "ios", label: "iOS" }, { value: "windows", label: "Windows" },
  ];

  const blacklistApp = async () => {
    const listBox = h("div", {}, loading());
    const manualBox = h("div", { class: "stack", hidden: true });
    const manualPicks = [];
    const addManualBtn = h("button", { class: "btn btn-sm", type: "button", onclick: () => {
      manualBox.hidden = false;
      manualBox.appendChild(manualRow());
    } }, "+ Add package manually");
    const manualRow = () => {
      const name = input({ placeholder: "App name" });
      const pkg = input({ placeholder: "Package identifier (e.g. com.example.app)" });
      const platform = select([{ value: "2", label: "Android" }, { value: "1", label: "iOS" }, { value: "3", label: "Windows" }]);
      const row = h("div", { class: "kiosk-app" },
        h("span", {}, "✱ manual"), name, pkg, platform,
        h("button", { class: "btn btn-xs", type: "button", onclick: () => {
          const i = manualPicks.findIndex((p) => p.el === row);
          if (i >= 0) manualPicks.splice(i, 1);
          row.remove();
          if (!manualPicks.length) manualBox.hidden = true;
        } }, "Remove"),
      );
      manualPicks.push({ el: row, read: () => ({ identifier: pkg.value.trim(), platform: Number(platform.value), appname: name.value.trim() || pkg.value.trim() }), checked: () => !!pkg.value.trim() });
      return row;
    };

    let installedPicks = [];
    try {
      const apps = await get(`/api/groups/${id}/installed-apps`);
      installedPicks = apps.map((a) => {
        const cb = h("input", { type: "checkbox" });
        return {
          a, cb,
          platform_type: a.platform_type, // flattened so filterableList's platformKey can read it
          read: () => ({ identifier: a.identifier, platform: PLATFORM_CODE[a.platform_type] ?? 2, appname: a.app_name ?? a.identifier }),
          checked: () => cb.checked,
        };
      });
      if (!installedPicks.length) {
        clear(listBox, h("p", { class: "muted small" },
          g.devices.length
            ? "No apps reported yet. Open a device, click 'Fetch installed apps' to warm Zoho's cache, then come back."
            : "Add devices to this group first.",
        ));
      } else {
        clear(listBox, filterableList(installedPicks, {
          search: (p) => `${p.a.app_name ?? ""} ${p.a.identifier ?? ""}`,
          platformKey: "platform_type",
          platforms: PLATFORM_CHIPS,
          render: (p) => h("label", { class: "pick" }, p.cb,
            h("span", {}, p.a.app_name ?? p.a.identifier,
              h("span", { class: "muted small" }, ` · ${p.a.identifier} · on ${p.a.devices} device${p.a.devices === 1 ? "" : "s"}`)),
          ),
          empty: "No matches.",
        }));
      }
    } catch (err) {
      clear(listBox, h("p", { class: "muted small" }, "Could not fetch installed apps."));
      toastError(err);
    }

    modal(`Blacklist app on ${g.name}`,
      h("div", { class: "stack" },
        h("p", { class: "muted small" }, "Pick from apps actually installed on this group's devices, or add a package manually. Blocks + prevents fresh installs. iPhone: supervised phones hide the app; unsupervised ones only notify the user. Android: removed on Samsung, work-profile and fully managed phones; others only notify the user."),
        listBox,
        manualBox,
        addManualBtn,
      ),
      [{ label: "Cancel" }, { label: "Blacklist", tone: "primary", onClick: async () => {
        const entries = [
          ...installedPicks.filter((p) => p.checked()).map((p) => p.read()),
          ...manualPicks.filter((p) => p.checked()).map((p) => p.read()),
        ].filter((e) => /^[a-zA-Z][\w.]+$/.test(e.identifier));
        if (!entries.length) throw Object.assign(new Error("Pick at least one app (or enter a valid package name)"), { code: "VALIDATION_FAILED" });
        toastEvent(await post(`/api/groups/${id}/blacklist`, { apps: entries }), `Blacklisted ${entries.length} app(s)`);
        reload();
      } }]);
  };

  // Zoho's platform encoding on blacklist entries is numeric; map to our chip values.
  const PLATFORM_FROM_NUM = { 1: "ios", 2: "android", 3: "windows" };

  const showBlacklist = async () => {
    let repo;
    try { repo = await get("/api/apps/blacklist"); } catch (err) { return toastError(err); }
    const rows = Array.isArray(repo?.apps) ? repo.apps : (Array.isArray(repo) ? repo : []);
    const owner = ctx.can("owner");
    const normalised = rows.map((a) => ({
      ...a,
      platform_name: PLATFORM_FROM_NUM[Number(a.platform)] ?? (typeof a.platform === "string" ? a.platform : "other"),
    }));

    modal(`Blacklist repository`,
      h("div", { class: "stack" },
        h("p", { class: "muted small" },
          "Apps in the Zoho enterprise blacklist repo. ",
          h("strong", {}, "Unblock here"), " lifts it for this group only. ",
          owner ? [h("strong", {}, "Remove from repo"), " nukes it from every group (owner only)."] : "",
        ),
        rows.length
          ? filterableList(normalised, {
            search: (a) => `${a.appname ?? ""} ${a.identifier ?? ""}`,
            platformKey: "platform_name",
            platforms: PLATFORM_CHIPS,
            render: (a) => h("div", { class: "blacklist-row" },
              h("div", { class: "stack-tight" },
                h("strong", {}, a.appname ?? "App"),
                h("span", { class: "muted small" }, a.identifier ?? ""),
              ),
              h("div", { class: "row-actions" },
                h("button", { class: "btn btn-xs", type: "button", onclick: async () => {
                  toastEvent(await post(`/api/groups/${id}/blacklist/remove`, { appGroupIds: [String(a.appgroupid)] }), "Unblocked on this group");
                  reload();
                } }, "Unblock here"),
                owner ? h("button", { class: "btn btn-xs btn-ghost", type: "button", onclick: async () => {
                  try {
                    await del("/api/apps/blacklist", { appGroupIds: [String(a.appgroupid)] });
                    toast("Removed from enterprise blacklist repo", "ok");
                    showBlacklist();
                  } catch (err) { toastError(err); }
                } }, "Remove from repo") : null,
              ),
            ),
            empty: "No matches.",
          })
          : h("p", { class: "muted" }, "Blacklist repo is empty. Blacklist an app to add one."),
      ),
      [{ label: "Close" }]);
  };

  const installApps = async () => {
    let apps = [];
    try { apps = await get("/api/apps"); } catch (err) { return toastError(err); }
    if (!apps.length) return toast("Zoho app repository is empty. Upload apps in Zoho's console first.", "warn");
    const PLATFORM_NAME = { 1: "ios", 2: "android", 3: "windows" };
    const picks = apps.map((a) => {
      const cb = h("input", { type: "checkbox" });
      return {
        a, cb,
        platform_name: PLATFORM_NAME[Number(a.platform_type)] ?? "other",
        checked: () => cb.checked,
      };
    });
    modal(`Install apps on all devices in ${g.name}`,
      h("div", { class: "stack" },
        h("p", { class: "muted small" }, "Pushes to every enrolled member device. Zoho picks the latest Stable release for each app."),
        filterableList(picks, {
          search: (p) => `${p.a.app_name ?? ""} ${p.a.bundle_identifier ?? ""} ${p.a.identifier ?? ""}`,
          platformKey: "platform_name",
          platforms: PLATFORM_CHIPS,
          render: (p) => h("label", { class: "pick" }, p.cb,
            h("span", {}, p.a.app_name ?? "App",
              h("span", { class: "muted small" }, ` · ${p.a.bundle_identifier ?? p.a.identifier ?? p.a.app_id}`))),
          empty: "No matches.",
        }),
      ),
      [{ label: "Cancel" }, { label: "Install", tone: "primary", onClick: async () => {
        const picked = picks.filter((p) => p.checked()).map((p) => ({ appId: String(p.a.app_id) }));
        if (!picked.length) throw Object.assign(new Error("Pick at least one app"), { code: "VALIDATION_FAILED" });
        toastEvent(await post(`/api/groups/${id}/apps`, { apps: picked }), "App install queued");
        reload();
      } }]);
  };
  const resetPasscode = () => {
    const pw = input({ type: "password", minlength: 4, maxlength: 16, placeholder: "4–16 characters", autocomplete: "new-password" });
    const emailUser = h("input", { type: "checkbox", checked: true });
    const emailAdmin = h("input", { type: "checkbox" });
    modal(`Set passcode on all devices in ${g.name}`, h("div", { class: "stack" },
      h("p", { class: "muted small" }, `Overwrites the lock-screen passcode on every enrolled member device (${g.devices.length}). Use this when a passcode profile isn't enough — e.g. the device has no passcode yet. iPhones and iPads are skipped: Apple doesn't allow setting a passcode remotely.`),
      field("New passcode", pw),
      h("label", { class: "pick" }, emailUser, h("span", {}, "Email the passcode to the device user")),
      h("label", { class: "pick" }, emailAdmin, h("span", {}, "Email the passcode to me")),
      h("p", { class: "muted small" }, "Next you confirm by typing the group name. Nothing changes on any phone until then."),
    ), [{ label: "Cancel" }, { label: "Continue", tone: "danger", onClick: async () => {
      if (!pw.value || pw.value.length < 4 || pw.value.length > 16) {
        throw Object.assign(new Error("Passcode must be 4–16 characters"), { code: "VALIDATION_FAILED" });
      }
      const res = await post(`/api/groups/${id}/actions/reset_passcode`, {
        passcode: pw.value,
        email_sent_to_user: emailUser.checked,
        email_sent_to_admin: emailAdmin.checked,
      });
      // Step 2: type the group name (confirm.js); per-device commands are sent only then.
      confirmDestructive(res, "Set passcode on all members", (r) => {
        const n = (r.data?.events ?? []).length;
        toast(`Passcode reset sent to ${n} device${n === 1 ? "" : "s"}`, "info");
        reload();
      });
    } }]);
  };
  const deleteGroup = () => modal("Delete group?", h("p", {}, `Delete "${g.name}" in Zoho? Devices stay enrolled but lose this group's profiles.`), [
    { label: "Cancel" },
    { label: "Delete", tone: "danger", onClick: async () => {
      toastEvent(await del(`/api/groups/${id}`), "Group deleted");
      ctx.go("#/groups");
    } },
  ]);

  const deviceCols = [
    { label: "Device", primary: true, cell: (x) => h("a", { class: "link", href: `#/devices/${x.devices?.id}` }, x.devices?.device_name ?? "device") },
    { label: "User", cell: (x) => x.devices?.mdm_users?.user_name ?? h("span", { class: "muted" }, "Unassigned") },
    admin ? { label: "", class: "actions", cell: (x) => h("button", { class: "btn btn-xs", type: "button", onclick: guard(async () => toastEvent(await del(`/api/groups/${id}/devices/${x.devices.id}`), "Device removed from group")) }, "Remove") } : null,
  ].filter(Boolean);

  clear(
    el,
    pageHeader(g.name, g.description || null, [
      admin ? h("button", { class: "btn btn-primary", type: "button", onclick: addDevices }, icon("plus"), "Add devices") : null,
      admin ? h("button", { class: "btn", type: "button", onclick: addProfiles }, "Assign profiles") : null,
    ], { href: "#/groups", label: "Groups" }),
    h("p", { class: "chips" }, badge(g.kind, kindTone(g.kind)), badge(`${g.devices.length} device(s)`, "muted"), g.zoho_group_id ? badge(`Zoho id ${g.zoho_group_id}`, "muted") : badge("not yet in Zoho", "warn")),
    h("div", { class: "split" },
      h("section", { class: "card card-flush" },
        h("div", { class: "card-head" }, h("h2", {}, "Devices")),
        h("div", { class: "table-wrap" }, table(deviceCols, g.devices, { empty: "No devices in this group yet." })),
      ),
      h("div", {},
        h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "Profiles")),
          g.profiles.length
            ? h("ul", { class: "list" }, g.profiles.map((x) =>
              h("li", {}, h("span", {}, x.profiles?.name, " ", badge(x.profiles?.purpose ?? "", "muted"), SOURCE[x.source] ? badge(SOURCE[x.source].label, "info") : null,
                SOURCE[x.source] ? h("div", { class: "cell-sub" }, SOURCE[x.source].hint) : null),
                admin ? h("button", { class: "btn btn-xs", type: "button", onclick: guard(async () => toastEvent(await post(`/api/groups/${id}/profiles/remove`, { profileIds: [x.profiles.id] }), "Profile removed from group")) }, "Remove") : null)))
            : h("p", { class: "muted" }, g.devices.length
              ? "No profiles assigned. Devices in this group get no settings from it yet."
              : "No profiles found. Profiles assigned in the Zoho console show up after a sync once the group has devices."),
        ),
        admin ? h("section", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, "App management")),
          h("p", { class: "muted small" }, g.devices.length
            ? "Push apps to every enrolled member device, or block apps from running on them."
            : "Add devices to this group to enable app management actions."),
          h("div", { class: "btn-row" },
            g.devices.length ? h("button", { class: "btn btn-sm", type: "button", onclick: installApps }, "Install apps") : null,
            g.devices.length ? h("button", { class: "btn btn-sm", type: "button", onclick: blacklistApp }, "Blacklist app") : null,
            h("button", { class: "btn btn-sm", type: "button", onclick: showBlacklist }, "View blacklist"),
          ),
        ) : null,
        admin && g.devices.length ? h("section", { class: "card danger-zone" },
          h("div", { class: "card-head" }, h("h2", {}, "Passcode for all members")),
          h("p", { class: "muted small" }, "Changes the lock-screen passcode on every enrolled device in this group. You confirm by typing the group name."),
          h("div", { class: "btn-row" },
            h("button", { class: "btn btn-sm btn-danger", type: "button", onclick: resetPasscode }, "Set passcode on all members"),
          ),
        ) : null,
        ctx.can("owner") ? h("section", { class: "card danger-zone" },
          h("div", { class: "card-head" }, h("h2", {}, "Delete group")),
          h("p", { class: "muted small" }, "Removes the group in Zoho. Devices stay enrolled."),
          h("button", { class: "btn btn-sm btn-danger", type: "button", onclick: deleteGroup }, "Delete group"),
        ) : null,
      ),
    ),
  );
}


