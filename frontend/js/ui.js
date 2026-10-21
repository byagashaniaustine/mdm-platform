// Tiny DOM helpers. All text goes through textContent — never innerHTML with data.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const STATE_TONE = {
  succeeded: "ok",
  published: "ok",
  connected: "ok",
  sent: "info",
  acknowledged: "info",
  requested: "info",
  awaiting_confirmation: "warn",
  draft: "muted",
  modified: "warn",
  pending: "muted",
  failed: "bad",
  dead: "bad",
  error: "bad",
  cancelled: "muted",
  revoked: "muted",
};

export function badge(text, tone) {
  return h("span", { class: `badge badge-${tone ?? STATE_TONE[text] ?? "muted"}` }, String(text).replace(/_/g, " "));
}

// ------------------------------------------------------------------ toasts
export function toast(message, tone = "ok") {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts", class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  // Bad toasts stick until clicked (debug-friendly). Others auto-dismiss in ~5s.
  const sticky = tone === "bad" || tone === "warn";
  const closeBtn = sticky ? h("button", { class: "toast-close", "aria-label": "Dismiss", type: "button" }, "✕") : null;
  const t = h("div", { class: `toast toast-${tone}${sticky ? " toast-sticky" : ""}` }, message, closeBtn);
  host.append(t);
  if (sticky) {
    const dismiss = () => { t.classList.add("toast-out"); setTimeout(() => t.remove(), 400); };
    t.addEventListener("click", dismiss);
    closeBtn?.addEventListener("click", (e) => { e.stopPropagation(); dismiss(); });
  } else {
    setTimeout(() => t.classList.add("toast-out"), 4200);
    setTimeout(() => t.remove(), 4700);
  }
}

export function toastError(err) {
  // Log the full error to the dev console so debugging doesn't rely on catching the toast.
  console.error("toastError:", err);
  toast(`${err.message}${err.code && !String(err.code).startsWith("HTTP") ? ` (${err.code})` : ""}`, "bad");
}

/** Describe an operation result (200 done / 202 queued). */
export function toastEvent(res, doneText) {
  const events = res.data?.events ?? [];
  const ev = events[0];
  if (!ev) return toast(doneText);
  // Zoho rejected it: show why, as an error (the HTTP call itself still succeeded).
  const failed = events.filter((e) => e.state === "failed" || e.state === "dead");
  if (failed.length) {
    const why = failed[0].error_message ?? failed[0].error_code ?? "Zoho rejected it";
    const prefix = events.length > 1 ? `${failed.length} of ${events.length} failed` : `${doneText.replace(/ sent$| queued$/, "")} failed`;
    return toast(`${prefix}: ${why}`, "bad");
  }
  if (ev.state === "succeeded") toast(doneText);
  else if (ev.state === "requested") toast(`Queued for retry: ${ev.error_message ?? "Zoho busy"}`, "warn");
  else if (ev.state === "sent" || ev.state === "acknowledged") toast(`${doneText} — sent, waiting for the device`, "info");
  else if (ev.state === "awaiting_confirmation") toast("Waiting for you to confirm", "warn");
  else toast(`${doneText}: ${ev.state}`, "info");
}

// ------------------------------------------------------------------ modal
export function modal(title, body, actions = []) {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  const box = h(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
    h("div", { class: "modal-body" }, body),
    actions.length ? h("div", { class: "modal-actions" }, actions.map((a) => {
      const btn = h("button", { class: a.tone ? `btn btn-${a.tone}` : "btn", type: "button" }, a.label);
      btn.addEventListener("click", async () => {
        if (!a.onClick) return close();
        btn.disabled = true;
        try {
          const keep = await a.onClick();
          if (keep !== true) close();
        } catch (err) {
          toastError(err);
        } finally {
          btn.disabled = false;
        }
      });
      return btn;
    })) : null,
  );
  const overlay = h("div", { class: "overlay", onclick: (e) => e.target === overlay && close() }, box);
  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
  box.querySelector("input, select, textarea, button")?.focus();
  return { close, box };
}

// ------------------------------------------------------------------ forms
export function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, label), input, hint ? h("p", { class: "hint" }, hint) : null);
}

export const input = (attrs = {}) => h("input", { type: "text", ...attrs });

export function select(options, attrs = {}) {
  return h(
    "select",
    attrs,
    options.map((o) => (typeof o === "string" ? h("option", { value: o }, o) : h("option", { value: o.value, selected: o.selected }, o.label))),
  );
}

export function multiPicker(items, { label = (x) => x.name, empty = "Nothing to pick" } = {}) {
  const chosen = new Set();
  const list = h(
    "div",
    { class: "picker" },
    items.length
      ? items.map((it) =>
        h(
          "label",
          { class: "pick" },
          h("input", { type: "checkbox", onchange: (e) => (e.target.checked ? chosen.add(it.id) : chosen.delete(it.id)) }),
          h("span", {}, label(it)),
        )
      )
      : h("p", { class: "muted" }, empty),
  );
  return { el: list, values: () => [...chosen] };
}

export function emptyState(title, text, action) {
  return h("div", { class: "empty" }, h("h3", {}, title), h("p", {}, text), action ?? null);
}

/**
 * Filterable list — text search box + optional platform filter chips. Delegates
 * rendering to the caller via a render(item) callback so it works for pickers,
 * read-only lists, or lists with inline action buttons alike.
 *
 * Options:
 *   search(item): string used by the text filter (defaults to JSON of item)
 *   platformKey: field name on each item whose value is the platform string
 *   platforms: ordered list of {value, label} chips (empty = no platform filter)
 *   render(item): the DOM node for one row
 *   empty: text or node shown when the filtered list is empty
 *   onCountChange(n, total): optional callback whenever the visible count changes
 */
export function filterableList(items, {
  search = (x) => JSON.stringify(x).toLowerCase(),
  platformKey = null,
  platforms = [],
  render,
  empty = "Nothing to show",
  onCountChange = null,
} = {}) {
  const searchInput = h("input", { type: "search", placeholder: "Search…", "aria-label": "Search", class: "filter-search" });
  let platformFilter = "";
  const rowsBox = h("div", { class: "filter-rows" });
  const counter = h("span", { class: "muted small" }, "");

  const draw = () => {
    const q = searchInput.value.trim().toLowerCase();
    const visible = items.filter((it) =>
      (!q || search(it).toLowerCase().includes(q)) &&
      (!platformFilter || String(it[platformKey] ?? "") === platformFilter)
    );
    clear(rowsBox, visible.length ? visible.map(render) : h("p", { class: "muted" }, empty));
    counter.textContent = `${visible.length} of ${items.length}`;
    if (onCountChange) onCountChange(visible.length, items.length);
  };

  const chips = platforms.length
    ? h("div", { class: "filter-chips" },
      [{ value: "", label: "All" }, ...platforms].map((p) =>
        h("button", {
          type: "button",
          class: `chip`,
          "data-active": p.value === platformFilter ? "true" : "false",
          onclick: (e) => {
            platformFilter = p.value;
            for (const c of chips.querySelectorAll("[data-active]")) c.setAttribute("data-active", "false");
            e.currentTarget.setAttribute("data-active", "true");
            draw();
          },
        }, p.label)))
    : null;

  searchInput.addEventListener("input", draw);
  draw();
  return h("div", { class: "filterable-list" },
    h("div", { class: "filter-head" }, searchInput, counter),
    chips,
    rowsBox,
  );
}

export function loading() {
  return h("div", { class: "loading", "aria-busy": "true" }, "Loading…");
}

export function jsonBlock(obj) {
  return h("pre", { class: "json" }, JSON.stringify(obj ?? {}, null, 2));
}

// ------------------------------------------------------------------ icons
// Geometric, straight-line strokes on a 24px grid (brand iconography).
const ICONS = {
  overview: ["M3 3h7v9H3z", "M14 3h7v5h-7z", "M14 12h7v9h-7z", "M3 16h7v5H3z"],
  alerts: ["M12 3 2 21h20z", "M12 10v5", "M12 17.5v1"],
  locations: ["M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z", "M12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"],
  devices: ["M7 2h10v20H7z", "M11 18h2"],
  groups: ["M3 7h18v13H3z", "M3 7l2-3h6l2 3"],
  profiles: ["M4 3h12l4 4v14H4z", "M8 11h8", "M8 15h8", "M8 7h4"],
  announcements: ["M3 10v4h4l7 5V5L7 10z", "M18 9v6", "M21 7v10"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  settings: ["M4 6h10", "M18 6h2", "M4 12h4", "M12 12h8", "M4 18h12", "M20 18h0", "M14 4v4", "M8 10v4", "M16 16v4"],
  search: ["M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z", "M16 16l5 5"],
  sync: ["M20 7H8a5 5 0 0 0-5 5", "M17 4l3 3-3 3", "M4 17h12a5 5 0 0 0 5-5", "M7 20l-3-3 3-3"],
  menu: ["M3 6h18", "M3 12h18", "M3 18h18"],
  more: ["M4 12h2", "M11 12h2", "M18 12h2"],
  close: ["M5 5l14 14", "M19 5 5 19"],
  back: ["M15 5l-7 7 7 7"],
  chevron: ["M9 5l7 7-7 7"],
  logout: ["M10 4H4v16h6", "M14 8l4 4-4 4", "M18 12H9"],
  plus: ["M12 5v14", "M5 12h14"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
  check: ["M4 12l5 5L20 6"],
  shield: ["M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"],
};
export function icon(name, cls = "icon") {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

// ------------------------------------------------------------------ page structure
/** Page header: optional breadcrumb back-link, title, lede, actions. */
export function pageHeader(title, lede, actions = [], back) {
  return [
    back ? h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, h("a", { href: back.href }, icon("back"), back.label)) : null,
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, title), lede ? h("p", { class: "lede" }, lede) : null),
      actions.filter(Boolean).length ? h("div", { class: "page-actions" }, actions) : null,
    ),
  ];
}

/** Tab strip bound to a ?tab= query param. tabs: [{id,label}] */
export function tabStrip(tabs, active, onPick) {
  return h("div", { class: "tabs", role: "tablist" }, tabs.map((t) =>
    h("button", { class: t.id === active ? "tab active" : "tab", role: "tab", type: "button", "aria-selected": t.id === active ? "true" : "false", onclick: () => onPick(t.id) }, t.label, t.count ? h("span", { class: "nav-count" }, t.count) : null)
  ));
}

/**
 * Responsive table. columns: [{label, cell:(row)=>node, class?, primary?}]
 * On small screens rows stack into cards; each cell shows its column label.
 */
export function table(columns, rows, { empty = "Nothing here yet", rowAttrs } = {}) {
  if (!rows.length) return h("p", { class: "muted empty" }, empty);
  return h("div", { class: "table-wrap" }, h("table", { class: "responsive" },
    h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.class, scope: "col" }, c.label)))),
    h("tbody", {}, rows.map((r) => h("tr", rowAttrs ? rowAttrs(r) : {}, columns.map((c) =>
      h("td", { class: [c.class, c.primary ? "primary" : ""].filter(Boolean).join(" ") || undefined, "data-label": c.primary || c.class === "actions" || c.class === "check" ? "" : c.label }, c.cell(r))
    )))),
  ));
}

/** Make a hand-built <table> stack into cards on small screens (labels from <th>). */
export function responsive(tableEl, { primary = 0 } = {}) {
  tableEl.classList.add("responsive");
  const labels = [...tableEl.querySelectorAll("thead th")].map((th) => th.textContent);
  for (const tr of tableEl.querySelectorAll("tbody tr")) {
    [...tr.children].forEach((td, i) => {
      if (i === primary) td.classList.add("primary");
      td.setAttribute("data-label", i === primary || td.classList.contains("actions") ? "" : labels[i] ?? "");
    });
  }
  return tableEl;
}
