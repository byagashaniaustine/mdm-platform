// Tiny in-memory circuit breaker. Protects the backend from piling up slow
// network calls when an upstream (Fineract today) is down or misconfigured.
//
// Lifecycle:
//   closed    normal: calls fn, counts consecutive failures.
//   open      every call fails fast with BreakerOpenError until openMs elapses.
//   half_open after openMs, ONE call is let through as a probe. Success → closed,
//             failure → re-open and reset the openMs window.
//
// Per-process state. Standalone worker and inline worker each have their own
// breakers — that's fine, since each process is independently responsible for
// its own calls. If Fineract comes back for one process it'll come back for the
// other on the next probe window.

import { appError } from "./errors.ts";

type State = "closed" | "open" | "half_open";

interface Breaker {
  name: string;
  state: State;
  consecutiveFailures: number;
  openedAt: number | null;
  probeInFlight: boolean;
  trip: number;
  openMs: number;
}

const breakers = new Map<string, Breaker>();

const DEFAULTS = { trip: 3, openMs: 60_000 };

function get(name: string, opts?: Partial<Pick<Breaker, "trip" | "openMs">>): Breaker {
  let b = breakers.get(name);
  if (!b) {
    b = { name, state: "closed", consecutiveFailures: 0, openedAt: null, probeInFlight: false, trip: DEFAULTS.trip, openMs: DEFAULTS.openMs };
    breakers.set(name, b);
  }
  if (opts?.trip != null)   b.trip = opts.trip;
  if (opts?.openMs != null) b.openMs = opts.openMs;
  return b;
}

/**
 * Wrap an async call with the breaker named `name`. If the breaker is open the
 * call fails fast with FINERACT_UNAVAILABLE (the error code we already catch
 * everywhere) — no network hit. On repeated success the breaker closes.
 *
 * `countFailure(e)`: optional filter. Return false to let an error through
 * without counting it against the trip threshold (e.g. configuration errors
 * where retrying can't help — the caller never reached the upstream anyway).
 */
export async function withBreaker<T>(name: string, fn: () => Promise<T>, opts?: { trip?: number; openMs?: number; countFailure?: (e: unknown) => boolean }): Promise<T> {
  const b = get(name, opts);
  // open: has the cooldown elapsed? If yes, promote one call to half_open.
  if (b.state === "open") {
    if (b.openedAt != null && Date.now() - b.openedAt >= b.openMs && !b.probeInFlight) {
      b.state = "half_open";
      b.probeInFlight = true;
    } else {
      throw appError("FINERACT_UNAVAILABLE", `Circuit breaker "${name}" is open; last failure at ${b.openedAt ? new Date(b.openedAt).toISOString() : "unknown"}`);
    }
  } else if (b.state === "half_open") {
    // Another concurrent probe is already testing the upstream — fail fast.
    if (b.probeInFlight) throw appError("FINERACT_UNAVAILABLE", `Circuit breaker "${name}" probe already in flight`);
    b.probeInFlight = true;
  }

  try {
    const result = await fn();
    // Success — close the breaker and reset counters.
    b.state = "closed";
    b.consecutiveFailures = 0;
    b.openedAt = null;
    b.probeInFlight = false;
    return result;
  } catch (e) {
    b.probeInFlight = false;
    const shouldCount = opts?.countFailure ? opts.countFailure(e) : true;
    if (shouldCount) {
      b.consecutiveFailures++;
      if (b.state === "half_open" || b.consecutiveFailures >= b.trip) {
        b.state = "open";
        b.openedAt = Date.now();
      }
    }
    throw e;
  }
}

export interface BreakerSnapshot {
  state: State;
  consecutiveFailures: number;
  openedAt: string | null;
  cooldownRemainingMs: number;
}

/** Read-only snapshot — used by the health endpoint and monitoring loop. */
export function breakerState(name: string): BreakerSnapshot {
  const b = breakers.get(name);
  if (!b) return { state: "closed", consecutiveFailures: 0, openedAt: null, cooldownRemainingMs: 0 };
  const cooldownRemainingMs = b.state === "open" && b.openedAt != null
    ? Math.max(0, b.openMs - (Date.now() - b.openedAt))
    : 0;
  return {
    state: b.state,
    consecutiveFailures: b.consecutiveFailures,
    openedAt: b.openedAt == null ? null : new Date(b.openedAt).toISOString(),
    cooldownRemainingMs,
  };
}

/** For tests only — wipe all breaker state. */
export function _resetBreakers(): void {
  breakers.clear();
}
