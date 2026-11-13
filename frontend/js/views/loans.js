// Loans page — every loan (pending / active / overdue / closed) in a single
// table with colored status tags. Row click opens a detail modal with the
// full repayment schedule and lock-event history. Pending rows keep the
// original "Link & disburse" path accessible from the detail modal.
import { get, post } from "../api.js";
import { badge, clear, emptyState, field, h, input, loading, modal, pageHeader, select, table, toast, toastError } from "../ui.js";

export async function loansView(el, ctx) {
  clear(el, loading());
  const mountToken = Symbol("loans-view");
  el.__viewToken = mountToken;

  const refresh = () => loansView(el, ctx);
  const admin = ctx.can("admin");
  const refreshBtn = h("button", { class: "btn", type: "button", onclick: refresh }, "Refresh");
  const createBtn = admin
    ? h("button", { class: "btn btn-primary", type: "button", onclick: () => openCreateLoan(el, ctx) }, "+ New loan")
    : null;
  const contentBox = h("div");
  clear(el,
    pageHeader(
      "Loans",
      "Loans you've created for this enterprise. Pending rows need a device linked and a disbursal; active rows show live repayment progress and days overdue.",
      [createBtn, refreshBtn].filter(Boolean),
    ),
    contentBox,
  );

  try {
    const payload = await get("/api/loans/all");
    if (el.__viewToken !== mountToken) return;
    const rows = payload?.rows ?? [];
    if (!rows.length) {
      clear(contentBox,
        emptyState(
          "No loans yet",
          admin
            ? "Click + New loan to pick a client and loan product. The loan is created in Mapene and approved immediately; you then link it to a device and disburse."
            : "Ask an admin to create a loan for this enterprise.",
          createBtn ?? refreshBtn,
        ),
      );
      return;
    }
    rows.sort(sortForDisplay);
    const tbl = table(
      [
        { label: "Status", cell: (l) => statusTag(l), class: "status" },
        {
          label: "Borrower",
          cell: (l) => h("div", { class: "stack" },
            h("strong", {}, l.clientName ?? "—"),
            l.clientMobile ? h("span", { class: "muted small" }, l.clientMobile) : null,
            h("span", { class: "muted small" }, `Loan #${l.loanId}`),
          ),
          primary: true,
        },
        {
          label: "Device",
          cell: (l) => l.device
            ? h("div", { class: "stack" },
                h("span", {}, l.device.name || l.device.model || "—"),
                l.device.imei ? h("span", { class: "muted small" }, `IMEI ${maskImei(l.device.imei)}`) : null,
              )
            : h("span", { class: "muted small" }, "not linked"),
        },
        {
          label: "Disbursed",
          cell: (l) => h("span", { class: "muted small" }, l.disbursedOn ?? "—"),
        },
        {
          label: "Next payment",
          cell: (l) => h("div", { class: "stack" },
            h("span", {}, l.dueOn ?? "—"),
            l.nextInstallmentAmount > 0 ? h("span", { class: "muted small" }, fmtMoney(l.nextInstallmentAmount)) : null,
          ),
        },
        {
          label: "Final due",
          cell: (l) => h("span", { class: "muted small" }, l.finalDueOn ?? "—"),
        },
        {
          label: "% paid",
          cell: (l) => progressCell(l),
        },
        {
          label: "Outstanding",
          cell: (l) => h("span", {}, fmtMoney(l.totalOutstanding)),
          class: "right",
        },
      ],
      rows,
      {
        rowAttrs: (l) => ({
          class: "clickable",
          role: "button",
          tabindex: "0",
          onclick: () => openDetail(l, el, ctx),
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(l, el, ctx); } },
        }),
      },
    );
    clear(contentBox, tbl);
  } catch (err) {
    toastError(err);
    clear(contentBox, emptyState("Could not load loans", String(err?.message ?? err), refreshBtn));
  }
}

const STATUS_TONE = {
  active: "ok",
  overdue: "bad",
  pending: "warn",
  closed: "muted",
  written_off: "bad",
  overpaid: "info",
  unknown: "muted",
};
const STATUS_LABEL = {
  active: "Active",
  overdue: "Past due",
  pending: "Pending",
  closed: "Repaid",
  written_off: "Written off",
  overpaid: "Overpaid",
  unknown: "—",
};

// ----------------------------------------------------- Create loan (admin UI)
// Two-step modal:
//   1. First render loads clients + products from Fineract in parallel;
//      renders a form once both resolve.
//   2. Submit → POST /api/loans/create → the new loan appears in Pending; the
//      admin then clicks the row and uses the existing Link & disburse flow.
async function openCreateLoan(el, ctx) {
  const body = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading clients and products…"));
  const { close } = modal("New loan", body, [{ label: "Cancel" }]);
  try {
    const [clients, products] = await Promise.all([
      get("/api/loans/clients"),
      get("/api/loans/products"),
    ]);
    if (!clients.length) {
      clear(body, h("p", { class: "muted" }, "No active Mapene clients. Create a client in Mapene first."));
      return;
    }
    if (!products.length) {
      clear(body, h("p", { class: "muted" }, "No loan products configured in Mapene. Add at least one product first."));
      return;
    }
    renderCreateLoanForm(body, clients, products, async (payload) => {
      try {
        const res = await post("/api/loans/create", payload);
        toast(`Loan #${res?.data?.loanId ?? "?"} created — ready to link + disburse.`);
        close();
        loansView(el, ctx);
      } catch (err) {
        toastError(err);
      }
    });
  } catch (err) {
    clear(body, h("p", { class: "error" }, err?.message ?? String(err)));
  }
}

function renderCreateLoanForm(body, clients, products, onSubmit) {
  const clientSel = select(
    clients.map((c) => ({ value: c.id, label: c.mobileNo ? `${c.displayName} · ${c.mobileNo}` : c.displayName })),
  );
  const productSel = select(products.map((p) => ({ value: String(p.id), label: productLabel(p) })));
  const principalInp = input({ type: "number", step: "1", min: "0", placeholder: "e.g. 2500000" });
  const dateInp = input({ type: "date", value: todayISO() });

  const bounds = h("p", { class: "hint" }, "");
  const updateBounds = () => {
    const p = products.find((x) => String(x.id) === productSel.value);
    if (!p) { bounds.textContent = ""; return; }
    const parts = [];
    if (p.minPrincipal != null) parts.push(`min ${fmtMoney(p.minPrincipal)}`);
    if (p.maxPrincipal != null) parts.push(`max ${fmtMoney(p.maxPrincipal)}`);
    if (p.defaultPrincipal != null && !principalInp.value) principalInp.value = String(p.defaultPrincipal);
    bounds.textContent = parts.length
      ? `${p.currencyCode ?? ""} · ${parts.join(" · ")} · ${p.numberOfRepayments ?? "—"} × every ${p.repaymentEvery ?? 1} ${p.repaymentFrequencyLabel ?? ""}`.trim()
      : "";
  };
  productSel.addEventListener("change", updateBounds);
  queueMicrotask(updateBounds);

  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Create loan");
  const form = h("form", {
    class: "stack",
    onsubmit: (e) => {
      e.preventDefault();
      submit.disabled = true;
      submit.textContent = "Creating…";
      const payload = {
        client_id: clientSel.value,
        product_id: Number(productSel.value),
        principal: Number(principalInp.value),
        expected_disbursement_on: dateInp.value,
      };
      onSubmit(payload).finally(() => {
        submit.disabled = false;
        submit.textContent = "Create loan";
      });
    },
  },
    field("Borrower", clientSel),
    field("Loan product", productSel, bounds),
    field("Principal", principalInp, h("span", {}, "The amount financed, before interest.")),
    field("Expected disbursement date", dateInp),
    h("div", { class: "actions", style: "justify-content:flex-end;gap:8px" }, submit),
  );
  clear(body, form);
}

function productLabel(p) {
  const freq = p.repaymentFrequencyLabel ?? "";
  const terms = p.numberOfRepayments != null ? `${p.numberOfRepayments}×` : "";
  const bits = [p.name];
  if (terms || freq) bits.push(`${terms} ${freq}`.trim());
  return bits.filter(Boolean).join(" · ");
}

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function statusTag(loan) {
  const tone = STATUS_TONE[loan.trackingStatus] ?? "muted";
  const label = STATUS_LABEL[loan.trackingStatus] ?? loan.trackingStatus;
  if (loan.trackingStatus === "overdue" && loan.dpd > 0) {
    return badge(`${label} · ${loan.dpd}d`, tone);
  }
  return badge(label, tone);
}

function progressCell(loan) {
  const pct = Math.max(0, Math.min(100, Number(loan.percentRepaid) || 0));
  const bar = h("div", { class: "progress", "aria-hidden": "true" }, h("span", { style: `width:${pct}%` }));
  return h("div", { class: "stack", style: "gap:4px" },
    h("span", { class: "small" }, `${pct}%`),
    bar,
  );
}

function sortForDisplay(a, b) {
  // Order: overdue first (loudest), then pending (action needed), then active, then closed/written-off.
  const rank = { overdue: 0, pending: 1, active: 2, overpaid: 3, closed: 4, written_off: 5, unknown: 6 };
  const ra = rank[a.trackingStatus] ?? 9;
  const rb = rank[b.trackingStatus] ?? 9;
  if (ra !== rb) return ra - rb;
  // Within overdue: most days past due first.
  if (a.trackingStatus === "overdue") return b.dpd - a.dpd;
  // Within active: soonest due first.
  if (a.trackingStatus === "active") return (a.dueOn ?? "").localeCompare(b.dueOn ?? "");
  return 0;
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(n);
}

function maskImei(imei) {
  if (!imei) return "—";
  const s = String(imei);
  if (s.length <= 6) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// ------------------------------------------------------------ detail modal
async function openDetail(row, el, ctx) {
  const body = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading loan detail…"));
  const admin = ctx.can("admin");
  const actions = row.trackingStatus === "pending" && admin
    ? [
        { label: "Close" },
        {
          label: "Link & disburse",
          tone: "primary",
          onClick: async (close) => { close(); pickDeviceForPending(row, el, ctx); },
        },
      ]
    : [{ label: "Close" }];
  modal(`Loan #${row.loanId} · ${row.clientName ?? "—"}`, body, actions);
  try {
    const detail = await get(`/api/loans/${encodeURIComponent(row.loanId)}/detail`);
    clear(body, renderDetail(detail));
  } catch (err) {
    clear(body, h("p", { class: "error" }, err?.message ?? String(err)));
  }
}

function renderDetail(d) {
  const pct = Math.max(0, Math.min(100, Number(d.percentRepaid) || 0));
  return h("div", { class: "stack" },
    // Header summary row
    h("div", { class: "stack" },
      statusTag(d),
      h("p", { class: "muted small", style: "margin:4px 0 0" },
        d.productName ? `${d.productName} · ` : "",
        d.accountNo ? `account ${d.accountNo}` : "",
      ),
    ),

    // Customer + device two-column
    h("div", { class: "grid-2" },
      panel("Customer", [
        kv("Name", d.clientName ?? "—"),
        kv("Phone", d.clientMobile ?? "—"),
        kv("Email", d.clientEmail ?? "—"),
      ]),
      panel("Device", d.device
        ? [
            kv("Model", d.device.model || d.device.name || "—"),
            kv("IMEI", d.device.imei ? maskImei(d.device.imei) : "—"),
            kv("Serial", d.device.serialNumber ?? "—"),
            kv("Platform", d.device.platform ?? "—"),
            h("a", {
              class: "btn-link",
              href: `#/devices/${d.device.id}`,
            }, "Open device page →"),
          ]
        : [h("p", { class: "muted small" }, "Not linked yet.")]),
    ),

    // Financial summary
    panel("Repayment", [
      kv("Disbursed on", d.disbursedOn ?? "—"),
      kv("Principal", fmtMoney(d.principalDisbursed)),
      kv("Paid to date", fmtMoney(d.totalRepaid)),
      kv("Outstanding", fmtMoney(d.totalOutstanding)),
      kv("Next payment", d.dueOn ? `${d.dueOn} · ${fmtMoney(d.nextInstallmentAmount)}` : "—"),
      kv("Final due", d.finalDueOn ?? "—"),
      h("div", { class: "stack", style: "gap:6px;margin-top:8px" },
        h("div", { class: "muted small" }, `${pct}% repaid`),
        h("div", { class: "progress" }, h("span", { style: `width:${pct}%` })),
      ),
    ]),

    // Reconciliation — Mapene loan state vs device tier vs MalipoPay
    d.reconciliation?.length ? panel("Reconciliation", [renderReconciliation(d.reconciliation, d.tierState)]) : null,

    // Schedule
    d.schedule?.length ? panel("Schedule", [renderSchedule(d.schedule)]) : null,

    // Lock events
    d.lockEvents?.length
      ? panel("Lock history", [renderLockEvents(d.lockEvents)])
      : panel("Lock history", [h("p", { class: "muted small" }, "No lock or unlock events yet.")]),
  );
}

const RECON_TONE = { ok: "ok", warn: "warn", mismatch: "bad", pending: "muted" };
const RECON_LABEL = { ok: "OK", warn: "Drift", mismatch: "Mismatch", pending: "Pending" };

function renderReconciliation(checks, tierState) {
  const header = tierState
    ? h("p", { class: "muted small" },
        `Desired tier: ${tierState.desiredTier ?? "—"} · Applied: ${tierState.appliedTier ?? "—"} · Zoho observes: ${tierState.observedState ?? "—"}`,
        tierState.observedAt ? h("span", {}, ` · last checked ${tierState.observedAt}`) : null,
      )
    : null;
  const list = h("ul", { class: "list", style: "margin-top:4px" },
    checks.map((c) => h("li", {},
      h("div", { class: "stack", style: "gap:2px;flex:1;min-width:0" },
        h("strong", {}, c.check),
        h("span", { class: "muted small" }, c.detail),
      ),
      badge(RECON_LABEL[c.state] ?? c.state, RECON_TONE[c.state] ?? "muted"),
    )),
  );
  return h("div", { class: "stack" }, header, list);
}

function renderSchedule(schedule) {
  return table(
    [
      { label: "#", cell: (p) => h("span", {}, String(p.period)) },
      { label: "Due", cell: (p) => h("span", {}, p.dueDate ?? "—") },
      { label: "Total due", cell: (p) => h("span", {}, fmtMoney(p.totalDue)) },
      { label: "Paid", cell: (p) => h("span", {}, fmtMoney(p.totalPaid)) },
      { label: "Outstanding", cell: (p) => h("span", {}, fmtMoney(p.outstanding)) },
      {
        label: "State",
        cell: (p) => p.complete
          ? badge("Paid", "ok")
          : (p.daysOverdue > 0 ? badge(`${p.daysOverdue}d late`, "bad") : badge("Upcoming", "muted")),
      },
    ],
    schedule,
    { empty: "No schedule yet." },
  );
}

function renderLockEvents(events) {
  return table(
    [
      { label: "When", cell: (e) => h("span", { class: "small muted" }, e.actionTime ?? "—") },
      { label: "Action", cell: (e) => h("span", {}, e.action.replace(/^device\./, "")) },
      { label: "State", cell: (e) => badge(e.state, stateTone(e.state)) },
      {
        label: "Detail",
        cell: (e) => e.errorMessage
          ? h("span", { class: "muted small" }, e.errorMessage)
          : h("span", { class: "muted small" }, e.completedAt ?? ""),
      },
    ],
    events,
    { empty: "No lock events." },
  );
}

function stateTone(state) {
  if (state === "succeeded" || state === "acknowledged") return "ok";
  if (state === "failed" || state === "dead") return "bad";
  if (state === "requested" || state === "sent" || state === "awaiting_confirmation") return "warn";
  return "muted";
}

function panel(title, children) {
  return h("div", { class: "panel stack" },
    h("h3", { class: "panel-head" }, title),
    ...children,
  );
}

function kv(label, value) {
  return h("div", { class: "kv" },
    h("span", { class: "muted small" }, label),
    h("span", {}, value),
  );
}

// ---------------------------------------------------- pending → disburse flow
async function pickDeviceForPending(loan, el, ctx) {
  let devices = [];
  try {
    devices = await get("/api/loans/available-devices");
  } catch (err) {
    toastError(err);
    return;
  }
  if (!devices.length) {
    modal("No available devices",
      h("p", { class: "muted" }, "Every synced device is already tied to an active loan. Close an existing loan or wait for Zoho to sync new devices."),
      [{ label: "Close" }]);
    return;
  }
  const options = devices.map((d) => ({
    value: d.id,
    label: labelDevice(d),
  }));
  const picker = select(options);
  const err = h("p", { class: "error small" });
  modal(`Link loan #${loan.loanId}`,
    h("div", { class: "stack" },
      h("p", { class: "muted" },
        "The chosen device's serial will be stamped on the Fineract loan as externalId, and the loan will be disbursed immediately."),
      h("label", { class: "stack" }, h("span", {}, "Device"), picker),
      err,
    ),
    [
      { label: "Cancel" },
      {
        label: "Link & disburse",
        tone: "primary",
        onClick: async (close) => {
          err.textContent = "";
          const deviceId = picker.value;
          if (!deviceId) { err.textContent = "Pick a device."; return true; }
          try {
            await post(`/api/loans/${encodeURIComponent(loan.loanId)}/link-and-disburse`,
              { device_id: deviceId, principal: loan.principalDisbursed || loan.totalOutstanding });
            toast(`Loan #${loan.loanId} disbursed`);
            close();
            loansView(el, ctx);
          } catch (e) {
            err.textContent = e?.message ?? String(e);
            return true;
          }
        },
      },
    ],
  );
}

function labelDevice(d) {
  const name = d.device_name || d.model || "Device";
  const platform = d.platform ? ` · ${d.platform}` : "";
  const user = d.assigned_user_name ? ` · ${d.assigned_user_name}` : "";
  const sn = d.serial_number ? ` (SN ${d.serial_number.slice(0, 10)})` : "";
  return `${name}${platform}${user}${sn}`;
}
