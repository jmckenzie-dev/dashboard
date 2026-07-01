// Shared snapshot manager: computes getAllSessions() ONCE per interval and
// broadcasts the result to all subscribers. This eliminates the N× duplication
// where every SSE client independently ran its own full poll cycle.
//
// Design:
// - A single self-scheduling timer drives the poll loop.
// - The timer starts when the first subscriber attaches and stops when the
//   last one detaches (so an idle dashboard with no clients does zero work).
// - Ticks are non-overlapping: if the previous tick hasn't settled when the
//   next fires, the new tick is skipped and counted via snapshotSkipped.
// - Subscribers receive (sessions, counts) on every successful tick.
//   Status transitions are also forwarded so the SSE layer can emit them.

import type { AgentSession, AgentStatus, StatusTransition } from './types';
import { getAllSessions, countStatuses, onStatusTransition } from './index';
import { loadConfig } from '../config';
import {
  snapshotDuration,
  snapshotSubscribers,
  snapshotSkipped,
  sessionsTotal,
} from '../metrics';

export interface SnapshotData {
  sessions: AgentSession[];
  counts: Record<AgentStatus, number>;
}

type SnapshotListener = (data: SnapshotData) => void;
type TransitionListener = (transition: StatusTransition) => void;

let timer: ReturnType<typeof setTimeout> | null = null;
let intervalMs = 3000;
let inFlight = false;
let lastSnapshot: SnapshotData | null = null;

const snapshotListeners = new Set<SnapshotListener>();
const transitionListeners = new Set<TransitionListener>();

// Wire up status transitions from getAllSessions to our subscribers.
// This runs once at module load; getAllSessions.checkTransitions fires
// transition callbacks internally.
let transitionUnsub: (() => void) | null = null;

function ensureTransitionForwarding(): void {
  if (transitionUnsub) return;
  transitionUnsub = onStatusTransition((transition) => {
    for (const listener of transitionListeners) {
      try {
        listener(transition);
      } catch (error) {
        console.error('Snapshot transition listener error:', error);
      }
    }
  });
}

async function pollOnce(): Promise<void> {
  const start = process.hrtime();
  try {
    const sessions = await getAllSessions();
    const counts = countStatuses(sessions);

    // Update status gauges.
    const allStatuses: AgentStatus[] = [
      'working', 'blocked', 'blocked_permission', 'blocked_question',
      'blocked_review', 'complete', 'idle', 'retry', 'error',
    ];
    for (const status of allStatuses) {
      try {
        sessionsTotal.set({ status }, counts[status] ?? 0);
      } catch {}
    }

    const data: SnapshotData = { sessions, counts };
    lastSnapshot = data;

    for (const listener of snapshotListeners) {
      try {
        listener(data);
      } catch (error) {
        console.error('Snapshot listener error:', error);
      }
    }
  } catch (error) {
    console.error('Snapshot poll error:', error);
  } finally {
    const diff = process.hrtime(start);
    const duration = diff[0] + diff[1] / 1e9;
    try {
      snapshotDuration.observe({ phase: 'total' }, duration);
    } catch {}
  }
}

function scheduleNext(): void {
  if (snapshotListeners.size === 0) return;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (snapshotListeners.size === 0) return;
    if (inFlight) {
      try {
        snapshotSkipped.inc();
      } catch {}
      scheduleNext();
      return;
    }
    inFlight = true;
    try {
      await pollOnce();
    } finally {
      inFlight = false;
    }
    scheduleNext();
  }, intervalMs);
}

function startTimer(): void {
  ensureTransitionForwarding();
  // Run one tick immediately so the new subscriber doesn't wait a full
  // interval for its first snapshot.
  if (!inFlight && !timer) {
    inFlight = true;
    pollOnce().finally(() => {
      inFlight = false;
      if (snapshotListeners.size > 0) scheduleNext();
    });
  } else {
    scheduleNext();
  }
}

function stopTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Subscribe to shared snapshot updates. Returns an unsubscribe function.
 * The first subscriber starts the poll timer; the last one stops it.
 *
 * If a cached snapshot exists, the listener is called immediately with it
 * so the client doesn't see an empty screen on connect.
 */
export function subscribe(listener: SnapshotListener): () => void {
  snapshotListeners.add(listener);
  try {
    snapshotSubscribers.set(snapshotListeners.size);
  } catch {}

  if (snapshotListeners.size === 1) {
    // Load interval from config (in case it was changed since last load).
    loadConfig().then((config) => {
      intervalMs = config.polling.intervalMs;
    }).catch(() => {});
    startTimer();
  } else if (lastSnapshot) {
    // Immediate delivery of cached snapshot for subsequent subscribers.
    try {
      listener(lastSnapshot);
    } catch {}
  }

  return () => {
    snapshotListeners.delete(listener);
    try {
      snapshotSubscribers.set(snapshotListeners.size);
    } catch {}
    if (snapshotListeners.size === 0) {
      stopTimer();
    }
  };
}

/**
 * Subscribe to status transitions forwarded from the snapshot poll.
 */
export function subscribeTransitions(listener: TransitionListener): () => void {
  transitionListeners.add(listener);
  return () => {
    transitionListeners.delete(listener);
  };
}

/**
 * Force an immediate snapshot refresh (e.g. after a user action like sending
 * a message). If a poll is already in flight, this is a no-op — the result
 * of the in-flight poll will be delivered to all subscribers shortly.
 */
export async function refresh(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await pollOnce();
  } finally {
    inFlight = false;
  }
}
