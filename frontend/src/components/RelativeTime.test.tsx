import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import RelativeTime from './RelativeTime';
import { formatAbsoluteTime } from '../fleet/relativeTime';

/** A fixed reference instant for deterministic relative strings. */
const NOW = Date.parse('2024-06-01T12:00:00.000Z');

describe('RelativeTime', () => {
  it('renders the relative string for a parseable value', () => {
    const iso = '2024-06-01T11:55:00.000Z'; // 5 minutes before NOW
    render(<RelativeTime value={iso} now={NOW} data-testid="rt" />);
    expect(screen.getByTestId('rt')).toHaveTextContent('5m ago');
  });

  it('exposes the exact absolute timestamp as a native title attribute', () => {
    const iso = '2024-06-01T11:00:00.000Z';
    render(<RelativeTime value={iso} now={NOW} data-testid="rt" />);
    const absolute = formatAbsoluteTime(iso) as string;
    expect(screen.getByTestId('rt')).toHaveAttribute('title', absolute);
  });

  it('reveals the absolute timestamp when the popover trigger is activated', () => {
    const iso = '2024-05-30T12:00:00.000Z'; // 2 days before NOW
    render(<RelativeTime value={iso} now={NOW} data-testid="rt" />);
    const absolute = formatAbsoluteTime(iso) as string;

    // The relative text is the popover trigger.
    const trigger = screen.getByText('2 days ago');
    fireEvent.click(trigger);

    // Activating the popover reveals the absolute value in the fly-out content.
    expect(screen.getByText(absolute)).toBeInTheDocument();
  });

  it("renders a bare '—' with no title and no popover for a null value", () => {
    render(<RelativeTime value={null} now={NOW} data-testid="rt" />);
    const el = screen.getByTestId('rt');
    expect(el).toHaveTextContent('—');
    expect(el).not.toHaveAttribute('title');
    // No popover trigger button exists for the dash sentinel.
    expect(within(el).queryByRole('button')).toBeNull();
  });

  it("renders a bare '—' with no title and no popover for an unparseable value", () => {
    render(<RelativeTime value="not-a-date" now={NOW} data-testid="rt" />);
    const el = screen.getByTestId('rt');
    expect(el).toHaveTextContent('—');
    expect(el).not.toHaveAttribute('title');
    expect(within(el).queryByRole('button')).toBeNull();
  });
});
