import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import type { Subscription, SubscriptionHandlers } from './client';
import {
  backoffDelay,
  createReconnectingSubscription,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  type ConnectionState,
} from './subscriptionManager';

// --- Pure backoff schedule (Req 10.5) --------------------------------------

describe('backoffDelay', () => {
  it('produces the documented 1s -> 2s -> ... -> 30s-capped schedule', () => {
    const schedule = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelay(n));
    expect(schedule).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000,
    ]);
  });

  it('starts at the 1s base delay', () => {
    expect(backoffDelay(0)).toBe(BASE_BACKOFF_MS);
  });

  it('never exceeds the 30s cap even for very large attempt numbers', () => {
    expect(backoffDelay(100)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelay(1_000)).toBe(MAX_BACKOFF_MS);
  });

  it('treats negative attempts as the first attempt', () => {
    expect(backoffDelay(-1)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelay(-100)).toBe(BASE_BACKOFF_MS);
  });
});

/**
 * Feature: healthomics-workflow-dashboard, Property 26: Reconnect backoff
 * schedule. For any attempt number n (starting at 0), the delay equals
 * min(base * 2^n, 30s) with base = 1s: the first delay is 1s, the sequence is
 * non-decreasing, and no delay exceeds 30s.
 *
 * Validates: Requirements 10.5
 */
describe('Property 26: reconnect backoff schedule', () => {
  it('equals min(1s * 2^n, 30s), first delay 1s, non-decreasing, capped at 30s', () => {
    // First delay is exactly the 1s base.
    expect(backoffDelay(0)).toBe(BASE_BACKOFF_MS);

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 64 }), (n) => {
        const delay = backoffDelay(n);
        const expected = Math.min(BASE_BACKOFF_MS * 2 ** n, MAX_BACKOFF_MS);
        expect(delay).toBe(expected);
        // Bounds: never below the base, never above the cap.
        expect(delay).toBeGreaterThanOrEqual(BASE_BACKOFF_MS);
        expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
        // Non-decreasing relative to the previous attempt.
        if (n > 0) {
          expect(delay).toBeGreaterThanOrEqual(backoffDelay(n - 1));
        }
      }),
      { numRuns: 200 },
    );
  });
});

// --- Managed subscription behavior (Req 10.5, 10.6) ------------------------

/**
 * A controllable stub subscribe factory. Each call to the factory represents a
 * connection attempt; the test drives that connection's lifecycle through the
 * returned controls.
 */
interface Controls<T> {
  emit: (value: T) => void;
  error: () => void;
  unsubscribed: boolean;
}

function makeStubSubscribe<T>() {
  const connections: Controls<T>[] = [];
  const subscribe = (handlers: SubscriptionHandlers<T>): Subscription => {
    const control: Controls<T> = {
      emit: (value) => handlers.next(value),
      error: () => handlers.error?.(undefined),
      unsubscribed: false,
    };
    connections.push(control);
    return {
      unsubscribe: () => {
        control.unsubscribed = true;
      },
    };
  };
  return { subscribe, connections };
}

describe('createReconnectingSubscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects on start, reporting connected and firing onReconnect once', () => {
    const { subscribe, connections } = makeStubSubscribe<number>();
    const states: ConnectionState[] = [];
    const onReconnect = vi.fn();

    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: () => {},
      onReconnect,
      onConnectionChange: (s) => states.push(s),
    });

    expect(connections).toHaveLength(1);
    expect(managed.getState()).toBe('connected');
    expect(states).toEqual(['connected']);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    managed.stop();
  });

  it('forwards subscription values through onNext while connected', () => {
    const { subscribe, connections } = makeStubSubscribe<number>();
    const received: number[] = [];

    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: (v) => received.push(v),
    });

    connections[0].emit(1);
    connections[0].emit(2);
    expect(received).toEqual([1, 2]);

    managed.stop();
  });

  it('goes disconnected on drop and reconnects after the 1s backoff', () => {
    const { subscribe, connections } = makeStubSubscribe<number>();
    const states: ConnectionState[] = [];
    const onReconnect = vi.fn();

    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: () => {},
      onReconnect,
      onConnectionChange: (s) => states.push(s),
    });

    // Initial connect.
    expect(states).toEqual(['connected']);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // Drop the connection.
    connections[0].error();
    expect(managed.getState()).toBe('disconnected');
    expect(states).toEqual(['connected', 'disconnected']);
    expect(connections[0].unsubscribed).toBe(true);

    // No reconnect until the 1s backoff elapses.
    vi.advanceTimersByTime(999);
    expect(connections).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(connections).toHaveLength(2);
    expect(managed.getState()).toBe('connected');
    expect(states).toEqual(['connected', 'disconnected', 'connected']);
    // onReconnect fires again on the re-established connection.
    expect(onReconnect).toHaveBeenCalledTimes(2);

    managed.stop();
  });

  it('does NOT refetch while disconnected (onReconnect not called during downtime)', () => {
    const { subscribe, connections } = makeStubSubscribe<number>();
    const onReconnect = vi.fn();

    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: () => {},
      onReconnect,
    });

    expect(onReconnect).toHaveBeenCalledTimes(1); // initial connect

    connections[0].error(); // drop -> disconnected
    // Advance partway through the backoff window: still down, still no refetch.
    vi.advanceTimersByTime(500);
    expect(managed.getState()).toBe('disconnected');
    expect(onReconnect).toHaveBeenCalledTimes(1);

    managed.stop();
  });

  it('refetches on every reconnect via onReconnect', () => {
    const { subscribe, connections } = makeStubSubscribe<number>();
    const onReconnect = vi.fn();

    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: () => {},
      onReconnect,
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // First drop + reconnect after 1s.
    connections[0].error();
    vi.advanceTimersByTime(1_000);
    expect(onReconnect).toHaveBeenCalledTimes(2);

    // The re-established connection delivers a value, proving it healthy and
    // resetting the backoff schedule.
    connections[1].emit(42);

    // Second drop + reconnect: backoff has reset to 1s after the healthy stream.
    connections[1].error();
    vi.advanceTimersByTime(1_000);
    expect(onReconnect).toHaveBeenCalledTimes(3);

    managed.stop();
  });

  it('follows the exponential backoff schedule across consecutive failures', () => {
    // Record the handlers of every connection so the test can drop each one
    // deterministically and observe the growing backoff between reconnects.
    const handlersList: SubscriptionHandlers<number>[] = [];
    const subscribe = (handlers: SubscriptionHandlers<number>): Subscription => {
      handlersList.push(handlers);
      return { unsubscribe: () => {} };
    };

    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: () => {},
    });

    // Initial connect already happened synchronously.
    expect(handlersList).toHaveLength(1);

    // Each attempt that ends in an error backs off by the schedule before the
    // next connect: 1s, 2s, 4s, 8s, 16s, then capped at 30s.
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    let count = 1;
    for (const delay of expectedDelays) {
      // Drop the most recent connection.
      handlersList[count - 1].error?.(undefined);
      // Not yet reconnected just before the delay elapses.
      vi.advanceTimersByTime(delay - 1);
      expect(handlersList).toHaveLength(count);
      // Reconnect fires exactly at the scheduled delay.
      vi.advanceTimersByTime(1);
      expect(handlersList).toHaveLength(count + 1);
      count += 1;
    }

    managed.stop();
  });

  it('resets the backoff to 1s after a connection delivers a value', () => {
    const handlersList: SubscriptionHandlers<number>[] = [];
    const subscribe = (handlers: SubscriptionHandlers<number>): Subscription => {
      handlersList.push(handlers);
      return { unsubscribe: () => {} };
    };
    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: () => {},
    });

    // Escalate the backoff via two consecutive open-then-drop cycles (no value
    // delivered), so the next scheduled delay would be 4s.
    handlersList[0].error?.(undefined); // -> reconnect at 1s
    vi.advanceTimersByTime(1_000);
    handlersList[1].error?.(undefined); // -> reconnect at 2s
    vi.advanceTimersByTime(2_000);
    expect(handlersList).toHaveLength(3);

    // This connection delivers a value, proving it healthy and resetting backoff.
    handlersList[2].next(7);
    handlersList[2].error?.(undefined);
    // Next reconnect happens at 1s again, not 4s.
    vi.advanceTimersByTime(999);
    expect(handlersList).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(handlersList).toHaveLength(4);

    managed.stop();
  });

  it('stop() cancels pending reconnects and tears down the active subscription', () => {
    const { subscribe, connections } = makeStubSubscribe<number>();
    const onReconnect = vi.fn();
    const states: ConnectionState[] = [];

    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: () => {},
      onReconnect,
      onConnectionChange: (s) => states.push(s),
    });

    // Drop to schedule a pending reconnect, then stop before it fires.
    connections[0].error();
    managed.stop();

    vi.advanceTimersByTime(60_000);
    // No new connection attempt after stop.
    expect(connections).toHaveLength(1);
    // Refetch count unchanged (only the initial connect).
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('stop() while connected unsubscribes and blocks further reconnects', () => {
    const { subscribe, connections } = makeStubSubscribe<number>();
    const managed = createReconnectingSubscription<number>({
      subscribe,
      onNext: () => {},
    });

    managed.stop();
    expect(connections[0].unsubscribed).toBe(true);

    // A late error after stop must not schedule a reconnect.
    connections[0].error();
    vi.advanceTimersByTime(60_000);
    expect(connections).toHaveLength(1);
  });
});
