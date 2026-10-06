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
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useDeepLink } from './navigation/useDeepLink';

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
  // QoL #3 — deep-linkable run/task URLs via the native History API (no router).
  // `state` is the view parsed from the location hash; `navigate` updates the
  // hash (push/replace) without reloading. View state below stays plain React
  // state — the hook only keeps it in sync with the URL.
  const { state: deepLinkState, navigate } = useDeepLink();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    deepLinkState.kind === 'run' ? deepLinkState.runId : null,
  );
  // A task id restored from the URL on load, handed to RunDetailView so it can
  // open that task's logs once (if the task exists). Not part of ongoing state:
  // RunDetailView drives subsequent task selection and reports it back via
  // onTaskSelectionChange so the hash follows the live selection.
  const [pendingTaskId, setPendingTaskId] = useState<string | undefined>(
    deepLinkState.kind === 'run' ? deepLinkState.taskId : undefined,
  );
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

  // Tracks the last deep-link state we reconciled into local view state, so the
  // reconcile effect (below, after the slot/handler helpers are defined) only
  // reacts to genuine hash changes, not re-renders.
  const lastAppliedHashRef = useRef<string | null>(null);

  // Stable key for a deep-link state, used both to dedupe the reconcile effect
  // and to mark our OWN outbound navigations as already-applied (so they don't
  // re-trigger the inbound reconcile and tear down freshly-registered view
  // state like the logs fly-out slot).
  const hashKey = (s: typeof deepLinkState): string =>
    s.kind === 'fleet' ? 'fleet' : `run:${s.runId}:${s.taskId ?? ''}`;

  // Our outbound navigation: push/replace the hash AND record it as applied so
  // the reconcile effect treats it as our own change and does nothing. Inbound
  // changes (initial load, browser back/forward) do NOT go through here, so
  // their key differs from `lastAppliedHashRef` and the effect reconciles them.
  const navigateHash = (
    next: typeof deepLinkState,
    opts?: { replace?: boolean },
  ) => {
    lastAppliedHashRef.current = hashKey(next);
    navigate(next, opts);
  };

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

  // Return to the fleet list from any secondary view. Pushes the fleet hash so
  // the URL follows (and back/forward works); the reconcile effect then clears
  // the local view state from the moved deep-link state.
  const goToFleet = () => {
    setSelectedRunId(null);
    setPendingTaskId(undefined);
    setCompareRunIds(null);
    setShowReports(false);
    clearSplitPanelSlot();
    navigateHash({ kind: 'fleet' });
  };

  // Open a run from the fleet list. Pushes '#/run/<id>' so the URL is
  // deep-linkable and back returns to the fleet.
  const openRun = (runId: string) => {
    setPendingTaskId(undefined);
    setSelectedRunId(runId);
    navigateHash({ kind: 'run', runId });
  };

  // Reconcile inbound deep-link state (initial load + browser back/forward)
  // into the local view WITHOUT calling `navigate`, so popstate restores the
  // view and our own `navigate` calls stay idempotent. The hash scheme covers
  // fleet/run/task only, so any inbound navigation also clears the
  // reports/compare overlays (not deep-linkable) exactly as the fleet/run
  // handlers do.
  useEffect(() => {
    const key = hashKey(deepLinkState);
    if (lastAppliedHashRef.current === key) {
      return;
    }
    lastAppliedHashRef.current = key;

    if (deepLinkState.kind === 'run') {
      setSelectedRunId(deepLinkState.runId);
      setPendingTaskId(deepLinkState.taskId);
    } else {
      setSelectedRunId(null);
      setPendingTaskId(undefined);
    }
    setShowReports(false);
    setCompareRunIds(null);
    clearSplitPanelSlot();
    // `clearSplitPanelSlot` is a stable in-render helper; depending only on the
    // inbound state keeps this a pure URL->view reconcile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkState]);

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
              setPendingTaskId(undefined);
              setCompareRunIds(null);
              clearSplitPanelSlot();
              // Reports is not deep-linkable; drop any run/task hash so the URL
              // isn't left pointing at a run that is no longer shown.
              navigateHash({ kind: 'fleet' });
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
                onSelectRun={openRun}
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
                  // Key by run id so navigating between runs (fleet click or
                  // browser back/forward) remounts with fresh queries and a
                  // fresh one-time deep-link task restore.
                  key={selectedRunId}
                  runId={selectedRunId}
                  // Deep link (#3): restore a task from the URL on open; the
                  // view opens it once if it exists (never fabricates).
                  initialTaskId={pendingTaskId}
                  // Keep the hash in sync with the live task selection:
                  // '#/run/<id>/task/<taskId>' when a task is selected,
                  // '#/run/<id>' when cleared. `replace` so task
                  // selection/clear doesn't flood the back stack.
                  onTaskSelectionChange={(taskId) => {
                    navigateHash(
                      taskId != null
                        ? { kind: 'run', runId: selectedRunId, taskId }
                        : { kind: 'run', runId: selectedRunId },
                      { replace: true },
                    );
                  }}
                  onBack={() => {
                    setSelectedRunId(null);
                    setPendingTaskId(undefined);
                    clearSplitPanelSlot();
                    navigateHash({ kind: 'fleet' });
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
