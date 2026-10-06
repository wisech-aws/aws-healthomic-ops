/**
 * CopyId — a thin wrapper over Cloudscape's `CopyToClipboard` (QoL #2).
 *
 * Adds an unobtrusive copy affordance next to an identifier/URI value, so an
 * operator can copy a run ID, workflow ID, S3 URI, ARN, or task ID without
 * hand-selecting the text. It is a pure presentational component — all it does
 * is forward a value and sensible defaults into `CopyToClipboard`.
 *
 * Variants:
 *  - `inline` (default): the value text itself carries the copy affordance, so
 *    the displayed identifier text is kept unchanged (the value is shown via
 *    `textToDisplay`).
 *  - `icon`: a bare icon-only affordance that sits beside existing text/links
 *    (nothing extra displayed — the sibling text/link remains the display).
 *  - `button`: a standalone secondary button with an icon.
 *
 * Strict no-fabrication rule: callers render `CopyId` ONLY beside values that
 * are actually present; absent identifiers keep their existing '—' sentinel
 * with no copy affordance. This component never alters the displayed value.
 */
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';

export interface CopyIdProps {
  /** The exact text to copy (and, for the inline variant, to display). */
  readonly value: string;
  /** Accessible label for the copy button. Defaults to 'Copy'. */
  readonly label?: string;
  /** Styling of the copy affordance. Defaults to 'inline'. */
  readonly variant?: 'inline' | 'icon' | 'button';
}

/**
 * Renders a copy affordance for `value`. For `variant='inline'` the value is
 * also displayed (text unchanged); for `icon`/`button` only the affordance is
 * rendered beside whatever sibling text/link the caller already shows.
 */
export default function CopyId({
  value,
  label,
  variant = 'inline',
}: CopyIdProps): React.JSX.Element {
  return (
    <CopyToClipboard
      variant={variant}
      textToCopy={value}
      textToDisplay={variant === 'inline' ? value : undefined}
      copyButtonAriaLabel={label ?? 'Copy'}
      copySuccessText="Copied"
      copyErrorText="Copy failed"
    />
  );
}
