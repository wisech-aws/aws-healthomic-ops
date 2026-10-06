/**
 * QoL #3 — React hook that wires the pure {@link ViewState} <-> hash mapping
 * (viewHash.ts) to the browser's History API, with NO router dependency.
 *
 * On mount it reads `window.location.hash`, parses it into the initial
 * {@link ViewState}, and subscribes to the native `popstate` event so browser
 * back/forward re-parses the then-current hash into state. The returned
 * `navigate` function serializes a target state and updates the URL via
 * `history.pushState`/`replaceState` WITHOUT a full page reload.
 *
 * This file holds ONLY the DOM/History wiring — all parse/serialize logic lives
 * in viewHash.ts. It is defensive against a missing `window` (test/SSR env): it
 * falls back to the fleet state and `navigate` is a no-op there, so it never
 * crashes.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseViewHash, serializeViewHash } from './viewHash';
import type { ViewState } from './viewHash';

/** Options for {@link UseDeepLinkResult.navigate}. */
export interface NavigateOptions {
  /**
   * Replace the current history entry instead of pushing a new one. Use for
   * programmatic/initial syncs that should not add a back-button step; omit
   * (push) for genuine user navigation.
   */
  readonly replace?: boolean;
}

/** What {@link useDeepLink} returns. */
export interface UseDeepLinkResult {
  /** The current view parsed from the location hash. */
  readonly state: ViewState;
  /** Update the URL hash (and thus the view) without reloading the page. */
  readonly navigate: (next: ViewState, opts?: NavigateOptions) => void;
}

/** Read and parse the current hash, defaulting to fleet without a window. */
function readState(): ViewState {
  if (typeof window === 'undefined' || window.location == null) {
    return { kind: 'fleet' };
  }
  return parseViewHash(window.location.hash);
}

/**
 * Deep-link hook: exposes the current {@link ViewState} and a `navigate`
 * updater. Keeps React state in sync with the URL across popstate events and
 * pushes/replaces history entries on navigation. Pure logic stays in
 * viewHash.ts; this hook only touches `window.history`/`popstate`.
 */
export function useDeepLink(): UseDeepLinkResult {
  const [state, setState] = useState<ViewState>(readState);

  // Re-parse the hash on browser back/forward so the view follows history.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const onPopState = () => {
      setState(readState());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback(
    (next: ViewState, opts?: NavigateOptions) => {
      if (typeof window === 'undefined' || window.history == null) {
        // Defensive no-op for the test/SSR env; still keep local state in sync.
        setState(next);
        return;
      }
      const hash = serializeViewHash(next);
      // `pushState`/`replaceState` update the URL (and thus the hash) without a
      // reload and WITHOUT firing popstate, so we set React state ourselves.
      if (opts?.replace === true) {
        window.history.replaceState(null, '', hash);
      } else {
        window.history.pushState(null, '', hash);
      }
      setState(next);
    },
    [],
  );

  return { state, navigate };
}
