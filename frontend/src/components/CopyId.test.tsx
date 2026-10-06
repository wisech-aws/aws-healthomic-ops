import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CopyId from './CopyId';

/**
 * CopyToClipboard reads `navigator.clipboard.writeText`. jsdom does not provide
 * a clipboard, so stub it before each test and restore the original after, to
 * avoid leaking the stub into other suites.
 */
const originalClipboard = navigator.clipboard;

describe('CopyId', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  });

  it('displays the value text unchanged for the inline variant', () => {
    render(<CopyId value="1234567890" />);
    expect(screen.getByText('1234567890')).toBeInTheDocument();
  });

  it('applies the copyButtonAriaLabel to the copy button', () => {
    render(<CopyId value="run-abc" label="Copy run ID" />);
    expect(
      screen.getByRole('button', { name: 'Copy run ID' }),
    ).toBeInTheDocument();
  });

  it('copies the exact value and surfaces the success feedback on click', async () => {
    render(<CopyId value="s3://bucket/key" label="Copy S3 URI" variant="icon" />);
    const button = screen.getByRole('button', { name: /copy/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('s3://bucket/key');
    });
    // The configured success text flashes after a successful copy.
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
