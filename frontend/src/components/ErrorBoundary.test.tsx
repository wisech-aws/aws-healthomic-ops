import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

// A child that throws on render, to exercise the boundary's fallback path.
function Boom({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok">healthy child</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toHaveTextContent('healthy child');
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });

  it('renders the fallback alert with the error message when a child throws', () => {
    // React logs caught render errors to the console; silence it for a clean run.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom message="kaboom in child" />
      </ErrorBoundary>,
    );

    const fallback = screen.getByTestId('error-boundary-fallback');
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveTextContent(/something went wrong/i);
    expect(fallback).toHaveTextContent('kaboom in child');
  });

  it('uses a custom fallback render when provided', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={(error) => <div data-testid="custom">{error.message}</div>}>
        <Boom message="custom path" />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('custom')).toHaveTextContent('custom path');
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });
});
