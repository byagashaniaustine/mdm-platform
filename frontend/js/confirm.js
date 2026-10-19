// Step 2 of a destructive action (wipe, passcode reset/clear, group passcode reset).
// Step 1 created the request on the server (nothing sent to the phone yet).
// Here the admin types the identifier we show (serial tail or group name),
// so two phones with the same name can't be mixed up.
import { post } from "./api.js";
import { field, h, input, modal, toast, toastEvent } from "./ui.js";

/** Actions that must never appear in bulk pickers, whatever the server flags say. */
export const DESTRUCTIVE = new Set(["complete_wipe", "corporate_wipe", "reset_passcode", "clear_passcode"]);

/** Cancel the pending request if the dialog is closed without confirming (X, Escape, backdrop). */
function cancelOnClose(box, eventId, isDone) {
  const overlay = box.parentElement;
  const obs = new MutationObserver(() => {
    if (overlay.isConnected) return;
    obs.disconnect();
    if (!isDone()) post(`/api/events/${eventId}/cancel`, {}).then(() => toast("Request cancelled", "info")).catch(() => {});
  });
  obs.observe(document.body, { childList: true });
}

/**
 * res: response of the step-1 POST ({ data: { events, confirmation: { target } } }).
 * label: action name shown to the admin. onDone: called after a successful confirm.
 */
export function confirmDestructive(res, label, onDone) {
  const ev = res.data.events.find((e) => e.state === "awaiting_confirmation") ?? res.data.events[0];
  const t = res.data.confirmation?.target ?? {};
  const isGroup = t.kind === "group";
  // Labels come from field() below, matching what's on screen.
  const typed = input({ autocomplete: "off", spellcheck: "false" });
  let done = false;

  const identity = isGroup
    ? h("dl", { class: "facts confirm-target" },
      h("dt", {}, "Group"), h("dd", {}, t.name ?? "—"),
      h("dt", {}, "Devices"), h("dd", {}, String(t.devices ?? "—")))
    : h("dl", { class: "facts confirm-target" },
      h("dt", {}, "Device"), h("dd", {}, t.name ?? "—"),
      h("dt", {}, "Model"), h("dd", {}, `${t.model ?? "—"}${t.owned_by === "personal" ? " (personal)" : ""}`),
      h("dt", {}, "User"), h("dd", {}, t.user ?? "Unassigned"),
      h("dt", {}, t.tag_source ? `${t.tag_source[0].toUpperCase()}${t.tag_source.slice(1)} ends in` : "Ends in"), h("dd", {}, h("strong", { class: "mono" }, t.tag ?? "—")));

  const { box } = modal(`Confirm: ${label}`, h("div", { class: "stack" },
    h("p", {}, "Step 2 of 2. Check this is the right ", isGroup ? "group" : "phone", ":"),
    identity,
    field(isGroup ? "Type the group name" : `Type the last 4 characters of the ${t.tag_source ?? "serial number"} (${t.tag ?? ""})`, typed),
  ), [
    { label: "Cancel" },
    { label, tone: "danger", onClick: async () => {
      const r = await fetchConfirm(ev.id, typed.value);
      done = true;
      toastEvent(r, `${label} sent`);
      onDone?.(r);
    } },
  ]);
  cancelOnClose(box, ev.id, () => done);
  typed.focus();
}

function fetchConfirm(eventId, typed) {
  return post(`/api/commands/${eventId}/confirm`, { typed });
}
