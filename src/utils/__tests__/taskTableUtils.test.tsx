import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { getSortField, getColAlign, formatSpeed, formatTimeLeft, renderSortIcon, columnLabels } from '../taskTableUtils';

vi.mock('../../initialData', () => ({
  formatSpeed: vi.fn((bps: number) => {
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
    if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} KB/s`;
    return `${bps} B/s`;
  }),
  formatTimeLeft: vi.fn((sec: number) => {
    if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${sec}s`;
  }),
}));

describe('columnLabels', () => {
  it('contains expected keys', () => {
    expect(columnLabels.name).toBe('Filename');
    expect(columnLabels.size).toBe('Size');
    expect(columnLabels.status).toBe('Status');
  });
});

describe('getSortField', () => {
  it('maps "size" to "sizeBytes"', () => {
    expect(getSortField('size')).toBe('sizeBytes');
  });

  it('maps "date" to "dateAdded"', () => {
    expect(getSortField('date')).toBe('dateAdded');
  });

  it('passes through unknown keys', () => {
    expect(getSortField('name')).toBe('name');
    expect(getSortField('status')).toBe('status');
  });
});

describe('getColAlign', () => {
  it('returns "text-left" for name and sourceUrl', () => {
    expect(getColAlign('name')).toBe('text-left');
    expect(getColAlign('sourceUrl')).toBe('text-left');
  });

  it('returns "text-start" for all others', () => {
    expect(getColAlign('size')).toBe('text-start');
    expect(getColAlign('status')).toBe('text-start');
    expect(getColAlign('progress')).toBe('text-start');
  });
});

describe('formatSpeed', () => {
  it('returns "--" for zero or negative speed', () => {
    expect(formatSpeed(0)).toBe('--');
    expect(formatSpeed(-1)).toBe('--');
  });

  it('returns formatted speed for positive values', () => {
    expect(formatSpeed(1500)).toBe('1.5 KB/s');
  });
});

describe('formatTimeLeft', () => {
  it('returns "--" for zero or negative time', () => {
    expect(formatTimeLeft(0)).toBe('--');
    expect(formatTimeLeft(-5)).toBe('--');
  });

  it('returns formatted time for positive values', () => {
    const result = formatTimeLeft(3661);
    expect(result).not.toBe('--');
  });
});

describe('renderSortIcon', () => {
  it('renders an SVG element', () => {
    const { container } = render(<>{renderSortIcon('name', 'asc', 'name')}</>);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders with highlighted asc when active and asc', () => {
    const { container } = render(<>{renderSortIcon('name', 'asc', 'name')}</>);
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBeGreaterThan(0);
  });

  it('renders with highlighted desc when active and desc', () => {
    const { container } = render(<>{renderSortIcon('name', 'desc', 'name')}</>);
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBeGreaterThan(0);
  });

  it('renders muted when inactive', () => {
    const { container } = render(<>{renderSortIcon('name', 'asc', 'status')}</>);
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBeGreaterThan(0);
  });
});
