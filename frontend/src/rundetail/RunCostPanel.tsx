/**
 * RunCostPanel — estimated per-run cost breakdown for the Run Detail page,
 * styled after AWS Cost Explorer's usage-type / quantity / cost table
 * (design §5; Req 5.2–5.7, 6.1–6.5).
 *
 * Purely presentational: the parent (`RunDetailView`) owns the fetch and passes
 * the latest `result`/`isLoading` plus an `onRefresh` callback that re-issues
 * the `getRunCostEstimate` query. This panel derives exactly one of four honest
 * states via `deriveCostPresentation` and never fabricates a value:
 *
 *  - loading (Req 5.6): a `Spinner` + "Estimating cost…", distinct from the
 *    unavailable state.
 *  - error (Req 5.7): an `Alert type="error"` with a Retry control that
 *    re-issues the query. A non-null `result.error` is treated as an error,
 *    never conflated with unavailable.
 *  - unavailable (Req 6.4, 6.5): an explicit "Cost estimate unavailable"
 *    message, never a fabricated 0 or empty breakdown.
 *  - ready (Req 5.2, 5.3): a Cloudscape `Table` with the five Cost-Explorer
 *    columns (usage type / resource type / quantity / published rate /
 *    estimated cost), a total row carrying the `currency` and `effectiveDate`,
 *    a partial-total indicator when `partial` is true (Req 6.3), and — for
 *    every unavailable line item — a "—" in each numeric cell (never a zero,
 *    Req 6.1, 6.2), coexisting with the computable rows.
 *
 * The whole estimate is labeled with an "Estimate" `Badge` (green) that is
 * visually distinct from the metrics panel's blue "Measured" badge (Req 5.5),
 * plus the Estimate_Disclaimer stating this is a list-price estimate based on
 * measured task runtime, excluding credits/discounts/overhead, that will differ
 * from — typically be lower than — the actual bill (Req 5.4).
 *
 * This estimate is a list-price ESTIMATE (measured runtime × the published AWS
 * price list), never the actual billed amount.
 */
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Popover from '@cloudscape-design/components/popover';
import Icon from '@cloudscape-design/components/icon';
import type { CostLineItem, RunCostEstimate } from '../api/types';
import { deriveCostPresentation } from '../cost/costPresentation';

export interface RunCostPanelProps {
  readonly runId: string;
  readonly result: RunCostEstimate | null;
  readonly isLoading: boolean;
  /** Re-issues the on-demand `getRunCostEstimate` query. Usable in any phase. */
  readonly onRefresh: () => void;
}

/** The explicit unavailable affordance for a numeric cell — never a zero. */
const UNAVAILABLE = '—';

/**
 * The user-visible statement that the estimate is a list-price estimate based
 * on measured task runtime, excludes credits/discounts/overhead, and will
 * differ from (typically be lower than) the actual bill (Req 5.4).
 */
const ESTIMATE_DISCLAIMER =
  'This is a list-price estimate based on measured task runtime at published ' +
  'On-Demand prices. It excludes credits, discounts, and provisioning/rounding ' +
  'overhead, so it will differ from — and is typically lower than — the actual bill.';

/** Format a currency amount for display, or the unavailable affordance when null. */
function formatCost(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null) {
    return UNAVAILABLE;
  }
  const prefix = currency === 'USD' ? '$' : currency ? `${currency} ` : '';
  return `${prefix}${value.toFixed(4)}`;
}

/** Format a rate per unit for display, or the unavailable affordance when null. */
function formatRate(
  value: number | null | undefined,
  unit: string,
  currency: string | null | undefined,
): string {
  if (value == null) {
    return UNAVAILABLE;
  }
  const prefix = currency === 'USD' ? '$' : currency ? `${currency} ` : '';
  return `${prefix}${value} / ${unit}`;
}

/** Format a quantity for display, or the unavailable affordance when null. */
function formatQuantity(value: number | null | undefined, unit: string): string {
  if (value == null) {
    return UNAVAILABLE;
  }
  return `${value} ${unit}`;
}

/**
 * The doc-informed explanation for a DYNAMIC run-storage line item that could
 * not be priced. AWS HealthOmics only publishes the run-level
 * `aws.omics.run.filesystem.usage` metric (which the dynamic-storage cost
 * integrates) with a delay of 30+ minutes and not at all for runs shorter than
 * ~30 minutes, so there is genuinely no measured usage series to price — the
 * "—" is honest, not a fabricated $0. See
 * https://docs.aws.amazon.com/omics/latest/dev/monitoring-run-metrics.html
 */
const DYNAMIC_STORAGE_UNAVAILABLE_MESSAGE =
  "AWS HealthOmics doesn't publish run-level dynamic storage usage for short " +
  'runs (under ~30 minutes) and can delay it by 30+ minutes, so there\u2019s no ' +
  'measured usage to price for this run. This is not a billing error — it\u2019s a ' +
  'gap in the source metric, not a $0 cost.';

/** The generic fallback when the backend gives no specific reason. */
const GENERIC_UNAVAILABLE_MESSAGE =
  "This line item couldn't be priced, so no estimate is shown (never a " +
  'fabricated $0).';

/**
 * True when a line item is the DYNAMIC run-storage case whose "—" the docs
 * explain (delayed / absent `aws.omics.run.filesystem.usage` series). Detected
 * structurally (STORAGE + a Dynamic-Run-Storage usage/resource type) or by the
 * backend's specific "Dynamic run storage usage series unavailable" reason on a
 * null-quantity storage item, so it enriches that reason rather than guessing.
 */
function isDynamicRunStorage(item: CostLineItem): boolean {
  if (item.category !== 'STORAGE') {
    return false;
  }
  if (
    item.usageType === 'Dynamic Run Storage' ||
    item.resourceType === 'Dynamic Run Storage'
  ) {
    return true;
  }
  return (
    item.quantity == null &&
    typeof item.unavailableReason === 'string' &&
    item.unavailableReason.toLowerCase().includes('dynamic run storage')
  );
}

/**
 * Compute a friendly, user-facing sentence explaining WHY an unavailable line
 * item shows a "—". Pure and total. Enriches the DYNAMIC run-storage case with
 * doc-informed context; otherwise surfaces the backend `unavailableReason`, and
 * falls back to a generic honest message when no reason is provided. Never
 * fabricates a number or contradicts the backend reason.
 */
export function explainUnavailable(item: CostLineItem): string {
  if (isDynamicRunStorage(item)) {
    return DYNAMIC_STORAGE_UNAVAILABLE_MESSAGE;
  }
  const reason = item.unavailableReason;
  if (typeof reason === 'string' && reason.trim() !== '') {
    return reason;
  }
  return GENERIC_UNAVAILABLE_MESSAGE;
}

/**
 * A numeric cell for an unavailable line item: the honest "—" followed by a
 * compact, discoverable info affordance that reveals `reason` in a dismissable
 * Popover. Keeps the cell reading as "—" while giving users a "why".
 */
function UnavailableCell({ reason }: { reason: string }): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <span>{UNAVAILABLE}</span>
      <Popover
        dismissButton
        header="Why is this unavailable?"
        triggerType="custom"
        size="medium"
        position="top"
        content={<span data-testid="cost-unavailable-reason">{reason}</span>}
      >
        <button
          type="button"
          aria-label="Why is this unavailable?"
          data-testid="cost-unavailable-info"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: 0,
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          <Icon name="status-info" variant="link" />
        </button>
      </Popover>
    </span>
  );
}

/** A synthetic table row: either a real line item or the total row. */
type CostRow =
  | { readonly kind: 'lineItem'; readonly item: CostLineItem; readonly key: string }
  | {
      readonly kind: 'total';
      readonly key: string;
      readonly total: number | null | undefined;
      readonly currency: string | null | undefined;
      readonly effectiveDate: string | null | undefined;
      readonly partial: boolean;
    };

export default function RunCostPanel({
  runId,
  result,
  isLoading,
  onRefresh,
}: RunCostPanelProps): React.JSX.Element {
  const presentation = deriveCostPresentation(result, isLoading);

  const refreshButton = (
    <Button
      iconName="refresh"
      ariaLabel="Refresh estimated cost"
      loading={isLoading}
      onClick={onRefresh}
    >
      Refresh
    </Button>
  );

  return (
    <Container
      data-testid="cost-panel"
      header={
        <Header
          variant="h2"
          actions={refreshButton}
          info={<Badge color="green">Estimate</Badge>}
        >
          Estimated cost
        </Header>
      }
    >
      {presentation.kind === 'loading' && (
        <Box padding="s" data-testid="cost-loading">
          <Spinner /> <span>Estimating cost…</span>
        </Box>
      )}

      {presentation.kind === 'error' && (
        <Alert
          type="error"
          header="Estimated cost could not be loaded"
          data-testid="cost-error"
          action={<Button onClick={onRefresh}>Retry</Button>}
        >
          {presentation.message}
        </Alert>
      )}

      {presentation.kind === 'unavailable' && (
        <Alert type="info" header="Cost estimate unavailable" data-testid="cost-unavailable">
          No cost line item could be priced for this run, so no estimate is
          shown. This can happen when no rate card is available for the run's
          region or when no task has both a captured instance type and a
          measured runtime. This is never a fabricated zero.
        </Alert>
      )}

      {presentation.kind === 'ready' && (
        <div data-testid="cost-ready">
          <SpaceBetween size="m">
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <Badge color="green">Estimate</Badge>
              {presentation.partial && (
                <Box
                  color="text-status-warning"
                  fontSize="body-s"
                  data-testid="cost-partial-indicator"
                >
                  Partial total — some line items could not be priced and are
                  excluded from the total below.
                </Box>
              )}
            </SpaceBetween>

            <Table<CostRow>
              variant="borderless"
              data-testid="cost-table"
              trackBy="key"
              ariaLabels={{ tableLabel: `Estimated cost for run ${runId}` }}
              items={[
                ...presentation.lineItems.map((item, index) => ({
                  kind: 'lineItem' as const,
                  item,
                  key: `${item.category}-${item.usageType}-${index}`,
                })),
                {
                  kind: 'total' as const,
                  key: 'total-row',
                  total: presentation.total,
                  currency: presentation.currency,
                  effectiveDate: presentation.effectiveDate,
                  partial: presentation.partial,
                },
              ]}
              columnDefinitions={[
                {
                  id: 'usageType',
                  header: 'Usage type',
                  cell: (row) =>
                    row.kind === 'total' ? (
                      <Box fontWeight="bold">
                        Total{row.partial ? ' (partial)' : ''}
                      </Box>
                    ) : (
                      row.item.usageType
                    ),
                },
                {
                  id: 'resourceType',
                  header: 'Resource type',
                  cell: (row) =>
                    row.kind === 'total'
                      ? row.effectiveDate
                        ? `Effective ${row.effectiveDate}`
                        : ''
                      : row.item.resourceType ?? UNAVAILABLE,
                },
                {
                  id: 'quantity',
                  header: 'Quantity',
                  cell: (row) => {
                    if (row.kind === 'total') {
                      return '';
                    }
                    if (row.item.available === false && row.item.quantity == null) {
                      return <UnavailableCell reason={explainUnavailable(row.item)} />;
                    }
                    return formatQuantity(row.item.quantity, row.item.unit);
                  },
                },
                {
                  id: 'ratePerUnit',
                  header: 'Published rate',
                  cell: (row) => {
                    if (row.kind === 'total') {
                      return row.currency ?? '';
                    }
                    if (row.item.available === false && row.item.ratePerUnit == null) {
                      return <UnavailableCell reason={explainUnavailable(row.item)} />;
                    }
                    return formatRate(
                      row.item.ratePerUnit,
                      row.item.unit,
                      presentation.currency,
                    );
                  },
                },
                {
                  id: 'estimatedCost',
                  header: 'Estimated cost',
                  cell: (row) => {
                    if (row.kind === 'total') {
                      return (
                        <Box fontWeight="bold">
                          {formatCost(row.total, row.currency)}
                        </Box>
                      );
                    }
                    if (row.item.available === false) {
                      return <UnavailableCell reason={explainUnavailable(row.item)} />;
                    }
                    return formatCost(row.item.estimatedCost, presentation.currency);
                  },
                },
              ]}
              empty={
                <Box textAlign="center" color="inherit">
                  No cost line items.
                </Box>
              }
            />

            <Box color="text-status-inactive" fontSize="body-s" data-testid="cost-disclaimer">
              {ESTIMATE_DISCLAIMER}
            </Box>
          </SpaceBetween>
        </div>
      )}
    </Container>
  );
}
