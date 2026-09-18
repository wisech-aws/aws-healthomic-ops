/**
 * Reconnecting subscription manager for the HealthOmics Workflow Dashboard.
 *
 * Wraps a long-lived GraphQL subscription (e.g. `onRunUpdated` /
 * `onTaskUpdated` from {@link ./client}) with automatic reconnection so a view
 * can stay live across transient network loss without re-implementing retry
 * logic per subscription.
 *
 * Behavior (Req 10.5, 10.6):
 *  - On subscription error/drop, the manager reconnects automatically with
 *    exponential backoff beginning at 1s, doubling each attempt, capped at 30s
 *    between attempts, continuing until the connection is re-established
 *    (Req 10.5). The schedule is exposed as the pure {@link backoffDelay}
 *    function so it can be unit/property tested independently.
 *  - Connection state (connected/disconnected) is surfaced through an
 *    `onConnectionChange` callback so the UI can show a disconnected indicator
 *    while down and remove it on reconnect (Req 10.6).
 *  - While disconnected, the manager does NOT refetch data. On every
 *    (re)connection it invokes `onReconnect` exactly once so the view refetches
 *    current data through queries (Req 10.6).
 *
 * Timers and the subscribe factory are injectable so tests can drive the
 * schedule with fake timers and stubbed subscriptions rather than a real
 * AppSync connection.
 */
import type { Subscription, SubscriptionHandlers } from './client';

/** Base backoff delay in milliseconds (first reconnect attempt waits 1s). */
export const BASE_BACKOFF_MS = 1_000;

/** Maximum backoff delay in milliseconds (attempts never wait longer than 30s). */
export const MAX_BACKOFF_MS = 30_000;

/**
 * Pure reconnect backoff schedule (Req 10.5, Property 26).
 *
 * For attempt number `n` (0-based), returns `min(BASE_BACKOFF_MS * 2^n,
 * MAX_BACKOFF_MS)`. The first delay is 1000ms, the sequence doubles
 * (1000, 2000, 4000, 8000, 16000) and is then clamped at 30000ms, so it is
 * non-decreasing and never exceeds the cap.
 *
 * @param attempt zero-based reconnect attempt number; negative values are
 *   treated as attempt 0.
 */
export function backoffDelay(attempt: number): number {
  const n = attempt <= 0 ? 0 : Math.floor(attempt);
  // Compute the cap in log-space to avoid `2 ** n` overflowing for large n.
  const capExponent = Math.ceil(Math.log2(MAX_BACKOFF_MS / BASE_BACKOFF_MS));
  if (n >= capExponent) {
    return MAX_BACKOFF_MS;
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** n, MAX_BACKOFF_MS);
}

/** Connection state surfaced to the UI. */
export type ConnectionState = 'connected' | 'disconnected';

/**
 * Opens the underlying subscription and returns its handle. Injectable so tests
 * can supply a stub. In production this is a thin wrapper over one of the
 * client's subscribe functions, e.g.
 * `(handlers) => onRunUpdated(handlers)`.
 */
export type SubscribeFactory<T> = (
  handlers: SubscriptionHandlers<T>,
) => Subscription;

/** Minimal injectable timer surface so tests can use fake timers. */
export interface Timers {
  readonly setTimeout: (handler: () => void, delayMs: number) => number;
  readonly clearTimeout: (id: number) => void;
}

/** Options for {@link createReconnectingSubscription}. */
export interface ReconnectingSubscriptionOptions<T> {
  /** Opens the underlying subscription (injectable for tests). */
  readonly subscribe: SubscribeFactory<T>;
  /** Receives each value delivered by the active subscription. */
  readonly onNext: (value: T) => void;
  /**
   * Invoked on every successful (re)connection so the view can refetch current
   * data through queries (Req 10.6). Not called while disconnected.
   */
  readonly onReconnect?: () => void;
  /** Invoked whenever the connection state changes (Req 10.6). */
  readonly onConnectionChange?: (state: ConnectionState) => void;
  /** Injectable timers; defaults to the global `setTimeout`/`clearTimeout`. */
  readonly timers?: Timers;
}

/** Handle to a managed, reconnecting subscription. */
export interface ManagedSubscription {
  /** Current connection state. */
  readonly getState: () => ConnectionState;
  /**
   * Tears the manager down: cancels any pending reconnect timer and the active
   * subscription, and stops all further reconnection attempts.
   */
  readonly stop: () => void;
}

const defaultTimers: Timers = {
  setTimeout: (handler, delayMs) =>
    globalThis.setTimeout(handler, delayMs) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/**
 * Creates a reconnecting subscription.
 *
 * Immediately opens the subscription via `subscribe`. The first successful
 * open counts as a (re)connection: it moves the state to `connected` and fires
 * `onReconnect`. On error/drop the manager moves to `disconnected`, fires
 * `onConnectionChange('disconnected')`, and schedules a reconnect using
 * {@link backoffDelay}. It keeps retrying (advancing the backoff attempt) until
 * a connection is re-established, at which point the attempt counter resets.
 */
export function createReconnectingSubscription<T>(
  options: ReconnectingSubscriptionOptions<T>,
): ManagedSubscription {
  const {
    subscribe,
    onNext,
    onReconnect,
    onConnectionChange,
    timers = defaultTimers,
  } = options;

  let state: ConnectionState = 'disconnected';
  let stopped = false;
  let attempt = 0;
  let current: Subscription | undefined;
  let timerId: number | undefined;
  // Tracks whether the current connection has proven itself healthy (delivered
  // at least one value). Only then do we reset the backoff attempt counter, so
  // a socket that opens and immediately drops still escalates the backoff
  // toward the 30s cap (Req 10.5) instead of resetting to 1s each time.
  let confirmed = false;

  function setState(next: ConnectionState): void {
    if (state === next) {
      return;
    }
    state = next;
    onConnectionChange?.(next);
  }

  function connect(): void {
    if (stopped) {
      return;
    }
    // A fresh subscription attempt: any previous handle is dead by now (we only
    // reconnect after an error), so we just open a new one.
    confirmed = false;
    current = subscribe({
      next: (value) => {
        if (stopped) {
          return;
        }
        // The first delivered value proves the stream is healthy; reset the
        // backoff so a later drop starts again from 1s.
        confirmDelivery();
        onNext(value);
      },
      error: () => {
        handleDrop();
      },
    });
    // AppSync/graphql-ws deliver a value only when data arrives, which can be
    // arbitrarily later than the socket opening. Treat a clean open as
    // connected immediately so the disconnected indicator clears promptly and
    // the reconnect refetch fires (Req 10.6). The backoff attempt counter is
    // NOT reset here — only a confirmed delivery resets it — so a socket that
    // opens then immediately drops still escalates toward the 30s cap
    // (Req 10.5); a subsequent error triggers the backoff path.
    markConnected();
  }

  function markConnected(): void {
    if (stopped || state === 'connected') {
      return;
    }
    setState('connected');
    // Fire the refetch after the state flips so a handler that reads state sees
    // "connected" (Req 10.6). Not called while disconnected.
    onReconnect?.();
  }

  function confirmDelivery(): void {
    if (confirmed) {
      return;
    }
    confirmed = true;
    attempt = 0;
  }

  function handleDrop(): void {
    if (stopped) {
      return;
    }
    // Tear down the dropped subscription before scheduling a retry.
    try {
      current?.unsubscribe();
    } finally {
      current = undefined;
    }
    setState('disconnected');
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopped || timerId !== undefined) {
      return;
    }
    const delay = backoffDelay(attempt);
    attempt += 1;
    timerId = timers.setTimeout(() => {
      timerId = undefined;
      connect();
    }, delay);
  }

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timerId !== undefined) {
      timers.clearTimeout(timerId);
      timerId = undefined;
    }
    try {
      current?.unsubscribe();
    } finally {
      current = undefined;
    }
  }

  connect();

  return {
    getState: () => state,
    stop,
  };
}
