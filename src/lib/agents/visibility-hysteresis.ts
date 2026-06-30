import type { AgentSession } from './types';

/**
 * Visibility hysteresis.
 *
 * Smooths the per-tick visibility decision so that a session attached to a
 * live instance does not rapidly toggle visible/invisible when individual
 * liveness signals (status_map, blocking_request, recent_active_fallback)
 * flicker across polls. A session that was directly visible within the grace
 * window stays visible across short gaps (e.g. opencode reporting `idle`
 * between turns, or a slow tick zeroing status_map for one snapshot).
 *
 * This module is PURE: it never reads the clock, never mutates caller state
 * beyond returning a new map, and accepts an `isDirectlyVisible` predicate so
 * it has zero dependency on `src/lib/agents/index.ts` (which has side-effects).
 * This makes it trivially testable in isolation, mirroring
 * `opencode-liveness.ts`.
 */

// Grace window during which a previously-directly-visible session remains
// visible across transient "hidden" gaps. Tuned to comfortably exceed the
// inter-turn quiet periods observed during debug/smoke-test work (model
// thinking, test runs) without keeping genuinely dead sessions around long.
export const VISIBILITY_GRACE_MS = 90_000;

// Bound the in-memory visibleUntil map so a long-lived dashboard process
// cannot leak memory via accumulated stale ids. When the map grows past this,
// entries absent from the current candidate set are evicted, earliest deadline
// first.
export const MAX_TRACKED_VISIBLE = 200;

export interface ComputeVisibleSessionsArgs {
  /** Full candidate set, INCLUDING sessions currently classified hidden. */
  candidates: AgentSession[];
  /** Previous per-session visibility deadlines (mutated copy is returned). */
  visibleUntil: Map<string, number>;
  /** Reference time (epoch ms). Passed in for determinism. */
  now: number;
  /**
   * Predicate mirroring `isVisibleOpenCodeSession`: returns true when the
   * session has a real liveness/visibility signal this tick (i.e. would be
   * visible WITHOUT hysteresis).
   */
  isDirectlyVisible: (session: AgentSession) => boolean;
  /** Overrides for tests; default to the exported constants. */
  graceMs?: number;
  maxTracked?: number;
}

export interface ComputeVisibleSessionsResult {
  /** Sessions to surface this tick, in input order. */
  visible: AgentSession[];
  /** New deadline map; caller should store this back. */
  visibleUntil: Map<string, number>;
}

/**
 * Compute the visible set for this tick with hysteresis applied.
 *
 * Semantics:
 *  - Directly visible this tick → include, refresh deadline to now + grace.
 *  - Hidden this tick but deadline still in the future → include (carry over
 *    last-known reasons; do NOT extend the deadline so genuinely-stale
 *    sessions still hide on schedule).
 *  - Hidden and past deadline → exclude, drop from the map.
 *
 * Map eviction keeps the structure bounded across long-running processes.
 */
export function computeVisibleSessions(
  args: ComputeVisibleSessionsArgs,
): ComputeVisibleSessionsResult {
  const graceMs = args.graceMs ?? VISIBILITY_GRACE_MS;
  const maxTracked = args.maxTracked ?? MAX_TRACKED_VISIBLE;
  const { candidates, now, isDirectlyVisible } = args;

  // Clone so the caller's map is not mutated in place (predictable semantics
  // even if the caller reuses the reference on error paths).
  const nextUntil = new Map<string, number>(args.visibleUntil);
  const presentIds = new Set<string>();
  const visible: AgentSession[] = [];

  for (const session of candidates) {
    presentIds.add(session.id);

    if (isDirectlyVisible(session)) {
      visible.push(session);
      nextUntil.set(session.id, now + graceMs);
      continue;
    }

    const deadline = nextUntil.get(session.id);
    if (deadline !== undefined && deadline > now) {
      // Hysteresis: keep visible but do NOT extend the deadline. This ensures
      // a session that has truly gone stale still disappears after at most
      // one grace window from its last real signal.
      visible.push(session);
      continue;
    }

    // Past grace (or never tracked): drop so it cannot be resurrected absent
    // a fresh directly-visible signal.
    nextUntil.delete(session.id);
  }

  // Reclaim expired deadlines for ids that are ABSENT from this tick's
  // candidate set. Present ids were already handled above (refreshed when
  // directly visible, retained when within grace, or deleted when past
  // grace). Without this pass, a session that disappears entirely from the
  // backend (not just classified hidden_stale) would leak its deadline
  // forever — the main loop never sees it to delete it. We keep in-grace
  // absent entries so a brief candidate-set hiccup (e.g. one slow SQLite
  // read) does not lose the hysteresis window; only past-grace entries are
  // dropped.
  for (const [id, deadline] of nextUntil) {
    if (!presentIds.has(id) && deadline <= now) {
      nextUntil.delete(id);
    }
  }

  // Bounded memory: when the map exceeds the cap, evict entries that are no
  // longer present in the candidate set, earliest deadline first. Present
  // entries are always retained regardless of deadline.
  if (nextUntil.size > maxTracked) {
    const staleEntries = [...nextUntil.entries()]
      .filter(([id]) => !presentIds.has(id))
      .sort((a, b) => a[1] - b[1]);
    const overflow = nextUntil.size - maxTracked;
    for (let i = 0; i < Math.min(overflow, staleEntries.length); i++) {
      nextUntil.delete(staleEntries[i][0]);
    }
  }

  return { visible, visibleUntil: nextUntil };
}
