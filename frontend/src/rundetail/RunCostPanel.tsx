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
                  cell: (row) =>
                    row.kind === 'total'
                      ? ''
                      : formatQuantity(row.item.quantity, row.item.unit),
                },
                {
                  id: 'ratePerUnit',
                  header: 'Published rate',
                  cell: (row) =>
                    row.kind === 'total'
                      ? row.currency ?? ''
                      : formatRate(
                          row.item.ratePerUnit,
                          row.item.unit,
                          presentation.currency,
                        ),
                },
                {
                  id: 'estimatedCost',
                  header: 'Estimated cost',
                  cell: (row) =>
                    row.kind === 'total' ? (
                      <Box fontWeight="bold">
                        {formatCost(row.total, row.currency)}
                      </Box>
                    ) : (
                      formatCost(row.item.estimatedCost, presentation.currency)
                    ),
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
