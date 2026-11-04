/**
 * Coalesces bursts of re-sync triggers into as few runs as possible.
 *
 * `trigger()` schedules `task` after `delayMs` (collapsing triggers that land
 * inside the delay into one run). While a run is in flight, further triggers
 * set a single trailing flag, so a burst produces at most one in-flight run
 * plus one trailing run. Rejections from `task` are swallowed: a failed
 * re-sync just leaves the current state in place until the next trigger.
 */
export interface CoalescedRunner {
  readonly trigger: () => void;
  readonly stop: () => void;
}

export function createCoalescedRunner(
  task: () => Promise<void>,
  delayMs: number,
): CoalescedRunner {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let trailing = false;
  let stopped = false;

  async function execute(): Promise<void> {
    inFlight = true;
    try {
      await task();
    } catch {
      // Keep current state; the next trigger retries.
    } finally {
      inFlight = false;
    }
    if (trailing && !stopped) {
      trailing = false;
      void execute();
    }
  }

  return {
    trigger: () => {
      if (stopped) {
        return;
      }
      if (inFlight) {
        trailing = true;
        return;
      }
      if (timer !== undefined) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (!stopped) {
          void execute();
        }
      }, delayMs);
    },
    stop: () => {
      stopped = true;
      trailing = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
