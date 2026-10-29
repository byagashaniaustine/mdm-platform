import { get } from "../api.js";
import { ago, badge, clear, h, icon, loading, pageHeader } from "../ui.js";

const SEVERITY_TONE = { critical: "bad", warning: "warn", info: "info" };

export async function overviewView(el, ctx) {
  clear(el, loading());
  const [stats, zoho, events, alerts, groups, profiles, automation] = await Promise.all([
    get("/api/overview"),
    get("/api/zoho/status"),
    get("/api/events?limit=8"),
    get("/api/alerts?status=active&limit=5").catch(() => []),
    get("/api/groups"),
    get("/api/profiles"),
    get("/api/automation/health").then((r) => r.data).catch(() => null),
  ]);

  // Setup checklist: the order an admin actually needs to follow.
  const connected = zoho.status === "connected";
  const steps = [
    { title: "Connect your Zoho MDM account", body: "Links this console to the devices you already enrol in Zoho.", done: connected, href: "#/settings?tab=connection", cta: "Connect", role: "owner" },
    { title: "Sync devices", body: "Pulls enrolled devices, users and groups from Zoho.", done: !!stats.last_sync && stats.devices > 0, href: "#/devices", cta: "Open devices", role: "admin" },
    { title: "Create a group", body: "Group devices by department or function. Settings go to groups, not single devices.", done: groups.length > 0, href: "#/groups", cta: "Create group", role: "admin" },
    { title: "Create and publish a profile", body: "Restrictions, kiosk, passcode or factory-reset protection.", done: profiles.some((p) => p.state === "published"), href: "#/profiles", cta: "Create profile", role: "admin" },
    { title: "Assign the profile to a group", body: "Every device in the group receives it.", done: groups.some((g) => (g.profile_groups ?? []).length > 0), href: "#/groups", cta: "Open groups", role: "admin" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const nextIdx = steps.findIndex((s) => !s.done);

  const bar = h("span");
  bar.style.width = `${(doneCount / steps.length) * 100}%`;

  const checklist = doneCount < steps.length
    ? h("section", { class: "card" },
      h("div", { class: "card-head" },
        h("div", {}, h("h2", {}, "Set up your console"), h("p", { class: "muted small" }, `${doneCount} of ${steps.length} done`)),
      ),
      h("div", { class: "progress", "aria-hidden": "true" }, bar),
      h("ol", { class: "checklist" }, steps.map((s, i) =>
        h("li", { class: s.done ? "done" : i === nextIdx ? "next" : "" },
          h("span", { class: "step-mark" }, s.done ? icon("check") : String(i + 1)),
          h("div", { class: "step-body" }, h("div", { class: "step-title" }, s.title), s.done ? null : h("div", { class: "muted small" }, s.body)),
          !s.done && i === nextIdx && ctx.can(s.role) ? h("a", { class: "btn btn-sm btn-primary", href: s.href }, s.cta) : null,
        )
      )),
    )
    : null;

  const tile = (label, value, href, tone) =>
    h("a", { class: `tile ${tone ? `tile-${tone}` : ""}`, href }, h("span", { class: "tile-label" }, label), h("span", { class: "tile-value" }, String(value ?? 0)));

  // Automation health tile — surfaces the three signals that need operator eyes:
  // circuit breaker state, devices stuck > 24h, and open automation alerts.
  const automationTile = (a) => {
    const bk = a.fineract_breaker || {};
    const stuck24 = a.devices_stuck?.over_24h ?? 0;
    const stuck2  = a.devices_stuck?.over_2h ?? 0;
    const openCount = (a.open_alerts ?? []).length;
    const criticalOpen = (a.open_alerts ?? []).some((x) => x.severity === "critical");
    const tone = bk.state !== "closed" || stuck24 > 0 || criticalOpen ? "bad"
               : stuck2 > 0 || openCount > 0 ? "warn"
               : a.active_loan_links > 0 ? "" : "";
    const label = bk.state !== "closed" ? "Automation · FINERACT DOWN"
                : stuck24 > 0            ? `Automation · ${stuck24} stuck 24h+`
                : stuck2 > 0             ? `Automation · ${stuck2} pending`
                : "Automation · healthy";
    return h("a", { class: `tile ${tone ? `tile-${tone}` : ""}`, href: "#/alerts?category=automation", title: `${a.active_loan_links} active loan(s) · breaker ${bk.state}` },
      h("span", { class: "tile-label" }, label),
      h("span", { class: "tile-value" }, String(a.active_loan_links ?? 0)),
    );
  };

  clear(
    el,
    pageHeader("Overview", `${ctx.me.enterpriseName} · last sync with Zoho ${ago(stats.last_sync)}`),
    !connected && doneCount > 0
      ? h("div", { class: "banner banner-warn" }, icon("alerts"), h("div", {}, h("strong", {}, "Zoho is not connected. "), "Commands and syncs are paused until it is reconnected. ", ctx.can("owner") ? h("a", { href: "#/settings?tab=connection" }, "Reconnect") : "Ask the owner to reconnect it."))
      : null,
    stats.backlog
      ? h("div", { class: "banner banner-bad" }, icon("alerts"), h("div", {}, `${stats.backlog} operation(s) failed after all retries. `, h("a", { href: "#/activity?tab=backlog" }, "Review backlog")))
      : null,
    checklist,
    h("div", { class: "tiles" },
      tile("Open alerts", stats.open_alerts, "#/alerts", stats.critical_alerts ? "bad" : stats.open_alerts ? "warn" : ""),
      tile("Devices", stats.devices, "#/devices"),
      tile("Groups", stats.groups, "#/groups"),
      tile("Profiles", stats.profiles, "#/profiles"),
      tile("In progress", stats.pending_events, "#/activity", stats.pending_events ? "info" : ""),
      tile("Lost mode", stats.lost_mode, "#/devices?lost=1", stats.lost_mode ? "warn" : ""),
      automation ? automationTile(automation) : null,
    ),
    h("div", { class: "split" },
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", {}, "Recent activity"), h("a", { href: "#/activity" }, "All activity")),
        events.length
          ? h("ul", { class: "feed" }, events.map((e) =>
            h("li", {},
              badge(e.state),
              h("span", { class: "feed-action" }, e.action.replace(/\./g, " › ").replace(/_/g, " ")),
              h("span", { class: "muted" }, [e.devices?.device_name, e.groups?.name, e.profiles?.name].filter(Boolean).join(" · ")),
              h("span", { class: "muted feed-time" }, ago(e.action_time)),
            )))
          : h("p", { class: "muted" }, "Actions you take appear here."),
      ),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", {}, "Open alerts"), h("a", { href: "#/alerts" }, "All alerts")),
        alerts.length
          ? h("ul", { class: "feed" }, alerts.map((a) =>
            h("li", {},
              badge(a.severity, SEVERITY_TONE[a.severity]),
              h("span", { class: "feed-action" }, a.title),
              h("span", { class: "muted small" }, [a.devices?.device_name, ago(a.last_seen_at ?? a.created_at)].filter(Boolean).join(" · ")),
            )))
          : h("p", { class: "muted" }, "No open alerts."),
        h("dl", { class: "facts small" },
          h("dt", {}, "Android"), h("dd", {}, String(stats.android ?? 0)),
          h("dt", {}, "Apple"), h("dd", {}, String(stats.ios ?? 0)),
          h("dt", {}, "Critical"), h("dd", {}, String(stats.critical_alerts ?? 0)),
        ),
      ),
    ),
  );
}
