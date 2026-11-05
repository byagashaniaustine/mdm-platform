// Loans page — Mapene (Fineract) loans awaiting disbursal, paired with an
// available-devices picker. One click does three things on the backend:
// stamp externalId on the Fineract loan, create the loan_links row, fire the
// disburse command. From that disburse onward the webhook pipeline takes
// over (onLoanEvent → reconcile → tier → Zoho group move).
import { get, post } from "../api.js";
import { clear, emptyState, h, loading, modal, pageHeader, select, table, toast, toastError } from "../ui.js";

export async function loansView(el, ctx) {
  clear(el, loading());
  const mountToken = Symbol("loans-view");
  el.__viewToken = mountToken;
  const admin = ctx.can("admin");

  const refreshBtn = h("button", { class: "btn", type: "button", onclick: () => loansView(el, ctx) }, "Refresh");
  const contentBox = h("div");
  clear(el,
    pageHeader(
      "Loans",
      "Approved applications from Mapene (Fineract) awaiting the device they'll run on. Picking a device links it, stamps the loan's externalId, and fires the disbursement in one step.",
      [refreshBtn],
    ),
    contentBox,
  );

  const renderContent = (loans, devices) => {
    if (!loans.length) {
      clear(contentBox, emptyState(
        "No pending loans",
        "When Mapene approves a loan it will appear here, ready to be linked to a phone.",
        refreshBtn,
      ));
      return;
    }
    const tbl = table([
      { label: "Loan", cell: (l) => h("div", { class: "stack" },
        h("strong", {}, `#${l.loanId}`),
        h("span", { class: "muted small" }, `acct ${l.accountNo}`),
      ), primary: true },
      { label: "Borrower", cell: (l) => h("div", { class: "stack" },
        h("span", {}, l.clientName ?? "—"),
        l.clientEmail ? h("span", { class: "muted small" }, l.clientEmail) : null,
        l.clientMobile ? h("span", { class: "muted small" }, l.clientMobile) : null,
      ) },
      { label: "Product", cell: (l) => h("div", { class: "stack" },
        h("span", {}, l.productName ?? `#${l.productId}`),
        h("span", { class: "muted small" }, fmtMoney(l.principal)),
      ) },
      { label: "Approved", cell: (l) => h("span", { class: "muted small" }, l.approvedOn ?? "—") },
      { label: "Device", cell: (l) => {
        if (!admin) return h("span", { class: "muted small" }, "admin only");
        return h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => pickDevice(l, devices, el, ctx) }, "Link & disburse");
      }, class: "right" },
    ], loans);
    clear(contentBox, tbl);
  };

  try {
    const [loans, devices] = await Promise.all([
      get("/api/loans/pending"),
      get("/api/loans/available-devices"),
    ]);
    if (el.__viewToken !== mountToken) return;
    renderContent(loans, devices);
  } catch (err) {
    toastError(err);
    clear(contentBox, emptyState("Could not load loans", String(err?.message ?? err), refreshBtn));
  }
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(n);
}

function pickDevice(loan, devices, el, ctx) {
  if (!devices.length) {
    modal("No available devices", h("p", { class: "muted" },
      "Every synced device is already tied to an active loan. Close an existing loan in Mapene or wait for Zoho to sync new devices."),
      [{ label: "Close" }]);
    return;
  }
  // Pre-select the device Fineract already stamped on the loan (if we matched it).
  const preferred = loan.prelinkedDeviceId ?? devices[0].id;
  const options = devices.map((d) => ({
    value: d.id,
    label: labelDevice(d),
    selected: d.id === preferred,
  }));
  const picker = select(options);
  const err = h("p", { class: "error small" });

  modal(`Link loan #${loan.loanId}`,
    h("div", { class: "stack" },
      h("p", { class: "muted" },
        "The chosen device's serial will be stamped on the Fineract loan as externalId, and the loan will be disbursed immediately. ",
        "The DISBURSE webhook will then move this device to the ", h("code", {}, "disbursed"), " tier."),
      h("label", { class: "stack" },
        h("span", {}, "Device"),
        picker,
      ),
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
          if (!deviceId) { err.textContent = "Pick a device."; return; }
          try {
            await post(`/api/loans/${encodeURIComponent(loan.loanId)}/link-and-disburse`,
              { device_id: deviceId, principal: loan.principal });
            toast(`Loan #${loan.loanId} disbursed`);
            close();
            loansView(el, ctx);
          } catch (e) {
            err.textContent = e?.message ?? String(e);
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
