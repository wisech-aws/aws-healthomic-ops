/**
 * View-agnostic split-panel slot for the `Dashboard` shell.
 *
 * The shell (`App.tsx`) hosts a Cloudscape `AppLayout` and exposes an optional
 * split panel to whatever content view is active — without knowing anything
 * about that view's selection, data, or types. A content view fills the slot
 * through {@link SplitPanelSlotContext} (via {@link useSplitPanelSlot}): it
 * supplies a node, drives its open state, and registers a toggle handler the
 * shell invokes when the user opens/closes the panel. Views that supply
 * nothing (fleet, params) leave the slot empty and `AppLayout` renders with no
 * split panel exactly as before.
 *
 * This lives in its own module (not `App.tsx`) so the shell file keeps
 * exporting only components — the seam is intentionally generic and carries no
 * run-detail-specific types.
 */
import { createContext, useContext } from 'react';

/**
 * The handle a content view uses to fill the shell's split-panel slot. The
 * shell only relays a node and open/toggle state to `AppLayout`.
 */
export interface SplitPanelSlot {
  /** Set the split-panel node (or `null` to clear it). */
  setSplitPanel: (node: React.ReactNode) => void;
  /** Set whether the split panel is open. */
  setOpen: (open: boolean) => void;
  /** Register the callback the shell invokes when the panel is toggled. */
  setOnToggle: (handler: ((open: boolean) => void) | undefined) => void;
}

export const SplitPanelSlotContext = createContext<SplitPanelSlot | null>(null);

/**
 * Hook a content view uses to drive the shell's split-panel slot. Returns
 * `null` when rendered outside a `Dashboard` (e.g. some tests), so callers can
 * degrade gracefully rather than crash.
 */
export function useSplitPanelSlot(): SplitPanelSlot | null {
  return useContext(SplitPanelSlotContext);
}
