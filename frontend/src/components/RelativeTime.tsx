/**
 * RelativeTime — a reusable presentational timestamp (QoL #5).
 *
 * Shows a short relative string ("5m ago") while keeping the EXACT absolute
 * timestamp available on hover, so the precise value is summarized but never
 * lost or altered:
 *  - the absolute value is set as a native `title` attribute (hover tooltip),
 *    and
 *  - it is also revealed through a Cloudscape `Popover` (text trigger) for a
 *    richer, keyboard/click-accessible affordance.
 *
 * Strict no-fabrication rule: when the value is absent or unparseable
 * ({@link formatAbsoluteTime} returns null), the bare dash sentinel '—' is
 * rendered with NO popover and NO title — never a guessed relative value and
 * never an empty tooltip.
 *
 * Pure presentational component: all time logic lives in the pure
 * `src/fleet/relativeTime.ts` module; this file is only React wiring.
 */
import Popover from '@cloudscape-design/components/popover';
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from '../fleet/relativeTime';

export interface RelativeTimeProps {
  /** The ISO-8601 timestamp to render, or null/undefined when absent. */
  readonly value: string | null | undefined;
  /**
   * The current instant in epoch milliseconds, injected so the relative string
   * is deterministic (mirrors the now-injection convention in the fleet
   * helpers). Defaults to `Date.now()`.
   */
  readonly now?: number;
  /** Optional test id applied to the rendered wrapper. */
  readonly 'data-testid'?: string;
}

/**
 * Renders `value` as a relative string with the absolute timestamp on hover
 * (native `title` + Cloudscape `Popover`). An absent/unparseable value renders
 * the bare '—' with no popover and no title.
 */
export default function RelativeTime({
  value,
  now,
  'data-testid': testId,
}: RelativeTimeProps): React.JSX.Element {
  const absolute = formatAbsoluteTime(value);
  const relative = formatRelativeTime(value, now);

  // No parseable absolute value -> explicit unknown affordance, no hover
  // tooltip, no popover (never a fabricated or empty hover).
  if (absolute == null) {
    return <span data-testid={testId}>{relative}</span>;
  }

  return (
    <span data-testid={testId} title={absolute}>
      <Popover
        triggerType="text"
        dismissButton={false}
        size="small"
        content={<span>{absolute}</span>}
      >
        {relative}
      </Popover>
    </span>
  );
}
