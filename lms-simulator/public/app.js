// LMS Simulator frontend — plain JS, no build step.
const TIERS = ["undisbursed", "disbursed", "due_2d", "overdue_2d", "locked", "released"];
const TIER_LABEL = {
  undisbursed: "Undisbursed", disbursed: "Disbursed", due_2d: "Due 2D",
  overdue_2d: "Overdue 2D", locked: "Locked", released: "Released",
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  return r.json();
}

function hook(id, type, extra = {}) { return api(`/api/phones/${id}/hook`, { type, ...extra }).then(render); }

function backendSummary(res) {
  if (!res) return "no reply";
  if (res.error) return `err: ${res.error}`;
  const d = res.data;
  if (!d) return "no data";
  if (d.error) return `${d.source || "?"} → ${d.error}`;
  const r = d.result;
  if (!r) return `${d.source || "?"} → null (unlinked or disabled)`;
  const first = r.decisions && r.decisions[0];
  const grp = first?.intendedGroupName ? ` · group=${first.intendedGroupName}` : (first?.note ? ` · ${first.note}` : "");
  const head = `${d.source || "?"} · ${r.trigger} · considered=${r.considered} changed=${r.changed}${r.held ? " HELD" : ""}${first ? ` · ${first.from ?? "∅"}→${first.to}` : ""}${grp}`;
  const a = r.applied;
  if (!a) return head;
  const skippedBits = Object.entries(a.skipped || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(",");
  const applyLine = ` · applied moved=${a.moved} announced=${a.announced}${a.errors ? ` err=${a.errors}` : ""}${skippedBits ? ` skip[${skippedBits}]` : ""}`;
  const o = (a.outcomes || [])[0];
  const targ = o?.targetGroup ? ` → ${o.targetGroup}` : "";
  const ann = o?.announcement ? ` + "${o.announcement}"` : "";
  return head + applyLine + targ + ann;
}

function phoneCard(p) {
  const tierIdx = TIERS.indexOf(p.tier);
  const ladder = h("div", { class: "mini-ladder" },
    TIERS.map((t, i) => h("span", { class: `dot ${t} ${i <= tierIdx ? "on" : ""} ${t === p.tier ? "cur" : ""}`, title: TIER_LABEL[t] })));

  const undis = p.tier === "undisbursed";
  const btns = [];
  if (undis) {
    btns.push(h("div", { class: "btn-row" },
      h("span", { class: "lbl" }, "Disburse:"),
      h("button", { class: "btn btn-sm", onclick: () => hook(p.id, "disburse", { productId: 1 }) }, "7-Day"),
      h("button", { class: "btn btn-sm", onclick: () => hook(p.id, "disburse", { productId: 2 }) }, "14-Day"),
      h("button", { class: "btn btn-sm", onclick: () => hook(p.id, "disburse", { productId: 3 }) }, "28-Day")));
  } else {
    btns.push(h("div", { class: "btn-row" },
      h("button", { class: "btn btn-sm", onclick: () => hook(p.id, "advance", { days: 1 }) }, "+1 day"),
      h("button", { class: "btn btn-sm", onclick: () => hook(p.id, "skip", { to: "due" }) }, "→ Due 2D"),
      h("button", { class: "btn btn-sm btn-warn", onclick: () => hook(p.id, "skip", { to: "overdue" }) }, "→ Overdue"),
      h("button", { class: "btn btn-sm btn-danger", onclick: () => hook(p.id, "skip", { to: "lock" }) }, "→ Lock")));
    btns.push(h("div", { class: "btn-row" },
      h("button", { class: "btn btn-sm btn-ok", onclick: () => hook(p.id, "repay") }, "Repay → Release"),
      h("button", { class: "btn btn-sm btn-ghost", onclick: () => hook(p.id, "reset") }, "Reset to stock")));
  }

  const livePill = p.live
    ? h("span", { class: "live-pill on", title: `loan_links row + signed webhook to backend\nexternal_id: ${p.externalId}` },
        `LIVE${p.loanId ? ` · ${p.loanId}` : ""}`)
    : h("span", { class: "live-pill off", title: "in-memory only, no backend call" }, "SIM");

  return h("div", { class: `card tier-${p.tier}` },
    h("div", { class: "card-head" },
      h("div", {},
        h("span", { class: `badge ${p.platform}` }, p.platform === "android" ? "Android" : "iPhone"),
        h("strong", { class: "pname" }, " " + p.name),
        p.platform === "ios"
          ? h("button", { class: "sup " + (p.supervised ? "on" : "off"), title: "toggle supervision", onclick: () => hook(p.id, "supervise") }, p.supervised ? "supervised" : "unsupervised")
          : null,
        livePill),
      h("button", { class: "x", title: "remove", onclick: () => api(`/api/phones/${p.id}/delete`, {}).then(render) }, "×")),
    h("div", { class: "tier-pill" }, TIER_LABEL[p.tier]),
    h("div", { class: "action" }, p.action),
    h("div", { class: "meta" },
      p.product ? `${p.product} · ` : "stock · ",
      p.loanStatus ? `day ${p.day} · DPD ${p.dpd}` : "no loan"),
    p.live && p.lastBackendResult
      ? h("div", { class: "backend-line", title: "last response from /api/fineract/hooks" }, backendSummary(p.lastBackendResult))
      : null,
    ladder,
    h("div", { class: "btns" }, btns));
}

function feedRow(s) {
  const tag = s.kind === "webhook" ? "HOOK" : s.kind === "timer" ? "TIMER" : "BACKEND";
  const extra = s.kind === "backend"
    ? h("span", { class: "flabel" }, backendSummary(s.backend))
    : h("span", { class: "flabel" }, s.label);
  return h("div", { class: `frow ${s.to} ${s.kind}` },
    h("span", { class: `tag ${s.kind}` }, tag),
    h("span", { class: "fphone" }, s.phone),
    h("span", { class: "fmove" }, `${TIER_LABEL[s.from]} → ${TIER_LABEL[s.to]}`),
    h("span", { class: "faction" }, s.action),
    extra);
}

function render(st) {
  (st && st.phones ? Promise.resolve(st) : api("/api/state")).then((s) => {
    // Mode pill
    const pill = document.getElementById("modePill");
    if (pill) {
      pill.classList.toggle("mode-on", !!s.live);
      pill.classList.toggle("mode-off", !s.live);
      pill.textContent = s.live ? `LIVE · ${s.backend}` : "OFFLINE";
      pill.title = s.live
        ? `enterprise=${s.enterprise}\nbackend=${s.backend}\nreal device picks go through loan_links + signed webhook`
        : "live mode disabled — set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FINERACT_WEBHOOK_SECRET in env";
    }
    const wrap = document.getElementById("phones");
    wrap.replaceChildren(...s.phones.map(phoneCard));
    if (!s.phones.length) wrap.append(h("p", { class: "muted pad" }, "No phones. Add one above."));
    const fd = document.getElementById("feed");
    fd.replaceChildren(...s.feed.map(feedRow));
    if (!s.feed.length) fd.append(h("p", { class: "muted" }, "No signals yet. Disburse a phone and advance it."));
  });
}

async function refreshDevicePicker() {
  const sel = document.getElementById("deviceSelect");
  if (!sel) return;
  const r = await api("/api/available-devices").catch(() => ({ devices: [] }));
  const devs = r.devices || [];
  sel.replaceChildren(
    h("option", { value: "" }, devs.length ? `— pick device (${devs.length}) —` : "— no live devices —"),
    ...devs.map((d) => {
      const label = `${d.platform === "ios" ? "iPhone" : "Android"} · ${d.device_name || d.id.slice(0, 8)}${d.serial_number ? ` · ${d.serial_number.slice(0, 10)}` : ""}`;
      return h("option", { value: d.id }, label);
    }),
  );
}

document.getElementById("addAndroid").onclick = () => api("/api/phones", { platform: "android" }).then(() => render());
document.getElementById("addIphone").onclick = () => api("/api/phones", { platform: "ios" }).then(() => render());
document.getElementById("addLive").onclick = async () => {
  const sel = document.getElementById("deviceSelect");
  const deviceId = sel && sel.value;
  if (!deviceId) { alert("pick a real device from the dropdown first"); return; }
  const r = await api("/api/phones", { deviceId });
  if (r && r.error) alert(r.error);
  render();
};
document.getElementById("resetAll").onclick = () => api("/api/reset-all", {}).then(render);

// static top ladder legend
const L = document.getElementById("ladder");
L.replaceChildren(...TIERS.map((t) => h("span", { class: `legend ${t}` }, TIER_LABEL[t])));

render();
refreshDevicePicker();
setInterval(() => render(), 2500);
setInterval(() => refreshDevicePicker(), 15000);
