/**
 * Root application component.
 *
 * Wraps the dashboard in an Amplify Authenticator so the SPA obtains a Cognito
 * session (and thus a JWT) before calling the AppSync API, whose default
 * authorization is the Cognito user pool. Without a signed-in session, GraphQL
 * calls fail with "No federated jwt"; the Authenticator provides the sign-in UI
 * that establishes the session.
 *
 * In LOCAL MOCK mode (scripts/dev-local.sh) the client serves in-memory sample
 * data and never calls AppSync, so authentication is bypassed entirely — the
 * dashboard renders directly with no sign-in required.
 *
 * The dashboard shell uses Cloudscape's AppLayout + TopNavigation with simple
 * local-state navigation between the fleet view (list of runs) and the run
 * detail view (task dependency diagram).
 */
import { useMemo, useState } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import ContentLayout from '@cloudscape-design/components/content-layout';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Header from '@cloudscape-design/components/header';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import { Authenticator } from '@aws-amplify/ui-react';
import FleetView from './fleet/FleetView';
import RunDetailView from './rundetail/RunDetailView';
import ParamsDiffView from './params/ParamsDiffView';
import ReportsView from './reports/ReportsView';
import { isLocalMockMode } from './api/config';
import {
  SplitPanelSlotContext,
  type SplitPanelSlot,
} from './splitPanelSlot';

/**
 * Props for the dashboard shell.
 *
 * `username`/`onSignOut` are supplied when running behind the Authenticator
 * (real backend) and omitted in mock mode.
 *
 * The `splitPanel*` fields are a view-agnostic split-panel slot forwarded to
 * Cloudscape `AppLayout`.
 *
 * The active content view (e.g. the run-detail view) supplies an optional
 * `splitPanel` node together with its open state and a toggle callback; the
 * shell forwards them straight to `AppLayout` without knowing anything about
 * the view's internals. When a view supplies nothing (fleet, params), the
 * fields are omitted and `AppLayout` renders with no split panel exactly as
 * today. Intentionally generic: no run-detail-specific types leak into the
 * shell.
 */
export interface DashboardProps {
  username?: string;
  onSignOut?: () => void;
  /** Optional split-panel node the active view wants docked in the shell. */
  splitPanel?: React.ReactNode;
  /** Whether that split panel is open. Omit when there is no split panel. */
  splitPanelOpen?: boolean;
  /** Called when the user opens/closes the split panel via `AppLayout`. */
  onSplitPanelToggle?: (open: boolean) => void;
}

export function Dashboard({
  username,
  onSignOut,
  splitPanel,
  splitPanelOpen,
  onSplitPanelToggle,
}: DashboardProps = {}): React.JSX.Element {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Whether the top-level Reports view is active (workflow-performance-reports).
  const [showReports, setShowReports] = useState(false);
  // Two run ids selected for the parameters diff view (enhancement #6, Req 6.7).
  // Null means no comparison is active; when set, App renders ParamsDiffView.
  const [compareRunIds, setCompareRunIds] = useState<
    readonly [string, string] | null
  >(null);

  // View-agnostic split-panel slot state. The active content view fills this
  // through `SplitPanelSlotContext` (see `useSplitPanelSlot`); the shell only
  // relays the node and open/toggle to `AppLayout`. Explicit `splitPanel*`
  // props, when passed, take precedence over the slot so an external caller can
  // drive the panel directly.
  const [slotNode, setSlotNode] = useState<React.ReactNode>(null);
  const [slotOpen, setSlotOpen] = useState(false);
  const [slotOnToggle, setSlotOnToggle] = useState<
    ((open: boolean) => void) | undefined
  >(undefined);

  const splitPanelSlot = useMemo<SplitPanelSlot>(
    () => ({
      setSplitPanel: setSlotNode,
      setOpen: setSlotOpen,
      // Wrap in a thunk so a function value isn't treated as a state updater.
      setOnToggle: (handler) => setSlotOnToggle(() => handler),
    }),
    [],
  );

  // Props win when provided; otherwise fall back to whatever the active view
  // registered through the slot context.
  const effectiveSplitPanel = splitPanel !== undefined ? splitPanel : slotNode;
  const effectiveSplitPanelOpen =
    splitPanelOpen !== undefined ? splitPanelOpen : slotOpen;
  const effectiveOnSplitPanelToggle =
    onSplitPanelToggle !== undefined ? onSplitPanelToggle : slotOnToggle;

  // Clear any registered split panel so it can't linger on a view that
  // supplies none (fleet, params) after leaving the run-detail view.
  const clearSplitPanelSlot = () => {
    setSlotNode(null);
    setSlotOpen(false);
    setSlotOnToggle(undefined);
  };

  // Return to the fleet list from any secondary view.
  const goToFleet = () => {
    setSelectedRunId(null);
    setCompareRunIds(null);
    setShowReports(false);
    clearSplitPanelSlot();
  };

  const breadcrumbItems =
    compareRunIds !== null
      ? [
          { text: 'Runs', href: '#' },
          { text: 'Compare parameters', href: '#' },
        ]
      : selectedRunId === null
        ? [{ text: 'Runs', href: '#' }]
        : [
            { text: 'Runs', href: '#' },
            { text: `Run ${selectedRunId}`, href: '#' },
          ];

  const breadcrumbs = (
    <BreadcrumbGroup
      ariaLabel="Breadcrumbs"
      items={breadcrumbItems}
      onFollow={(event) => {
        // Only the first crumb ("Runs") navigates back to the fleet.
        event.preventDefault();
        if (event.detail.text === 'Runs') {
          goToFleet();
        }
      }}
    />
  );

  return (
    <>
      <TopNavigation
        identity={{
          href: '#',
          title: 'HealthOmics Workflow Dashboard',
          onFollow: (event) => {
            event.preventDefault();
            goToFleet();
          },
        }}
        utilities={[
          {
            type: 'button',
            text: 'Reports',
            iconName: 'insert-row',
            onClick: () => {
              setSelectedRunId(null);
              setCompareRunIds(null);
              clearSplitPanelSlot();
              setShowReports(true);
            },
          },
          ...(onSignOut
            ? [
                {
                  type: 'menu-dropdown' as const,
                  text: username ?? 'Account',
                  iconName: 'user-profile' as const,
                  items: [{ id: 'signout', text: 'Sign out' }],
                  onItemClick: ({ detail }: { detail: { id: string } }) => {
                    if (detail.id === 'signout') {
                      onSignOut();
                    }
                  },
                },
              ]
            : []),
        ]}
      />
      <AppLayout
        navigationHide
        toolsHide
        breadcrumbs={breadcrumbs}
        contentType="table"
        // View-agnostic split-panel slot: forwarded straight from whatever the
        // active content view supplies. When no view supplies a `splitPanel`
        // (fleet, params), these are all undefined and `AppLayout` renders with
        // no split panel exactly as today.
        splitPanel={effectiveSplitPanel}
        splitPanelOpen={effectiveSplitPanelOpen}
        onSplitPanelToggle={
          effectiveOnSplitPanelToggle
            ? (event) => effectiveOnSplitPanelToggle(event.detail.open)
            : undefined
        }
        content={
          showReports ? (
            <ContentLayout>
              <ReportsView onBack={goToFleet} />
            </ContentLayout>
          ) : compareRunIds !== null ? (
            // Parameters diff between two runs (enhancement #6, Req 6.7).
            // ParamsDiffView defaults its `getRun` to the real client, so only
            // the two run ids need to be passed.
            <ContentLayout>
              <ParamsDiffView
                leftRunId={compareRunIds[0]}
                rightRunId={compareRunIds[1]}
                onBack={goToFleet}
              />
            </ContentLayout>
          ) : selectedRunId === null ? (
            <ContentLayout
              header={
                <Header variant="h1" description="AWS HealthOmics workflow runs, updated in near real time.">
                  Runs
                </Header>
              }
            >
              <FleetView
                onSelectRun={setSelectedRunId}
                onCompareRuns={(left, right) => setCompareRunIds([left, right])}
              />
            </ContentLayout>
          ) : (
            // The run-detail branch is the only view that fills the shell's
            // split-panel slot; it registers its panel through this context.
            // Fleet/params render outside it and supply nothing, so the slot
            // stays empty and `AppLayout` renders with no split panel.
            <SplitPanelSlotContext.Provider value={splitPanelSlot}>
              <ContentLayout>
                <RunDetailView
                  runId={selectedRunId}
                  onBack={() => {
                    setSelectedRunId(null);
                    clearSplitPanelSlot();
                  }}
                />
              </ContentLayout>
            </SplitPanelSlotContext.Provider>
          )
        }
      />
    </>
  );
}

export default function App(): React.JSX.Element {
  // Local mock mode needs no authentication: the client serves sample data and
  // never calls AppSync, so render the dashboard directly.
  if (isLocalMockMode()) {
    return <Dashboard />;
  }

  // Real backend: require a Cognito sign-in so GraphQL calls carry a JWT.
  return (
    <Authenticator hideSignUp>
      {({ signOut, user }) => (
        <Dashboard
          username={user?.signInDetails?.loginId ?? user?.username}
          onSignOut={signOut}
        />
      )}
    </Authenticator>
  );
}
