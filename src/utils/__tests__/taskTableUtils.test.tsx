import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { getSortField, getColAlign, getFileTypeIcon, renderSortIcon } from '../taskTableUtils';

describe('getSortField', () => {
  it('maps display keys to sort columns', () => {
    expect(getSortField('size')).toBe('sizeBytes');
    expect(getSortField('date')).toBe('dateAdded');
    expect(getSortField('name')).toBe('name');
    expect(getSortField('status')).toBe('status');
  });
});

describe('getColAlign', () => {
  it('left-aligns name and sourceUrl, start-aligns everything else', () => {
    expect(getColAlign('name')).toBe('text-left');
    expect(getColAlign('sourceUrl')).toBe('text-left');
    expect(getColAlign('status')).toBe('text-start');
    expect(getColAlign('sizeBytes')).toBe('text-start');
  });
});

describe('getFileTypeIcon', () => {
  it('renders an icon for each file type', () => {
    const types = ['compressed', 'program', 'video', 'audio', 'document', 'other'] as const;
    for (const type of types) {
      const { container } = render(<>{getFileTypeIcon(type)}</>);
      expect(container.querySelector('svg')).not.toBeNull();
    }
  });

  it('applies a custom size class', () => {
    const { container } = render(<>{getFileTypeIcon('video', 'w-8 h-8')}</>);
    // Use getAttribute: SVG className is an SVGAnimatedString in jsdom.
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('w-8 h-8');
  });
});

describe('renderSortIcon', () => {
  it('renders an svg with default class', () => {
    const { container } = render(<>{renderSortIcon('name', 'asc', 'name')}</>);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
