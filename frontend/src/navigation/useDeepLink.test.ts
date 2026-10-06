import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDeepLink } from './useDeepLink';

/**
 * Tests for the History-API wiring. The pure parse/serialize logic is covered
 * in viewHash.test.ts; here we only assert the DOM/History behaviour: initial
 * parse from the seeded hash, push vs replace, and popstate re-parse.
 */
describe('useDeepLink', () => {
  const originalHash = window.location.hash;
  let pushSpy: ReturnType<typeof vi.fn>;
  let replaceSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushSpy = vi.fn();
    replaceSpy = vi.fn();
    // Spy on history methods without actually mutating jsdom history, so the
    // asserted hash argument is exact and tests stay isolated.
    vi.spyOn(window.history, 'pushState').mockImplementation(
      pushSpy as unknown as typeof window.history.pushState,
    );
    vi.spyOn(window.history, 'replaceState').mockImplementation(
      replaceSpy as unknown as typeof window.history.replaceState,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = originalHash;
  });

  it('parses the initial state from the seeded hash', () => {
    window.location.hash = '#/run/r1/task/t1';
    const { result } = renderHook(() => useDeepLink());
    expect(result.current.state).toEqual({
      kind: 'run',
      runId: 'r1',
      taskId: 't1',
    });
  });

  it('falls back to fleet for an unknown hash', () => {
    window.location.hash = '#/garbage';
    const { result } = renderHook(() => useDeepLink());
    expect(result.current.state).toEqual({ kind: 'fleet' });
  });

  it('navigate pushes the serialized hash and updates state', () => {
    window.location.hash = '#/';
    const { result } = renderHook(() => useDeepLink());

    act(() => {
      result.current.navigate({ kind: 'run', runId: 'r1' });
    });

    expect(pushSpy).toHaveBeenCalledWith(null, '', '#/run/r1');
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: 'run', runId: 'r1' });
  });

  it('navigate with { replace: true } calls replaceState', () => {
    window.location.hash = '#/';
    const { result } = renderHook(() => useDeepLink());

    act(() => {
      result.current.navigate(
        { kind: 'run', runId: 'r1', taskId: 't1' },
        { replace: true },
      );
    });

    expect(replaceSpy).toHaveBeenCalledWith(null, '', '#/run/r1/task/t1');
    expect(pushSpy).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      kind: 'run',
      runId: 'r1',
      taskId: 't1',
    });
  });

  it('re-parses on popstate when the hash changes', () => {
    window.location.hash = '#/';
    const { result } = renderHook(() => useDeepLink());
    expect(result.current.state).toEqual({ kind: 'fleet' });

    act(() => {
      window.location.hash = '#/run/r2';
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.state).toEqual({ kind: 'run', runId: 'r2' });
  });
});
