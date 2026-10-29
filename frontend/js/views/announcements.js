import { del, get, post } from "../api.js";
import { ago, clear, emptyState, field, h, input, jsonBlock, loading, modal, multiPicker, pageHeader, toastError, toastEvent } from "../ui.js";

export async function announcementsView(el, ctx) {
  clear(el, loading());
  const mountToken = Symbol("announcements-view");
  el.__viewToken = mountToken;
  const admin = ctx.can("admin");
  const newBtn = admin ? h("button", { class: "btn btn-primary", type: "button", onclick: () => compose(el, ctx) }, "New announcement") : null;

  // Stable shell + content box so polling doesn't flicker the header/banner.
  const contentBox = h("div");
  clear(el,
    pageHeader("Announcements", "Messages shown on devices through the Zoho MDM app, with an optional acknowledgement button.", [newBtn]),
    h("div", { class: "banner banner-warn" }, h("div", {},
      h("strong", {}, "iPhone / iPad: "),
      "Announcements only appear inside the ",
      h("strong", {}, "ME MDM (Self Service) app"),
      ". Zoho reports success even when the app is missing — install it from the App Store and open it once so Apple Push can register, then re-send.")),
    contentBox,
  );

  const renderContent = (items) => clear(contentBox,
    items.length
      ? h("div", { class: "cards" }, items.map((a) =>
        h("article", { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, a.title), a.needs_ack ? h("span", { class: "badge badge-info" }, "needs acknowledgement") : null),
          h("p", { class: "preline" }, a.detail_message),
          h("p", { class: "muted small" }, `${a.name} · created ${ago(a.created_at)} · sent to ${a.announcement_targets.length} target(s)`),
          h("div", { class: "chips" }, a.announcement_targets.map((t) => h("span", { class: "badge badge-muted" }, t.groups?.name ?? t.devices?.device_name ?? "target"))),
          h("div", { class: "btn-row" },
            admin ? h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => sendDialog(a, el, ctx) }, "Send") : null,
            h("button", { class: "btn btn-sm", type: "button", onclick: async () => {
              try {
                modal("Delivery status", jsonBlock(await get(`/api/announcements/${a.id}/status`)));
              } catch (err) {
                toastError(err);
                if (err.code === "NOT_FOUND") announcementsView(el, ctx);
              }
            } }, "Delivery status"),
            admin ? h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: async () => {
              try {
                toastEvent(await del(`/api/announcements/${a.id}`), "Announcement deleted");
                announcementsView(el, ctx);
              } catch (err) {
                toastError(err);
              }
            } }, "Delete") : null,
          ),
        )))
      : emptyState("No announcements", "Send policy reminders, office notices or return-device requests to groups or single devices.", newBtn),
  );

  let latest = null;
  const equal = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const fetchAndRender = async () => {
    try {
      const items = await get("/api/announcements");
      if (equal(latest, items)) return;
      latest = items;
      renderContent(items);
    } catch (_) {}
  };
  await fetchAndRender();
  const timer = setInterval(() => {
    if (el.__viewToken !== mountToken) { clearInterval(timer); return; }
    if (document.hidden) return;
    fetchAndRender();
  }, 10_000);
}

function compose(el, ctx) {
  const name = input({ maxlength: 100, placeholder: "Internal name, e.g. Holiday notice Oct" });
  const title = input({ maxlength: 120 });
  const message = h("textarea", { rows: 6, maxlength: 4000 });
  const ack = h("input", { type: "checkbox" });
  const ackText = input({ maxlength: 30, value: "Got it" });
  const color = input({ type: "color", value: "#1f3a5f" });
  modal("New announcement", h("div", { class: "stack" },
    field("Name", name),
    field("Title", title),
    field("Message", message, "Plain text. Line breaks are kept."),
    h("label", { class: "pick" }, ack, h("span", {}, "Ask users to acknowledge")),
    field("Acknowledge button text", ackText),
    field("Title colour", color),
  ), [
    { label: "Cancel" },
    {
      label: "Create",
      tone: "primary",
      onClick: async () => {
        toastEvent(await post("/api/announcements", {
          name: name.value,
          title: title.value,
          message: message.value,
          needsAck: ack.checked,
          ackButton: ackText.value,
          titleColor: color.value.toUpperCase(),
        }), "Announcement created");
        announcementsView(el, ctx);
      },
    },
  ]);
}

async function sendDialog(a, el, ctx) {
  const [groups, devices] = await Promise.all([get("/api/groups"), get("/api/devices")]);
  const gp = multiPicker(groups, { label: (g) => `${g.name} (${g.member_count} devices)`, empty: "No groups" });
  const dp = multiPicker(devices, { label: (d) => `${d.device_name} · ${d.mdm_users?.user_name ?? "unassigned"}`, empty: "No devices" });
  modal(`Send "${a.title}"`, h("div", { class: "stack" }, h("h3", {}, "Groups"), gp.el, h("h3", {}, "Individual devices"), dp.el), [
    { label: "Cancel" },
    {
      label: "Send",
      tone: "primary",
      onClick: async () => {
        toastEvent(await post(`/api/announcements/${a.id}/send`, { groupIds: gp.values(), deviceIds: dp.values() }), "Announcement sent");
        announcementsView(el, ctx);
      },
    },
  ]);
}
