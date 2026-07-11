import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';

const ThrowError: React.FC<{ shouldThrow?: boolean; msg?: string }> = ({ shouldThrow, msg }) => {
  if (shouldThrow) {
    throw new Error(msg);
  }
  return <div>Normal content</div>;
};

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>Child content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('renders error UI when child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow msg="Test error message" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This section encountered an error.')).toBeInTheDocument();
    expect(screen.getByText('Test error message')).toBeInTheDocument();
    expect(screen.getByText('Reload Section')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('renders fallback message when error has no message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow msg={undefined} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('retry button resets error state and shows children again', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary>
        <ThrowError shouldThrow msg="Test error message" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This section encountered an error.')).toBeInTheDocument();
    rerender(
      <ErrorBoundary>
        <div>Recovered content</div>
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Reload Section'));
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    spy.mockRestore();
  });
});
