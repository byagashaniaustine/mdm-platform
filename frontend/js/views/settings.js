import { api, del, get, post } from "../api.js";
import { badge, clear, field, fmtTime, h, input, loading, modal, pageHeader, select, table, tabStrip, toast, toastError } from "../ui.js";
import { monitoringSection } from "./monitoring-settings.js";

/** Result of creating an invite / reset link: says whether Supabase emailed it, and offers the link to copy. */
function showInviteLink(inv) {
  const isReset = inv.kind === "reset";
  const box = input({ readonly: true, value: inv.link, "aria-label": "Invite link" });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inv.link);
    } catch {
      box.select();
      document.execCommand?.("copy");
    }
    toast("Link copied");
  };
  modal(inv.emailed ? (isReset ? "Password reset sent" : "Invite sent") : "Send this link yourself", h("div", { class: "stack" },
    inv.emailed
      ? h("p", {}, `We emailed ${isReset ? "a password reset link" : "an invite"} to `, h("strong", {}, inv.email), ". You can also copy the link and send it another way.")
      : h("div", { class: "banner banner-warn" }, h("div", {}, h("strong", {}, "The email wasn't sent. "), inv.emailError ?? "")),
    field(isReset ? "Password reset link" : "Invite link", box,
      `Works once and expires ${new Date(inv.expiresAt).toLocaleDateString()}. Anyone with the link can ${isReset ? "set this admin's password" : "join as this admin"}, so send it only to ${inv.email}.`),
  ), [
    { label: "Close" },
    { label: "Copy link", tone: "primary", onClick: async () => { await copy(); return true; } },
  ]);
  box.addEventListener("focus", () => box.select());
}

export async function settingsView(el, ctx, params) {
  clear(el, loading());
  if (params?.get("zoho") === "connected") toast("Zoho connected");
  if (params?.get("zoho") === "error") toast(`Zoho connection failed (${params.get("code")})`, "bad");

  const TABS = [
    { id: "connection", label: "Zoho connection" },
    { id: "monitoring", label: "Monitoring" },
    ctx.can("admin") ? { id: "team", label: "Team" } : null,
    { id: "security", label: "Security" },
    { id: "sync", label: "Sync history" },
  ].filter(Boolean);
  const tab = TABS.some((t) => t.id === params?.get("tab")) ? params.get("tab") : "connection";
  const reload = () => settingsView(el, ctx, new URLSearchParams({ tab }));
  const [zoho, admins, runs, monitoring, pwState] = await Promise.all([
    tab === "connection" ? get("/api/zoho/status") : null,
    tab === "team" ? get("/api/admins") : [],
    tab === "sync" ? get("/api/sync-runs") : [],
    tab === "monitoring" ? monitoringSection(ctx, reload) : null,
    tab === "security" ? post("/api/auth/has-password", { email: ctx.me.email }).then((r) => r.data).catch(() => ({ hasPassword: false })) : null,
  ]);
  const owner = ctx.can("owner");

  const connectOAuth = async () => {
    try {
      const { data } = await post("/api/zoho/connect", {});
      location.href = data.url; // Zoho consent screen; comes back to /api/zoho/callback
    } catch (err) {
      toastError(err);
    }
  };

  const selfClient = () => {
    const id = input({ placeholder: "1000.XXXX" });
    const secret = input({ type: "password", autocomplete: "off" });
    const code = input({ placeholder: "1000.xxxx.yyyy — only the code value" });
    const dc = select([
      { value: "https://accounts.zoho.com", label: "United States (.com)" },
      { value: "https://accounts.zoho.eu", label: "Europe (.eu)" },
      { value: "https://accounts.zoho.in", label: "India (.in)" },
      { value: "https://accounts.zoho.com.au", label: "Australia (.com.au)" },
      { value: "https://accounts.zoho.uk", label: "United Kingdom (.uk)" },
      { value: "https://accounts.zoho.sa", label: "Saudi Arabia (.sa)" },
      { value: "https://accounts.zoho.ca", label: "Canada (.ca)" },
      { value: "https://accounts.zoho.jp", label: "Japan (.jp)" },
    ]);
    modal("Connect with a Self Client", h("div", { class: "stack" },
      h("p", { class: "muted" }, "api-console.zoho.com → Self Client → Generate Code with scopes MDMOnDemand.MDMInventory.ALL, MDMOnDemand.MDMDeviceMgmt.ALL, MDMOnDemand.MDMUser.ALL. Paste it within its validity window. Secrets are encrypted before storage."),
      field("Client ID", id), field("Client secret", secret), field("Generated code", code), field("Zoho data centre", dc),
    ), [
      { label: "Cancel" },
      { label: "Connect", tone: "primary", onClick: async () => {
        await post("/api/zoho/self-client", { clientId: id.value.trim(), clientSecret: secret.value.trim(), code: code.value.trim(), accountsServer: dc.value });
        toast("Zoho connected");
        reload();
      } },
    ]);
  };

  const invite = () => {
    const em = input({ type: "email" });
    const nm = input({});
    const role = select([{ value: "admin", label: "Admin — manage devices, groups, profiles" }, { value: "viewer", label: "Viewer — read only, identifiers masked" }]);
    modal("Invite admin", h("div", { class: "stack" }, field("Email", em), field("Name", nm), field("Role", role), h("p", { class: "muted" }, "We email them an invite link to set their password. You also get the link to copy, in case the email doesn't arrive.")), [
      { label: "Cancel" },
      { label: "Invite", tone: "primary", onClick: async () => {
        const { data } = await post("/api/admins", { email: em.value, fullName: nm.value, role: role.value });
        reload();
        if (data?.invite) showInviteLink(data.invite);
      } },
    ]);
  };

  const connection = () => h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Zoho MDM connection"), badge(zoho.status ?? "pending")),
      h("dl", { class: "facts" },
        h("dt", {}, "Mode"), h("dd", {}, zoho.mode ?? "—"),
        h("dt", {}, "Accounts server"), h("dd", {}, zoho.accounts_server ?? "—"),
        h("dt", {}, "API"), h("dd", {}, zoho.api_base ?? "—"),
        h("dt", {}, "Scopes"), h("dd", {}, (zoho.scopes ?? []).join(", ") || "—"),
        h("dt", {}, "Connected"), h("dd", {}, fmtTime(zoho.connected_at)),
        zoho.last_error ? [h("dt", {}, "Last error"), h("dd", { class: "text-bad" }, zoho.last_error)] : null,
      ),
      h("p", { class: "muted" }, "Zoho has no API to create an organisation or its directory admin. Create the Zoho MDM account and admin in Zoho first, then connect it here."),
      h("div", { class: "btn-row" },
        owner ? h("button", { class: "btn btn-primary", type: "button", onclick: connectOAuth }, zoho.status === "connected" ? "Reconnect with Zoho" : "Connect with Zoho") : null,
        owner ? h("button", { class: "btn", type: "button", onclick: selfClient }, "Use a Self Client instead") : null,
        ctx.can("admin") && zoho.status === "connected" ? h("button", { class: "btn", type: "button", onclick: async () => {
          try {
            const { data } = await post("/api/zoho/test", {});
            toast(`Connection works — ${data.devices_visible ?? "?"} device(s) visible`);
          } catch (err) {
            toastError(err);
          }
        } }, "Test connection") : null,
        owner && zoho.status === "connected" ? h("button", { class: "btn btn-ghost", type: "button", onclick: () => modal("Disconnect Zoho?", h("p", {}, "Tokens are revoked and deleted. Devices stay enrolled in Zoho."), [
          { label: "Cancel" },
          { label: "Disconnect", tone: "danger", onClick: async () => {
            await post("/api/zoho/disconnect", {});
            reload();
          } },
        ]) }, "Disconnect") : null,
      ),
    );

  const team = () => {
    const selfId = ctx.me.adminId;
    const run = async (fn, msg) => {
      try {
        await fn();
        if (msg) toast(msg);
        reload();
      } catch (err) {
        toastError(err);
      }
    };
    const confirmThen = (title, body, onYes) => modal(title, body, [
      { label: "Cancel" },
      { label: "Confirm", tone: "danger", onClick: onYes },
    ]);

    const actions = (a) => {
      if (a.id === selfId) return h("span", { class: "muted small" }, "That's you");
      if (!owner) return null;
      if (a.role === "owner") return h("span", { class: "muted small" }, "Owner");
      const toRole = a.role === "admin" ? "viewer" : "admin";
      const btns = [
        h("button", { class: "btn btn-xs", type: "button",
          onclick: () => run(() => api("PATCH", `/api/admins/${a.id}`, { role: toRole }), `Role changed to ${toRole}`),
        }, `Make ${toRole}`),
      ];
      if (a.role === "admin" && a.is_active) {
        btns.push(h("button", { class: "btn btn-xs", type: "button",
          onclick: () => confirmThen(
            `Transfer ownership to ${a.email}?`,
            h("p", {}, "You become an admin. Only the new owner can transfer it back. The Zoho connection and this enterprise's data are unaffected."),
            () => run(async () => { await post(`/api/admins/${a.id}/transfer-ownership`); location.reload(); }),
          ),
        }, "Make owner"));
      }
      if (a.is_active) {
        btns.push(h("button", { class: "btn btn-xs", type: "button",
          onclick: () => confirmThen(
            `Deactivate ${a.email}?`,
            h("p", {}, "They can't sign in and any open sessions end immediately. Everything they did stays in the audit log. You can reactivate them later."),
            () => run(() => post(`/api/admins/${a.id}/deactivate`), "Deactivated"),
          ),
        }, "Deactivate"));
        btns.push(h("button", { class: "btn btn-xs", type: "button",
          onclick: async () => {
            try {
              const { data } = await post(`/api/admins/${a.id}/invite-link`, {});
              showInviteLink(data);
            } catch (err) {
              toastError(err);
            }
          },
        }, a.has_password ? "Reset password" : "Resend invite"));
      } else {
        btns.push(h("button", { class: "btn btn-xs", type: "button",
          onclick: () => run(() => post(`/api/admins/${a.id}/activate`), "Reactivated"),
        }, "Reactivate"));
      }
      btns.push(h("button", { class: "btn btn-xs btn-ghost", type: "button",
        onclick: () => confirmThen(
          `Remove ${a.email}?`,
          h("p", {}, "Permanent. Their audit trail stays but the account is gone. Deactivate instead if you might bring them back."),
          () => run(() => del(`/api/admins/${a.id}`), "Removed"),
        ),
      }, "Remove"));
      return h("div", { class: "btn-row" }, ...btns);
    };

    const cols = [
      { label: "Name", primary: true, cell: (a) => h("div", {},
        h("div", { class: "cell-title" }, a.full_name ?? a.email, a.id === selfId ? [" ", badge("you", "muted")] : null),
        h("div", { class: "cell-sub" }, a.email),
      ) },
      { label: "Role", cell: (a) => badge(a.role, a.role === "owner" ? "ok" : a.role === "admin" ? "info" : "muted") },
      { label: "Status", cell: (a) => a.is_active ? badge("active", "ok") : badge("inactive", "warn") },
      { label: "Last sign-in", cell: (a) => h("span", { class: "muted" }, a.last_login_at ? fmtTime(a.last_login_at) : "Never") },
      { label: "", class: "actions", cell: actions },
    ];

    return h("section", { class: "card card-flush" },
      h("div", { class: "card-head" }, h("h2", {}, "Admins"), owner ? h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: invite }, "Invite admin") : null),
      h("div", { class: "table-wrap" }, table(cols, admins)),
    );
  };

  const security = () => {
    const hasPw = Boolean(pwState?.hasPassword);
    const cur = input({ type: "password", autocomplete: "current-password", required: hasPw });
    const nw = input({ type: "password", autocomplete: "new-password", required: true, minlength: 10, placeholder: "At least 10 characters" });
    const cf = input({ type: "password", autocomplete: "new-password", required: true, minlength: 10 });
    const form = h("form", { class: "stack" },
      h("p", { class: "muted" }, hasPw
        ? "Change your password. You'll stay signed in on this device."
        : "You haven't set a password yet. You can still sign in with a one-time code."),
      hasPw ? field("Current password", cur) : null,
      field("New password", nw, "At least 10 characters."),
      field("Confirm new password", cf),
      h("button", { class: "btn btn-primary", type: "submit" }, hasPw ? "Change password" : "Set password"),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (nw.value !== cf.value) {
        toast("New passwords don't match", "warn");
        return;
      }
      try {
        await post("/api/auth/password", {
          newPassword: nw.value,
          ...(hasPw ? { currentPassword: cur.value } : {}),
        });
        toast(hasPw ? "Password changed" : "Password set");
        reload();
      } catch (err) {
        toastError(err);
      }
    });
    return h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Password")),
      form,
    );
  };

  const sync = () => h("section", { class: "card card-flush" },
    h("div", { class: "card-head" }, h("h2", {}, "Sync history")),
    h("div", { class: "table-wrap" }, table([
      { label: "Resource", primary: true, cell: (r) => h("div", {}, h("div", { class: "cell-title" }, r.resource), h("div", { class: "cell-sub" }, fmtTime(r.started_at))) },
      { label: "Status", cell: (r) => badge(r.status) },
      { label: "Result", cell: (r) => h("span", { class: r.error ? "text-bad small" : "muted" }, r.error ?? `${r.items ?? 0} items`) },
    ], runs.slice(0, 30), { empty: "No syncs yet. Press Sync now once Zoho is connected." })),
  );

  clear(
    el,
    pageHeader("Settings", "Zoho connection, monitoring rules, your team and sync history."),
    tabStrip(TABS, tab, (id) => ctx.go(`#/settings?tab=${id}`)),
    tab === "connection" ? connection() : null,
    tab === "monitoring" ? monitoring : null,
    tab === "team" ? team() : null,
    tab === "security" ? security() : null,
    tab === "sync" ? sync() : null,
  );
}
