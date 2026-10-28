# Loan-Driven Device Automation — Technical Development Spec

**Status:** Draft for implementation · **Audience:** Claude Code (developer) + reviewers (Harvey, Derick)
**Scope:** End-to-end automation that lets a borrower's loan state in **Fineract** drive device policy on **Zoho MDM**, orchestrated by this **MDM Console** (`mdm-platform`). Fully event-driven, no admin in the loop.

This document is the authoritative build plan. It assumes the current `mdm-platform` codebase (Deno + Hono + Supabase, plain-JS frontend) and the live Fineract instance snapshotted in [`FINERACT.md`](./FINERACT.md).

---

## 1. Business purpose (read this first)

The phone is the collateral. A customer buys a handset on credit; while they are repaying, the device is managed. If they fall behind, the device escalates through reminder → restriction → payment-only → lock. When they pay, it is released instantly. This is the **device-financing** model (M-KOPA / PayJoy class).

> **Hard scope rule.** The automation only ever acts on a device that is *financed and enrolled under a loan*. It must be structurally impossible for it to touch a personal/BYOD phone. See §11 (Guards) and §13 (Compliance). If this cannot be guaranteed, do not ship the locking tiers.

---

## 2. The three systems and who owns what

| System | Source of truth for | Role in this flow |
|---|---|---|
| **Fineract** (`api.fineract.bsa.ai`) | the **loan** — product, due date, days-past-due (DPD), paid/closed | emits events + answers reads; never talks to a phone |
| **MDM Console** (`mdm-platform`) | **policy** — loan-state→tier rule, command queue, confirmations, audit | the brain; decides and orchestrates. The **Bridge** lives here |
| **Zoho MDM** | the **device** — enrollment, group, command delivery, online/offline | applies profiles/commands; the Console reads it back to confirm |

The Console **decides** from Fineract state and **writes** to Zoho, then **reads Zoho back** to confirm. It never asks Zoho what to do.

### 2.1 What already exists in `mdm-platform` (reuse, do not rebuild)
- Device inventory synced from Zoho (`services/sync.ts`), groups (`services/groups.ts`), configuration profiles (`services/profiles.ts`, `zoho/payloads.ts`: Android + iOS restrictions / passcode / kiosk).
- Device command framework (`services/commands.ts`) with a full event state machine, queue, retries, two-step confirmation, offline polling (14-day), and Knox/supervision gating.
- Event engine (`services/events.ts`): `awaiting_confirmation → requested → sent → acknowledged → succeeded | failed | dead | cancelled`, with `registerExecutor(action, fn)`, `createEvent`, `processEvent`, idempotency keys.
- Cross-process **leases** (`lib/lease.ts`, `withLease`) so only one worker acts per enterprise.
- Background worker (`worker.ts`), activity/audit log, monitoring + alerts (`services/monitoring.ts`).
- Zoho REST client (`zoho/api.ts`, `zoho/client.ts`).

### 2.2 The real Fineract products (from `FINERACT.md`)
Three TZS single-balloon micro-loans — **one repayment, one due date** each:

| ID | Product | Term | Interest/term |
|---:|---|---:|---:|
| 1 | 7-Day Loan | 7 d | 12% |
| 2 | 14-Day Loan | 14 d | 15% |
| 3 | 28-Day Loan | 28 d | 18% |

Single-balloon means **DPD is computed from one due date**, not a schedule. All thresholds below are DPD on that date.

---

## 3. Design principles (non-negotiable)

1. **Tier = group; product = data.** The *tier* is the Zoho group and the only thing that changes device policy. The *product* only sets the DPD thresholds. Never make a group per product-stage.
2. **Event-driven, no admin.** Two trigger sources: Fineract webhooks (push) + a daily scheduled evaluator (time). No human clicks.
3. **Guards replace the human.** Removing the manual confirmation does not remove the safety — explicit automated guards do (blast-radius, fresh-payment recheck, financed-enrolled, kill-switch, idempotency). See §11.
4. **Only ever tighten after guards pass; release is unconditional and instant.** A payment event unlocks immediately; a tightening event must pass every guard.
5. **Idempotent reconcile.** The Bridge computes *desired* tier and converges the device to it. Re-running a trigger is safe.
6. **Reuse the event machine.** Every device-facing action is an `event` executed through `services/events.ts`, inheriting its queue/retry/offline/audit behavior.

---

## 4. Tier model

Five groups per platform (`android` / `ios`), the device occupies exactly one at a time:

```
UNDISBURSED → DISBURSED → DUE_2D → OVERDUE_2D → LOCKED        (→ RELEASED on payment → DISBURSED)
```

### 4.1 Per-tier device policy by platform

| Tier | Trigger | Android (company-owned) | iPhone (supervised) |
|---|---|---|---|
| `UNDISBURSED` | stock enrolled, no loan | baseline profile, full use | baseline, full use |
| `DISBURSED` | loan disbursed | full use | full use |
| `DUE_2D` | T-2 days before due | reminder announcement | reminder announcement |
| `OVERDUE_2D` | DPD ≥ k_soft | payment-only **kiosk** + block installs + notice | **restrictions** (block installs) + notice — *no kiosk in console yet; optionally lock early* |
| `LOCKED` | DPD ≥ L | `lock_device` + "Pay now" | `lock_device` + "Pay now" |
| `RELEASED` | loan closed | exit kiosk, drop restrictions, unlock → back to `DISBURSED`/stock | drop restrictions, unlock |

> **Platform caveats (already enforced in `commands.ts`):** Android app-restriction/kiosk needs **company-owned / fully managed**; iPhone restrictions/kiosk need **supervision (ABM)**. An **unsupervised iPhone** can only do reminder + lock. iPhone kiosk (single-app mode) is **not yet implemented** — either build it or accept iPhone `OVERDUE_2D` = restrict + optional early lock.

### 4.2 Per-product thresholds (default; confirm with Harvey)

| Product | DUE_2D lead | OVERDUE_2D (k_soft) | LOCKED (L) |
|---|---|---|---|
| 7-Day | T-2 | DPD 2 | DPD 5 |
| 14-Day | T-2 | DPD 2 | DPD 8 |
| 28-Day | T-2 | DPD 2 | DPD 15 |

Thresholds live **in the Bridge config** (one place, next to the tier logic), not scattered in Fineract.

---

## 5. Architecture

```
            ⚡ webhooks (disbursed/repaid/closed)         ┌───────────── MDM CONSOLE (mdm-platform) ─────────────┐
 FINERACT ───────────────────────────────────────────▶   │  routes/fineract.ts (webhook in)                     │
    ▲    ◀─── reads (loan state, DPD) ──────────────────  │  services/bridge/*  (the Bridge: new)                │
    │                                                      │    fineract.ts · tiers.ts · reconcile.ts · guards.ts │
    │         ⏱ daily evaluator (worker.ts + lease)        │  services/commands.ts · groups.ts · events.ts (reuse)│
    └──────────────────────────────────────────────────▶  └───────────────┬──────────────────────────────────────┘
                                                                           │ write: move group + commands / read back
                                                                           ▼
                                                                    ZOHO MDM ──▶ Android / iPhone
```

The Bridge is a **new set of modules inside the existing backend**, not a separate service. It reuses the Console's event engine, leases, Zoho client, and audit.

---

## 6. New code — file map

```
backend/
  services/bridge/
    fineract.ts        # Fineract REST client (auth, loan reads, DPD, delinquency)
    link.ts            # device ↔ loan mapping (store + lookup by externalId/serial)
    tiers.ts           # pure tier engine: (loan, product, today) -> Tier
    policy.ts          # Tier + platform -> { groupKey, events[] } mapping
    guards.ts          # guard gate (blast-radius, fresh-pay recheck, kill-switch, financed-enrolled)
    reconcile.ts       # desired-vs-actual convergence for one device; batch runner
    automation.ts      # orchestration entrypoints: onEvent(), dailyTick()
  routes/
    fineract.ts        # POST /api/fineract/hooks  (webhook ingress, signature-verified)
    automation.ts      # GET /api/automation/runs, POST /api/automation/kill-switch (owner), dashboards
  zoho/ (reuse)        # api.ts, payloads.ts
database/
  012_loan_automation.sql
tests/
  bridge_tier_test.ts  # unit: tier engine truth table (all 3 products × DPD range)
  e2e_automation.ts    # e2e: mock Fineract + mock Zoho, full lifecycle + guard trip
```

---

## 7. Data model — migration `012_loan_automation.sql`

All tables are enterprise-scoped with RLS, matching existing conventions.

```sql
-- 7.1 Device ↔ loan link (the linchpin). One active loan per device at a time.
create table loan_links (
  id              uuid primary key default gen_random_uuid(),
  enterprise_id   uuid not null references enterprises(id) on delete cascade,
  device_id       uuid not null references devices(id) on delete cascade,
  fineract_loan_id   text not null,          -- Fineract loan resourceId
  fineract_client_id text,
  external_id        text not null,          -- serial/IMEI stamped on the Fineract loan.externalId
  product_id         int  not null,          -- 1=7D 2=14D 3=28D
  disbursed_on       date,
  due_on             date,
  status             text not null default 'active',  -- active | closed | written_off
  closed_on          date,
  created_at      timestamptz not null default now(),
  unique (enterprise_id, device_id, status)  -- at most one active link per device
);
create index idx_loan_links_loan on loan_links(enterprise_id, fineract_loan_id);
create index idx_loan_links_ext  on loan_links(enterprise_id, external_id);

-- 7.2 Tier group registry: maps logical tier+platform -> the Zoho group used for it.
create table tier_groups (
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  tier          text not null,              -- undisbursed|disbursed|due_2d|overdue_2d|locked
  platform      text not null,              -- android | ios
  group_id      uuid not null references groups(id),
  primary key (enterprise_id, tier, platform)
);

-- 7.3 Current automation state per device (desired vs applied) for idempotent reconcile.
create table device_tier_state (
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  device_id     uuid not null references devices(id) on delete cascade,
  desired_tier  text,
  applied_tier  text,
  last_loan_dpd int,
  updated_at    timestamptz not null default now(),
  primary key (enterprise_id, device_id)
);

-- 7.4 Automation run log (every tick / webhook) + guard holds, for observability & the brake.
create table automation_runs (
  id            uuid primary key default gen_random_uuid(),
  enterprise_id uuid not null references enterprises(id) on delete cascade,
  trigger       text not null,              -- webhook:<event> | daily_tick | manual
  considered    int not null default 0,
  changed       int not null default 0,
  held          boolean not null default false,
  hold_reason   text,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

-- 7.5 Per-enterprise automation config + kill switch.
create table automation_settings (
  enterprise_id       uuid primary key references enterprises(id) on delete cascade,
  enabled             boolean not null default false,   -- master off by default
  dry_run             boolean not null default true,    -- Phase 0: log only, touch nothing
  max_changes_per_run int not null default 25,          -- blast-radius absolute cap
  max_pct_per_run     int not null default 20,          -- blast-radius percentage cap
  webhook_secret_enc  text,                             -- Fineract hook shared secret (encrypted)
  updated_at          timestamptz not null default now()
);
```

---

## 8. The tier engine (`services/bridge/tiers.ts`) — pure, unit-tested

```ts
export type Tier = "undisbursed" | "disbursed" | "due_2d" | "overdue_2d" | "locked" | "released";

export interface LoanState {
  status: "active" | "closed" | "written_off" | "overpaid";
  dueOn: string | null;      // ISO date of the single balloon due date
  dpd: number;               // days past due (0 if not yet due or paid)
  productId: number;
}

const TH: Record<number, { kSoft: number; L: number }> = {
  1: { kSoft: 2, L: 5 },   // 7-Day
  2: { kSoft: 2, L: 8 },   // 14-Day
  3: { kSoft: 2, L: 15 },  // 28-Day
};

export function tierFor(loan: LoanState, today: Date): Tier {
  if (loan.status === "closed" || loan.status === "overpaid") return "released";
  if (!loan.dueOn) return "disbursed";
  const daysToDue = Math.ceil((Date.parse(loan.dueOn) - today.getTime()) / 86_400_000);
  const t = TH[loan.productId] ?? { kSoft: 2, L: 7 };
  if (loan.dpd >= t.L) return "locked";
  if (loan.dpd >= t.kSoft) return "overdue_2d";
  if (loan.dpd >= 1) return "overdue_2d";        // any arrears => at least soft
  if (daysToDue <= 2) return "due_2d";
  return "disbursed";
}
```

The engine is **pure** (no I/O) so it can be exhaustively unit-tested across every product and DPD value.

---

## 9. Trigger ingestion

### 9.1 Fineract webhooks — `routes/fineract.ts`
`POST /api/fineract/hooks` receives Fineract "Hooks" callbacks. Steps:
1. Verify the shared-secret signature against `automation_settings.webhook_secret_enc`. Reject otherwise (401).
2. Parse entity/action. Map:
   - `LOAN` / `DISBURSE` → resolve loan link → `automation.onEvent(deviceId, "disbursed")`
   - `LOAN` / `REPAYMENT` or `CLOSE` → `automation.onEvent(deviceId, "repaid")`
3. Enqueue the work under the enterprise lease; return `200` fast (ack the hook, process async).

Webhooks are **optional-but-preferred**: they make payment/disburse instant. If a hook is missed, the daily tick (below) still converges the device.

### 9.2 Daily evaluator — extend `worker.ts`
A scheduled pass (`automation.dailyTick()`), guarded by `withLease("automation:<enterprise>")`:
1. Load all `loan_links` with `status='active'` for the enterprise.
2. For each, read loan state from Fineract (batch), compute DPD, run `tierFor`.
3. Hand the full desired-tier set to `reconcile.runBatch()` (§10), which applies the guard gate once for the whole batch (blast-radius) then converges each device.

The daily tick is what produces the **time-based** transitions (`DUE_2D`, `OVERDUE_2D`, `LOCKED`) — Fineract does not emit those as events.

---

## 10. Apply path & reconciliation (`reconcile.ts`)

For one device:
```
desired = tierFor(loanState, today)
current = device_tier_state.applied_tier
if desired == current: no-op
else:
  if !guards.pass(device, loan, desired, batchContext): record hold; skip
  else:
    {groupKey, events} = policy.for(desired, device.platform, loan)
    move device -> tier_groups[groupKey]            # reuse groups.ts
    for ev in events: createEvent(...) + processEvent # reuse events.ts/commands.ts
    device_tier_state.desired = desired; applied = desired (on confirm)
```

- **Reuse the event machine.** Each device action (announcement, restriction profile, kiosk, lock, unlock) is an `event` with an `idempotencyKey = "auto:<loan_id>:<desired_tier>"`, so retries and duplicate triggers never double-fire.
- **Release path** (`desired == released`): issue unlock / exit-kiosk / remove-restriction events, then move device to `DISBURSED` (or `UNDISBURSED` if the link is being closed). Must be **fast and unconditional**.
- **Offline devices:** inherited for free — the event sits `requested/sent` and the existing 14-day offline poll delivers it on next check-in. Lock applied to an offline phone simply waits.

---

## 11. Guards (`guards.ts`) — the automated replacement for human approval

Evaluated before any **tightening** move (`due_2d` is informational; `overdue_2d`/`locked` are gated). Release is never gated.

| Guard | Rule | On fail |
|---|---|---|
| **Financed + enrolled** | device has an `active` loan_link AND is enrolled & (Android company-owned / iPhone supervised) | skip device, log |
| **Fresh-payment recheck** | re-read the loan from Fineract < N seconds before locking; abort if `closed`/paid | skip device |
| **Blast-radius** | batch `changed` must be ≤ `max_changes_per_run` AND ≤ `max_pct_per_run` of active book | **HOLD whole batch**, raise alert, touch nothing |
| **Kill-switch** | `automation_settings.enabled = true` and not globally paused | skip all |
| **Dry-run** | if `dry_run=true`, compute and log the intended action, apply nothing | log only |
| **Idempotency** | event idempotency key not already applied | skip (already done) |

The **blast-radius HOLD** is the critical brake: a bad Fineract sync or clock bug that would move hundreds of devices stops and alerts instead of mass-locking. Record it in `automation_runs(held=true, hold_reason=...)` and via `monitoring.raiseAlert`.

A **kill-switch** endpoint (`POST /api/automation/kill-switch`, owner-only) flips `enabled=false` and halts all automation immediately.

---

## 12. Integration contracts

### 12.1 Fineract (`services/bridge/fineract.ts`)
- **Auth:** HTTP Basic (dedicated service user — *not* `mifos`) + header `Fineract-Platform-TenantId: default`, over TLS. Prefer OAuth2 token if enabled.
- **Reads:**
  - `GET /loans/{id}?associations=repaymentSchedule,summary` → `status`, `timeline.actualDisbursementDate`, repayment period `dueDate`, `summary.totalOverdue`, `summary.totalOutstanding`.
  - DPD: from the delinquency block if Delinquency Buckets are enabled, else `today − earliest unpaid dueDate`.
  - `GET /loans/external-id/{serial}` for reverse lookup (or keep the map in `loan_links`).
- **Hooks (set up in Fineract):** Admin → System → Configure Hooks → Web hook → events `LOAN/DISBURSE`, `LOAN/REPAYMENT`, `LOAN/CLOSE` → URL `https://<app>/api/fineract/hooks` with the shared secret.
- **Scheduler:** enable the **Update Loan Arrears Ageing** job (daily) so arrears are current.

### 12.2 Zoho (reuse `zoho/api.ts`, `zoho/payloads.ts`)
No new Zoho integration — the Bridge calls existing group-move and command/profile paths. Tier→action mapping (`policy.ts`) resolves to the same primitives already used by `commands.ts`/`groups.ts`.

### 12.3 Internal routes added
- `POST /api/fineract/hooks` — webhook ingress (signature-verified, public but authenticated by HMAC).
- `GET  /api/automation/runs` — recent `automation_runs` (admin).
- `GET  /api/automation/devices` — per-device desired/applied tier (admin).
- `POST /api/automation/kill-switch` — owner-only master stop.
- `POST /api/automation/settings` — owner-only (enabled, dry_run, caps, thresholds).

---

## 13. Security & compliance

**Security**
- Dedicated Fineract service user, least privilege (loan read + externalId write + hooks). Rotate the default `mifos`/`password`.
- Webhook HMAC secret stored encrypted (`automation_settings.webhook_secret_enc`), verified on every call.
- All device actions carry a `system-initiated` flag in the audit/activity log.
- Passcodes/secrets continue to use existing `lib/crypto.ts` encryption. Never log loan amounts or PII in device payloads.

**Compliance (business must own before locking tiers ship)**
- **Consent at signing** — the loan agreement must disclose exactly what happens on missed payment. With no human reviewer, this consent carries the entire legal weight.
- **Device-financing only** — enforced by the Financed+Enrolled guard; never a personal phone.
- **Proportionality** — these are small short-term loans; locking must be proportionate and disclosed (BOT fair-collection, Tanzania Data Protection Act 2022, **Google Play loan-app policy**).
- **Always-open payment path** — even at `LOCKED`, the dialer, mobile-money app and a "Pay now" screen remain reachable; emergency calls always work (OS guarantee).
- **Instant release** — automatic unlock within minutes of a payment posting.

---

## 14. Configuration (follow `config.ts` `env()`/`num()` pattern)

```
FINERACT_BASE_URL          # https://api.fineract.bsa.ai/fineract-provider/api/v1
FINERACT_TENANT_ID         # default
FINERACT_USERNAME          # svc-mdm-bridge   (NOT mifos)
FINERACT_PASSWORD_ENC      # or OAuth2 client creds; never commit plaintext
FINERACT_WEBHOOK_SECRET    # HMAC shared secret for /api/fineract/hooks
AUTOMATION_ENABLED         # master default (per-enterprise row overrides)
AUTOMATION_DRY_RUN         # default true until pilot sign-off
AUTOMATION_MAX_CHANGES     # default 25
AUTOMATION_MAX_PCT         # default 20
AUTOMATION_TICK_CRON       # daily evaluator schedule
```
`.env` is never committed (existing rule). Secrets are read via env and, where stored, encrypted at rest.

---

## 15. Failure handling & edge cases

| Case | Behavior |
|---|---|
| Device offline when a tier move fires | event waits (`requested/sent`); delivered on next Zoho check-in (existing 14-day poll) |
| Webhook dropped | daily tick reconciles the device the next run |
| Duplicate / replayed webhook | idempotency key makes the apply a no-op |
| Clock / timezone skew | compute DPD in a single fixed TZ (Africa/Dar_es_Salaam); never per-process local time |
| Loan paid seconds before a lock | fresh-payment guard aborts the lock |
| `overpaid` / early payoff | treated as `released` |
| `written_off` / repossession | manual, owner-confirmed path only — **not** automated |
| Partial apply (profile ok, command failed) | event machine retries; `applied_tier` only set on confirm |
| Bad batch (mass move) | blast-radius HOLD; nothing touched; alert raised |
| Enrollment downgraded (supervision lost) | guard fails financed+enrolled; device skipped, flagged |

---

## 16. Observability

- `automation_runs` row per trigger (considered / changed / held / reason).
- Reuse `monitoring.raiseAlert` for: blast-radius HOLD, repeated apply failures, Fineract unreachable, webhook signature failures.
- Structured logs via `lib/log.ts` (`automation.*` namespace).
- Admin screens: recent runs, per-device desired-vs-applied, kill-switch state.

---

## 17. Testing strategy

1. **Unit — tier engine** (`tests/bridge_tier_test.ts`): truth table across products 1–3 and DPD −3…+20; verify every transition and the released/overpaid cases. Pure, fast.
2. **Unit — guards:** blast-radius trip, fresh-payment abort, dry-run no-op, kill-switch.
3. **E2E** (`tests/e2e_automation.ts`, mirror existing e2e harness with mock Fineract + mock Zoho): full lifecycle for Android and iPhone — disburse → DUE_2D → OVERDUE_2D → LOCKED → pay → RELEASED; assert the correct Zoho group/commands at each step and that nothing hits the iPhone kiosk path.
4. **E2E — brake:** feed a batch that exceeds the cap; assert HOLD, alert raised, zero device actions.
5. **Simulation harness** (optional, offline): step a calendar over several seeded borrowers (on-time, delinquent-then-pays, offline device, iOS) and print the day-by-day tier timeline — for Harvey to review before any real device.

Acceptance for each phase requires type-check clean + all of the above green.

---

## 18. Requirements for the system to work (preconditions)

**Do not start the locking tiers until these hold.** Ownership in brackets.

### 18.1 Fineract side (Derick)
- [ ] `api.fineract.bsa.ai` **allowlisted** on the Black Swan egress policy (currently 403 — hard blocker).
- [ ] Dedicated **service user** with least-privilege role; default `mifos`/`password` rotated.
- [ ] Every loan carries **`externalId` = device serial/IMEI** at origination (null today).
- [ ] **Hooks** configured for DISBURSE / REPAYMENT / CLOSE → `/api/fineract/hooks` with secret.
- [ ] **Update Loan Arrears Ageing** scheduler job enabled.
- [ ] Thresholds agreed per product (or confirm the defaults in §4.2).

### 18.2 Enrollment / device side (ops + Harvey)
- [ ] Financed **Android** phones enrolled **company-owned / fully managed** (not personal/work-profile).
- [ ] Financed **iPhones** enrolled **supervised via Apple Business Manager**.
- [ ] Decision on iPhone `OVERDUE_2D`: build supervised single-app kiosk, or accept restrict + optional early lock.
- [ ] Phones auto-enroll into the `UNDISBURSED` group on first check-in.
- [ ] Point-of-sale/origination flow auto-creates the Fineract loan **and** stamps the device serial — so no admin "assign device" step is needed.

### 18.3 Platform (this repo)
- [ ] Migration `012_loan_automation.sql` applied.
- [ ] `tier_groups` populated: the 5 tiers × 2 platforms mapped to real Zoho groups, each carrying the right profile (baseline / reminder / restrict / kiosk / lock).
- [ ] Payment-always-open app set defined for kiosk (dialer + mobile-money + Pay-now).
- [ ] `automation_settings` row per enterprise, starting `enabled=false, dry_run=true`.

### 18.4 Legal / business (Harvey + compliance)
- [ ] Borrower **consent** language in the loan agreement.
- [ ] Confirmed this is **device financing** (phone = financed asset), proportionate, and cleared against BOT fair-collection, Tanzania DPA 2022, and Google Play loan-app policy.

---

## 19. Delivery phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| **0 — Wiring (dry-run)** | Fineract client, `loan_links`, tier engine, daily tick + webhook ingress, **log-only** (no device actions) | runs unattended for 1 week, `automation_runs` show correct intended tiers vs real arrears |
| **1 — Soft tiers** | DUE_2D reminders live | reminders fire at T-2 per product |
| **2 — Enforcement + release** | OVERDUE_2D (kiosk/restrict) + LOCKED + instant RELEASE, with all guards | pilot batch; blast-radius + fresh-pay guards proven; auto-release < few min |
| **3 — Rollout** | enable per enterprise, remove dry-run | monitoring + kill-switch validated |

---

## 20. Open decisions for Harvey & Derick
1. Confirm per-product DPD thresholds (§4.2) or set via `graceOnArrearsAgeing` in Fineract.
2. iPhone `OVERDUE_2D`: build supervised kiosk now, or restrict-then-lock?
3. Where does the Bridge run — inside `mdm-platform` (recommended) or a separate worker deployment?
4. Blast-radius caps (`max_changes_per_run`, `max_pct_per_run`) starting values.
5. Is the point-of-sale/origination system able to stamp `externalId` automatically, or is a thin enrollment UI needed first?

---

*This spec is implementation-ready once §18.1–18.4 are satisfied. Build order follows §19; every device action routes through the existing `services/events.ts` machine, so queue/retry/offline/audit behavior is inherited, not reinvented.*
