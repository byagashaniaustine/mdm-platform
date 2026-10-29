# LMS Simulator

A standalone Deno app that mimics **Fineract** driving device tiers, so you can push each
Android / iPhone through all six device tiers from a web UI — without touching a real device,
Zoho, or the live Fineract. It's a demo / teaching rig for the loan→device automation
described in [`../LOAN_DEVICE_AUTOMATION.md`](../LOAN_DEVICE_AUTOMATION.md).

## Run

```bash
deno run --allow-net --allow-read lms-simulator/server.ts
# open http://localhost:8010   (set SIM_PORT to change)
```

No dependencies, no build step — plain `Deno.serve` + static files.

## What it does

- **Add phones** (Android / iPhone) — iPhone has a supervised/unsupervised toggle.
- Per phone, **click buttons** to feed LMS conditions:
  - **Disburse 7D / 14D / 28D** — a Fineract `DISBURSE` hook; phone → `Disbursed`.
  - **+1 day / → Due 2D / → Overdue / → Lock** — timer ticks; the tier is recomputed from
    days-past-due, exactly like the real daily evaluator.
  - **Repay → Release** — a Fineract `REPAYMENT`/`CLOSE` hook; phone unlocks instantly.
  - **Reset to stock** — back to `Undisbursed`.
- The **signal feed** shows every tier change the LMS signalled, tagged **HOOK** (Fineract
  webhook) or **TIMER** (time-based tick), with the device action and the raw payload label.

## The six tiers

`Undisbursed → Disbursed → Due 2D → Overdue 2D → Locked` (→ `Released` on payment).
Android `Overdue 2D` = payment-only kiosk + block installs; iPhone (supervised) = restrictions
+ notice (no kiosk yet); unsupervised iPhone = announcement only. Lock + release work on both.

## Important

- `server.ts` holds the tier engine (`tierFor`) — **identical logic** to the spec's
  `services/bridge/tiers.ts`, so this is the real decision code, not a mock-up of it.
- State is **in-memory** — restarting the server resets everything. This is a simulator only;
  it never calls Zoho, the console, or Fineract.

## Thresholds (per product)

| Product | Due-soon | Overdue 2D | Locked |
|---|---|---|---|
| 7-Day | T-2 | DPD 2 | DPD 5 |
| 14-Day | T-2 | DPD 2 | DPD 8 |
| 28-Day | T-2 | DPD 2 | DPD 15 |
