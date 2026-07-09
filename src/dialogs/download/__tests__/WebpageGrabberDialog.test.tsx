import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

import { WebpageGrabberDialog } from '../WebpageGrabberDialog';

const { storeRef, mockCloseDialog, mockAddToast } = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const mockAddToast = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { storeRef, mockCloseDialog, mockAddToast };
});

describe('WebpageGrabberDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      closeDialog: mockCloseDialog,
      addToast: mockAddToast,
      queues: [
        { id: 'main', name: 'Main Queue' },
        { id: 'nightly', name: 'Nightly Queue' },
      ],
      settings: {
        saveAndCategories: {
          categoryFolders: {},
          defaultFolder: '/downloads',
        },
      },
      t: (k: string) => {
        const map: Record<string, string> = {
          btn_cancel: 'Cancel',
        };
        return map[k] || k;
      },
    };
  });

  it('renders info banner', () => {
    render(<WebpageGrabberDialog />);
    expect(screen.getByText(/Professional Full Webpage Web Grabber/)).toBeInTheDocument();
  });

  it('renders URL input field', () => {
    render(<WebpageGrabberDialog />);
    const input = document.getElementById('grabber-url');
    expect(input).toBeInTheDocument();
  });

  it('renders save directory input', () => {
    render(<WebpageGrabberDialog />);
    const input = document.getElementById('grabber-path');
    expect(input).toBeInTheDocument();
  });

  it('renders queue selector', () => {
    render(<WebpageGrabberDialog />);
    const select = document.getElementById('grabber-queue');
    expect(select).toBeInTheDocument();
  });

  it('renders depth selector', () => {
    render(<WebpageGrabberDialog />);
    const select = document.getElementById('grabber-depth');
    expect(select).toBeInTheDocument();
  });

  it('renders save format selector', () => {
    render(<WebpageGrabberDialog />);
    const select = document.getElementById('grabber-format');
    expect(select).toBeInTheDocument();
  });

  it('renders file type filter checkboxes', () => {
    render(<WebpageGrabberDialog />);
    expect(screen.getByLabelText('Webpages (HTML)')).toBeInTheDocument();
    expect(screen.getByLabelText('Styles & Scripts')).toBeInTheDocument();
    expect(screen.getByLabelText('Images')).toBeInTheDocument();
    expect(screen.getByLabelText('Documents')).toBeInTheDocument();
    expect(screen.getByLabelText('Media')).toBeInTheDocument();
    expect(screen.getByLabelText('Other files')).toBeInTheDocument();
  });

  it('renders follow external domains switch', () => {
    render(<WebpageGrabberDialog />);
    const checkbox = document.getElementById('grabber-domains');
    expect(checkbox).toBeInTheDocument();
  });

  it('renders overwrite existing files switch', () => {
    render(<WebpageGrabberDialog />);
    const checkbox = document.getElementById('grabber-overwrite');
    expect(checkbox).toBeInTheDocument();
  });

  it('renders Cancel and Start Scraping buttons', () => {
    render(<WebpageGrabberDialog />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Start Scraping')).toBeInTheDocument();
  });

  it('calls closeDialog when Cancel clicked', () => {
    render(<WebpageGrabberDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('shows error toast when start scraping with empty URL', () => {
    render(<WebpageGrabberDialog />);
    fireEvent.click(screen.getByText('Start Scraping'));
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Invalid Link', expect.any(String));
  });

  it('shows warning toast when start scraping with non-http URL', () => {
    render(<WebpageGrabberDialog />);
    const input = document.getElementById('grabber-url') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ftp://example.com' } });
    fireEvent.click(screen.getByText('Start Scraping'));
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Invalid Link', expect.any(String));
  });

  it('shows backend warning toast when start scraping with valid URL', () => {
    render(<WebpageGrabberDialog />);
    const input = document.getElementById('grabber-url') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByText('Start Scraping'));
    expect(mockAddToast).toHaveBeenCalledWith('warning', 'Real backend required', expect.any(String));
  });

  it('updates URL input on change', () => {
    render(<WebpageGrabberDialog />);
    const input = document.getElementById('grabber-url') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/page' } });
    expect(input.value).toBe('https://example.com/page');
  });

  it('updates save path on change', () => {
    render(<WebpageGrabberDialog />);
    const input = document.getElementById('grabber-path') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/custom/path' } });
    expect(input.value).toBe('/custom/path');
  });

  it('updates depth on change', () => {
    render(<WebpageGrabberDialog />);
    const select = document.getElementById('grabber-depth') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '3' } });
    expect(select.value).toBe('3');
  });

  it('updates save format on change', () => {
    render(<WebpageGrabberDialog />);
    const select = document.getElementById('grabber-format') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'text' } });
    expect(select.value).toBe('text');
  });

  it('toggles file type filter checkboxes', () => {
    render(<WebpageGrabberDialog />);
    const pagesCheckbox = screen.getByLabelText('Webpages (HTML)');
    expect(pagesCheckbox).toBeInTheDocument();
    if (pagesCheckbox instanceof HTMLInputElement) {
      expect(pagesCheckbox.checked).toBe(true);
      fireEvent.click(pagesCheckbox);
      expect(pagesCheckbox.checked).toBe(false);
    }
  });

  it('toggles follow external domains switch', () => {
    render(<WebpageGrabberDialog />);
    const sw = document.querySelector('#grabber-domains [role="switch"]');
    expect(sw).toBeInTheDocument();
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    if (sw) fireEvent.click(sw);
    expect(sw?.getAttribute('aria-checked')).toBe('true');
  });

  it('toggles overwrite existing files switch', () => {
    render(<WebpageGrabberDialog />);
    const sw = document.querySelector('#grabber-overwrite [role="switch"]');
    expect(sw).toBeInTheDocument();
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    if (sw) fireEvent.click(sw);
    expect(sw?.getAttribute('aria-checked')).toBe('false');
  });

  it('renders backup notice for missing crawler backend', () => {
    render(<WebpageGrabberDialog />);
    expect(screen.getByText(/Web Grabber will only create tasks after a real crawler backend is connected/)).toBeInTheDocument();
  });

  it('uses default save path from settings', () => {
    render(<WebpageGrabberDialog />);
    const input = document.getElementById('grabber-path') as HTMLInputElement;
    expect(input.value).toBe('/downloads');
  });

  it('uses document category folder when available', () => {
    storeRef.current = {
      ...storeRef.current,
      settings: {
        saveAndCategories: {
          categoryFolders: { document: '/docs' },
          defaultFolder: '/downloads',
        },
      },
    };
    render(<WebpageGrabberDialog />);
    const input = document.getElementById('grabber-path') as HTMLInputElement;
    expect(input.value).toBe('/docs');
  });
});
