import { get, post, setUnauthorizedHandler } from "./api.js";
import { ago, clear, field, h, icon, input, toast, toastError } from "./ui.js";
import { overviewView } from "./views/overview.js";
import { deviceDetailView, devicesView } from "./views/devices.js";
import { groupDetailView, groupsView } from "./views/groups.js";
import { profilesView } from "./views/profiles.js";
import { announcementsView } from "./views/announcements.js";
import { activityView } from "./views/activity.js";
import { settingsView } from "./views/settings.js";
import { alertsView } from "./views/alerts.js";
import { locationsView } from "./views/locations.js";

const root = document.getElementById("app");
const ctx = { me: null, shell: null };

// Navigation grouped by what admins come to do.
const SECTIONS = [
  { title: "Monitor", items: ["overview", "alerts", "locations"] },
  { title: "Manage", items: ["devices", "groups", "profiles", "announcements"] },
  { title: "Records", items: ["activity", "settings"] },
];
const ROUTES = {
  overview: { label: "Overview", icon: "overview", view: overviewView },
  alerts: { label: "Alerts", icon: "alerts", view: alertsView },
  locations: { label: "Locations", icon: "locations", view: locationsView },
  devices: { label: "Devices", icon: "devices", view: devicesView, detail: deviceDetailView },
  groups: { label: "Groups", icon: "groups", view: groupsView, detail: groupDetailView },
  profiles: { label: "Profiles", icon: "profiles", view: profilesView },
  announcements: { label: "Announcements", icon: "announcements", view: announcementsView },
  activity: { label: "Activity", icon: "activity", view: activityView },
  settings: { label: "Settings", icon: "settings", view: settingsView },
};
const BOTTOM = ["overview", "alerts", "devices", "groups"];

const RANK = { viewer: 0, admin: 1, owner: 2 };
export const can = (min) => RANK[ctx.me?.role ?? "viewer"] >= RANK[min];
ctx.can = can;
ctx.go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};
ctx.refreshCounts = () => refreshCounts();

function currentRoute() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query ?? "");
  let [name, id] = path.split("/");
  if (name === "backlog") {
    name = "activity";
    params.set("tab", "backlog");
  }
  const route = ROUTES[name] ? name : "overview";
  return { name: route, route: ROUTES[route], id: id ? decodeURIComponent(id) : null, params };
}

// ------------------------------------------------------------------ auth
function authScreen(mode = "signin", opts = {}) {
  let email = opts.email ?? "";
  const panel = h("div", {});

  const codeStep = () => {
    const code = input({ inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, pattern: "[0-9]{6}", required: true, placeholder: "6-digit code" });
    const form = h(
      "form",
      { class: "stack" },
      h("p", { class: "muted" }, `We sent a sign-in code to ${email}. It is valid for 10 minutes.`),
      field("Code", code),
      h("button", { class: "btn btn-primary", type: "submit" }, "Sign in"),
      h("div", { class: "auth-alt" },
        h("button", { class: "btn-link", type: "button", onclick: () => post("/api/auth/otp", { email }).then(() => toast("New code sent")).catch(toastError) }, "Send a new code"),
        h("button", { class: "btn-link", type: "button", onclick: () => signinPassword() }, "Sign in with a password instead"),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await post("/api/auth/verify", { email, code: code.value.trim() });
        await boot();
      } catch (err) {
        toastError(err);
      }
    });
    clear(panel, form);
    code.focus();
  };

  const signinPassword = () => {
    const em = input({ type: "email", autocomplete: "email", required: true, value: email, placeholder: "you@company.co.tz" });
    const pw = input({ type: "password", autocomplete: "current-password", required: true, placeholder: "Your password" });
    const form = h("form", { class: "stack" },
      field("Work email", em),
      field("Password", pw),
      h("button", { class: "btn btn-primary", type: "submit" }, "Sign in"),
      h("div", { class: "auth-alt" },
        h("button", { class: "btn-link", type: "button", onclick: () => { email = em.value.trim().toLowerCase(); signinOtp(); } }, "Sign in with a one-time code"),
        h("button", { class: "btn-link", type: "button", onclick: () => { email = em.value.trim().toLowerCase(); forgotPassword(); } }, "Forgot password?"),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      email = em.value.trim().toLowerCase();
      try {
        await post("/api/auth/password-login", { email, password: pw.value });
        await boot();
      } catch (err) {
        toastError(err);
      }
    });
    clear(panel, form);
    (email ? pw : em).focus();
  };

  const signinOtp = () => {
    const em = input({ type: "email", autocomplete: "email", required: true, value: email, placeholder: "you@company.co.tz" });
    const form = h("form", { class: "stack" },
      field("Work email", em, "We'll email you a one-time sign-in code."),
      h("button", { class: "btn btn-primary", type: "submit" }, "Email me a code"),
      h("div", { class: "auth-alt" },
        h("button", { class: "btn-link", type: "button", onclick: () => { email = em.value.trim().toLowerCase(); signinPassword(); } }, "Sign in with a password instead"),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      email = em.value.trim().toLowerCase();
      try {
        await post("/api/auth/otp", { email });
        codeStep();
      } catch (err) {
        toastError(err);
      }
    });
    clear(panel, form);
    em.focus();
  };

  const forgotPassword = async () => {
    if (!email) {
      toast("Enter your email first, then press Forgot password.", "warn");
      return;
    }
    try {
      await post("/api/auth/otp", { email });
      resetStep();
    } catch (err) {
      toastError(err);
    }
  };

  const resetStep = () => {
    const code = input({ inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, pattern: "[0-9]{6}", required: true, placeholder: "6-digit code" });
    const pw = input({ type: "password", autocomplete: "new-password", required: true, minlength: 10, placeholder: "At least 10 characters" });
    const form = h("form", { class: "stack" },
      h("p", { class: "muted" }, `We sent a reset code to ${email}. Enter it with your new password.`),
      field("Reset code", code),
      field("New password", pw, "At least 10 characters."),
      h("button", { class: "btn btn-primary", type: "submit" }, "Set password and sign in"),
      h("div", { class: "auth-alt" },
        h("button", { class: "btn-link", type: "button", onclick: () => signinPassword() }, "Back to sign in"),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await post("/api/auth/reset-password", { email, code: code.value.trim(), newPassword: pw.value });
        await boot();
      } catch (err) {
        toastError(err);
      }
    });
    clear(panel, form);
    code.focus();
  };

  if (mode === "signin") {
    signinPassword();
  } else {
    const ent = input({ required: true, maxlength: 120, placeholder: "Acme Tanzania Ltd" });
    const name = input({ required: true, maxlength: 120, autocomplete: "name" });
    const em = input({ type: "email", required: true, autocomplete: "email" });
    const pw = input({ type: "password", autocomplete: "new-password", minlength: 10, placeholder: "At least 10 characters" });
    const form = h(
      "form",
      { class: "stack" },
      field("Enterprise name", ent),
      field("Your name", name),
      field("Admin email", em, "You become the owner of this enterprise."),
      field("Password (optional)", pw, "Set one now, or leave blank to sign in with a one-time code."),
      h("button", { class: "btn btn-primary", type: "submit" }, "Create enterprise"),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      email = em.value.trim().toLowerCase();
      const password = pw.value;
      try {
        const { data } = await post("/api/auth/register", {
          enterpriseName: ent.value,
          fullName: name.value,
          email,
          ...(password ? { password } : {}),
        });
        toast(data?.message ?? "Enterprise created");
        if (data?.hasPassword) authScreen("signin", { email });
        else codeStep();
      } catch (err) {
        toastError(err);
      }
    });
    panel.append(form);
  }

  ctx.shell = null;
  document.title = "Sign in · Device Console";
  clear(
    root,
    h("main", { class: "auth" },
      h("section", { class: "auth-hero" },
        h("img", { src: "/assets/logo-negative.svg", alt: "Black Swan" }),
        h("div", {},
          h("p", { class: "eyebrow" }, "Device Console"),
          h("h1", {}, "Company devices, managed from one place."),
          h("p", {}, "Lock, locate, configure and message your enrolled Android and Apple devices through your Zoho MDM account, without opening the Zoho console."),
        ),
        h("p", { class: "small" }, "Sign in with a password, or ask for a one-time code. Destructive actions need a second confirmation."),
      ),
      h("section", { class: "auth-main" },
        h("div", { class: "auth-card" },
          h("img", { class: "logo-mobile", src: "/assets/logo-primary.svg", alt: "Black Swan" }),
          h("h2", {}, mode === "signin" ? "Sign in" : "Register your enterprise"),
          h("p", { class: "muted" }, mode === "signin" ? "Use the email your enterprise owner invited." : "Your Zoho MDM account must already exist. You connect it after signing in."),
          h("div", { class: "tabs", role: "tablist" },
            h("button", { class: mode === "signin" ? "tab active" : "tab", role: "tab", type: "button", onclick: () => authScreen("signin") }, "Sign in"),
            h("button", { class: mode === "register" ? "tab active" : "tab", role: "tab", type: "button", onclick: () => authScreen("register") }, "Register enterprise"),
          ),
          panel,
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ shell
function navLink(name, extraClass) {
  const r = ROUTES[name];
  return h("a", { href: `#/${name}`, dataset: { path: name }, class: extraClass }, icon(r.icon), h("span", {}, r.label), h("span", { class: "nav-count", hidden: true, dataset: { count: name } }));
}

function shell() {
  const nav = h("nav", { class: "nav", "aria-label": "Main" }, SECTIONS.map((s) => [
    h("div", { class: "nav-section" }, s.title),
    s.items.map((n) => navLink(n)),
  ]));

  const signOut = async () => {
    await post("/api/auth/logout", {}).catch(() => {});
    ctx.me = null;
    authScreen();
  };

  const syncBtn = h("button", { class: "btn btn-sm", type: "button", "aria-label": "Sync now" }, icon("sync"), h("span", {}, "Sync now"));
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    syncBtn.lastChild.textContent = "Syncing…";
    try {
      const { data } = await post("/api/sync", {});
      const errs = Object.entries(data).filter(([, v]) => String(v).startsWith("error"));
      errs.length ? toast(`Sync finished with errors: ${errs.map(([k, v]) => `${k} ${v}`).join(", ")}`, "warn") : toast("Synced with Zoho");
      render();
    } catch (err) {
      toastError(err);
    } finally {
      syncBtn.disabled = false;
      syncBtn.lastChild.textContent = "Sync now";
    }
  });

  // Quick device search → devices page filtered.
  const q = input({ type: "search", placeholder: "Find a device", "aria-label": "Find a device" });
  const searchForm = h("form", { class: "search", role: "search" }, icon("search"), q);
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    ctx.go(`#/devices?q=${encodeURIComponent(q.value.trim())}`);
  });

  const status = h("a", { class: "status-pill", href: "#/settings" }, h("span", { class: "dot-status" }), h("span", { class: "status-text" }, "Zoho"));

  const content = h("main", { class: "content", id: "content", tabindex: "-1" });
  const toggle = () => document.body.classList.toggle("nav-open");

  clear(
    root,
    h("div", { class: "layout" },
      h("aside", { class: "sidebar", "aria-label": "Navigation" },
        h("div", { class: "sidebar-brand" }, h("img", { src: "/assets/logo-negative.svg", alt: "Black Swan" }), h("div", { class: "product" }, "Device Console")),
        h("div", { class: "org" }, h("strong", {}, ctx.me.enterpriseName), h("span", {}, `${ctx.me.email} · ${ctx.me.role}`)),
        nav,
        h("div", { class: "sidebar-foot" }, h("button", { class: "btn btn-ghost", type: "button", onclick: signOut }, icon("logout"), "Sign out")),
      ),
      h("div", { class: "drawer-backdrop", onclick: toggle }),
      h("div", { class: "main" },
        h("header", { class: "topbar" },
          h("img", { class: "mobile-logo", src: "/assets/logo-primary.svg", alt: "Black Swan" }),
          searchForm,
          h("div", { class: "spacer" }),
          status,
          can("admin") ? syncBtn : null,
        ),
        content,
      ),
      h("nav", { class: "bottombar", "aria-label": "Quick navigation" },
        BOTTOM.map((n) => navLink(n)),
        h("button", { type: "button", onclick: toggle, "aria-label": "More pages" }, icon("menu"), h("span", {}, "More")),
      ),
    ),
  );
  ctx.shell = { content, status, syncBtn };
}

async function refreshCounts() {
  if (!ctx.shell) return;
  try {
    const [stats, zoho] = await Promise.all([get("/api/overview"), get("/api/zoho/status")]);
    const connected = zoho.status === "connected";
    const dot = ctx.shell.status.querySelector(".dot-status");
    dot.className = `dot-status ${connected ? "ok" : "bad"}`;
    ctx.shell.status.querySelector(".status-text").textContent = connected ? `Zoho connected · synced ${ago(stats.last_sync)}` : "Zoho not connected";
    ctx.shell.status.title = connected ? "Zoho connected" : "Zoho not connected";
    const counts = { alerts: stats.open_alerts, activity: stats.backlog };
    for (const el of document.querySelectorAll("[data-count]")) {
      const n = counts[el.dataset.count] ?? 0;
      el.hidden = !n;
      el.textContent = n > 99 ? "99+" : String(n);
    }
  } catch {
    /* counts are decorative */
  }
}

async function render() {
  if (!ctx.me) return;
  if (!ctx.shell) shell();
  const { name, route, id, params } = currentRoute();
  document.body.classList.remove("nav-open");
  for (const a of document.querySelectorAll("[data-path]")) a.classList.toggle("active", a.dataset.path === name);
  document.title = `${route.label} · Device Console`;
  const el = ctx.shell.content;
  try {
    if (id && route.detail) await route.detail(el, ctx, id, params);
    else await route.view(el, ctx, params);
  } catch (err) {
    toastError(err);
  }
  window.scrollTo(0, 0);
  refreshCounts();
}

// Supabase appends "#access_token=…" to the invite link. The hash routing ignores it
// (unknown route → overview); we only read the "invite" query param our backend put there.
function inviteCodeFromUrl() {
  const code = new URL(location.href).searchParams.get("invite");
  return code && /^[0-9a-f-]{36}\.[A-Za-z0-9_\-]{20,100}$/.test(code) ? code : null;
}

function stripInviteFromUrl() {
  const u = new URL(location.href);
  u.searchParams.delete("invite");
  u.hash = ""; // drop Supabase's #access_token=… too
  history.replaceState(null, "", u.pathname + u.search);
}

function inviteScreen(code) {
  ctx.shell = null;
  document.title = "Set your password · Device Console";
  const pw = input({ type: "password", autocomplete: "new-password", required: true, minlength: 10, placeholder: "At least 10 characters" });
  const cf = input({ type: "password", autocomplete: "new-password", required: true, minlength: 10 });
  const form = h("form", { class: "stack" },
    h("p", { class: "muted" }, "Set the password for your Device Console account. You'll be signed in right after."),
    field("New password", pw, "At least 10 characters."),
    field("Confirm password", cf),
    h("button", { class: "btn btn-primary", type: "submit" }, "Set password and sign in"),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pw.value !== cf.value) return toast("Passwords don't match", "warn");
    try {
      await post("/api/auth/accept-invite", { code, password: pw.value });
      stripInviteFromUrl();
      await boot();
    } catch (err) {
      toastError(err);
    }
  });
  clear(root,
    h("main", { class: "auth" },
      h("section", { class: "auth-hero" },
        h("img", { src: "/assets/logo-negative.svg", alt: "Black Swan" }),
        h("div", {}, h("p", { class: "eyebrow" }, "Device Console"), h("h1", {}, "Welcome aboard."), h("p", {}, "This is a one-time link. Set a password you'll use from now on.")),
      ),
      h("section", { class: "auth-main" },
        h("div", { class: "auth-card" },
          h("img", { class: "logo-mobile", src: "/assets/logo-primary.svg", alt: "Black Swan" }),
          h("h2", {}, "Set your password"),
          form,
        ),
      ),
    ),
  );
  pw.focus();
}

async function boot() {
  const invite = inviteCodeFromUrl();
  try {
    ctx.me = await get("/api/auth/me");
  } catch {
    ctx.me = null;
  }
  if (invite) {
    if (ctx.me) {
      await post("/api/auth/logout", {}).catch(() => {});
      ctx.me = null;
    }
    return inviteScreen(invite);
  }
  if (!ctx.me) return authScreen();
  ctx.shell = null;
  render();
}

setUnauthorizedHandler(() => {
  if (ctx.me) toast("Session ended. Sign in again.", "warn");
  ctx.me = null;
  authScreen();
});
window.addEventListener("hashchange", render);
setInterval(refreshCounts, 60_000);
boot();
