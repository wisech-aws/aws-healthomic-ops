/**
 * A small, reusable React error boundary (defense in depth).
 *
 * React has no hook equivalent for error boundaries — they MUST be class
 * components implementing `getDerivedStateFromError` (to switch to the fallback
 * on the next render) and/or `componentDidCatch` (to observe the error). This
 * boundary catches any render/lifecycle error thrown by its subtree and renders
 * a Cloudscape `Alert type="error"` fallback in place of that subtree, instead
 * of letting the exception propagate to the root and blank the whole app (a
 * "white screen").
 *
 * It is intentionally generic and presentational: wrap any region whose render
 * could throw (e.g. a detail panel driven by real, variable server data) so a
 * localized failure degrades to an inline error message while the rest of the
 * app keeps working.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';

export interface ErrorBoundaryProps {
  /** The subtree to guard. */
  readonly children: ReactNode;
  /**
   * Optional custom fallback. When provided it is rendered instead of the
   * default Alert; receives the caught error so callers can tailor the message.
   * When omitted, the default Cloudscape Alert fallback is used.
   */
  readonly fallback?: (error: Error) => ReactNode;
  /**
   * Optional header text for the default Alert fallback. Defaults to a generic
   * "Something went wrong displaying this section." message.
   */
  readonly title?: string;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  /**
   * Switch to the fallback on the next render when a child throws. Normalizes
   * non-Error throws (strings, objects) into an `Error` so the fallback always
   * has a message to show.
   */
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      error:
        error instanceof Error
          ? error
          : new Error(typeof error === 'string' ? error : 'Unknown error'),
    };
  }

  /**
   * Observe the error (kept minimal — logs to the console so the failure is
   * still diagnosable in production without crashing the app). Never rethrows.
   */
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('ErrorBoundary caught an error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error != null) {
      if (this.props.fallback != null) {
        return this.props.fallback(error);
      }
      return (
        <Alert
          type="error"
          header={this.props.title ?? 'Something went wrong displaying this section.'}
          data-testid="error-boundary-fallback"
        >
          <Box variant="p">{error.message}</Box>
        </Alert>
      );
    }
    return this.props.children;
  }
}
