# Fineract — `api.fineract.bsa.ai`

Snapshot of the Fineract core-banking instance for the Black Swan Analytics (`bsa.ai`) organisation, taken 2026-10-28.

- **Base URL:** `https://api.fineract.bsa.ai/fineract-provider/api/v1`
- **Tenant:** `default` (header `Fineract-Platform-TenantId: default`)
- **Auth:** HTTP Basic (service account `mifos`)
- **Operational currency:** TZS (Tanzanian Shilling). USD is also enabled at the platform level but no product uses it yet.

## Contents at a glance

| Resource | Count | Notes |
|---|---:|---|
| Offices | 1 | Head Office only (opened 2009-01-01). |
| Clients | 2 | Both active, both under Head Office. |
| Loans | 3 | All closed with obligations met. |
| Loan products | **3** | All active, TZS, short-term single-repayment — detailed below. |
| Users | 4 | 3 Super users + 1 `system` account. |
| Roles | 2 | Super user (enabled), Self Service User (disabled). |
| Codes | 39 | Standard Fineract code tables. |
| Charges | 0 | No fees/penalties defined. |
| Staff / Groups / Centers | 0 | Not used. |
| Savings accounts / products | 0 | Savings module not configured. |

## Loan products

All three products share the same shape — a single-balloon-payment micro-loan in TZS, differing only in term and interest rate per term. Common settings:

- Status: `loanProduct.active`
- Currency: **TZS** (2 decimal places)
- Principal: min **1,000** / default **50,000** / max **1,000,000**
- Number of repayments: **1** (single balloon)
- Amortisation: Equal installments
- Interest type: Declining Balance
- Interest calculation period: Same as repayment period
- Interest rate frequency: Whole term
- Days in month / year: Actual / 365
- Accounting rule: **NONE** (no GL postings)
- Transaction processing strategy: *Penalties, Fees, Interest, Principal order*
- Charges attached: none
- Floating interest, interest recalculation, variable installments, topup, borrower cycle: all **off**

Per-product differences:

| ID | Name | Short | Term | Interest / term | Effective APR* |
|---:|---|---|---:|---:|---:|
| 1 | 7-Day Loan  | 7DL  | 7 days  | 12% | ~626% |
| 2 | 14-Day Loan | 14DL | 14 days | 15% | ~391% |
| 3 | 28-Day Loan | 28DL | 28 days | 18% | ~235% |

<small>*APR is informational only — `(1 + rate)^(365/term) − 1`, compounded; Fineract itself quotes the rate as "whole term" and does not surface an annualised figure.</small>

### Permitted per-loan overrides

Each product allows the following attributes to be overridden on individual loan accounts (admin UI exposes these as per-loan fields):

`amortizationType`, `interestType`, `transactionProcessingStrategyCode`, `interestCalculationPeriodType`, `inArrearsTolerance`, `repaymentEvery`, `graceOnPrincipalAndInterestPayment`, `graceOnArrearsAgeing`.

### What's **not** configured on any product

- No fund source (`fundName: null`)
- No external id
- No start / close date restrictions
- No grace periods (principal / interest / interest charged / arrears ageing all `null`)
- No overdue-days-for-NPA threshold
- No linked charges
- No GL accounting mapping (accounting rule is `NONE`, so disbursements and repayments don't post to any ledger)

## Offices

| ID | Name | Opened | Hierarchy |
|---:|---|---|---|
| 1 | Head Office | 2009-01-01 | `.` |

## Clients

| ID | Name | Office | Mobile | Active |
|---:|---|---|---|:---:|
| 1 | Harvey Kadyanji | Head Office | 255744174923 | ✓ |
| 2 | Derick Kazimoto | Head Office | 255756339626 | ✓ |

## Loans

All three disbursed, all closed (obligations met), none in arrears.

| ID | Account # | Client | Product | Principal (TZS) | Status |
|---:|---|---|---|---:|---|
| 1 | 000000001 | Harvey Kadyanji | 7-Day Loan  | 1,400 | Closed (obligations met) |
| 2 | 000000002 | Harvey Kadyanji | 7-Day Loan  | 1,300 | Closed (obligations met) |
| 3 | 000000003 | Derick Kazimoto | 14-Day Loan | 1,000 | Closed (obligations met) |

## Users

| ID | Username | Name | Email | Office | Roles |
|---:|---|---|---|---|---|
| 1 | `mifos`        | App Administrator | demomfi@mifos.org | Head Office | Super user |
| 2 | `system`       | system            | demomfi@mifos.org | Head Office | *(none)* |
| 3 | `interopUser`  | Interop User      | email@email.com   | Head Office | Super user |
| 4 | `hkadyanji`    | Harvey Kadyanji   | harvey@bsa.ai     | Head Office | Super user |

## Roles

| ID | Name | Enabled | Description |
|---:|---|:---:|---|
| 1 | Super user         | ✓ | Grants every application permission. |
| 2 | Self Service User  | ✗ | For client-facing self-service portal; currently disabled. |

## Currencies

- **Selected (available for new products / accounts):** USD only.
- **Platform-enabled (recognised in the DB but not in the selected list):** TZS — the Tanzanian Shilling, which all three live loan products actually use. If someone creates a new TZS product today the UI picker will not show it until TZS is added to `selectedCurrencyOptions` via `PUT /currencies`.

## Operational notes / observations

- **All loan activity is historical.** No active loans, no savings, no fees — this instance is a sandbox or a very early-stage deployment.
- **Accounting is effectively disabled.** Every product has `accountingRule: NONE`, so none of the disbursements or repayments produced GL journal entries. If accounting is expected downstream, products need to be re-mapped to Cash-based or Accrual-based.
- **The currency picker is misconfigured.** TZS is the real operating currency but isn't in `selectedCurrencyOptions` — only USD is. Admins creating new products through the stock UI will see USD by default.
- **`/chargesproducts` is not a real endpoint** — the correct path is `/charges` (which is currently empty).
