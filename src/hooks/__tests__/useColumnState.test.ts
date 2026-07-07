import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { loadFromStorage, loadColOrder, useColumnState } from '../useColumnState';

const STORAGE_KEYS = {
  colWidths: 'nova_col_widths',
  visibleCols: 'nova_visible_cols',
  colOrder: 'nova_col_order',
} as const;

const defaultOrder = [
  'name', 'size', 'progress', 'speed', 'timeLeft', 'date', 'status',
  'retries', 'connections', 'crc32', 'priority', 'completedDate', 'sourceUrl', 'smartCategory',
];

describe('loadFromStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns fallback when localStorage is empty', () => {
    const fallback = { name: 240, size: 96 };
    expect(loadFromStorage('nonexistent', fallback)).toEqual(fallback);
  });

  it('merges stored data with fallback', () => {
    localStorage.setItem(STORAGE_KEYS.colWidths, JSON.stringify({ name: 300 }));
    const fallback = { name: 240, size: 96 };
    const result = loadFromStorage(STORAGE_KEYS.colWidths, fallback);
    expect(result).toEqual({ name: 300, size: 96 });
  });

  it('returns fallback when stored data is corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEYS.colWidths, 'not-json');
    const fallback = { name: 240 };
    expect(loadFromStorage(STORAGE_KEYS.colWidths, fallback)).toEqual(fallback);
  });

  it('merges stored data with fallback for object-like access', () => {
    localStorage.setItem('test_key', JSON.stringify({ name: 300 }));
    const fallback = { name: 240, size: 96 };
    const result = loadFromStorage('test_key', fallback);
    expect(result).toEqual({ name: 300, size: 96 });
  });
});

describe('loadColOrder', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns default order when localStorage is empty', () => {
    expect(loadColOrder()).toEqual(defaultOrder);
  });

  it('returns stored valid columns followed by missing ones', () => {
    localStorage.setItem(STORAGE_KEYS.colOrder, JSON.stringify(['size', 'name']));
    const result = loadColOrder();
    expect(result.indexOf('size')).toBeLessThan(result.indexOf('name'));
    expect(result).toHaveLength(defaultOrder.length);
  });

  it('filters out invalid column names', () => {
    localStorage.setItem(STORAGE_KEYS.colOrder, JSON.stringify(['invalid_col', 'name']));
    const result = loadColOrder();
    expect(result).not.toContain('invalid_col');
    expect(result).toContain('name');
  });

  it('returns default order when stored data is not an array', () => {
    localStorage.setItem(STORAGE_KEYS.colOrder, JSON.stringify('string'));
    expect(loadColOrder()).toEqual(defaultOrder);
  });

  it('returns default order when stored data is corrupt', () => {
    localStorage.setItem(STORAGE_KEYS.colOrder, 'corrupt');
    expect(loadColOrder()).toEqual(defaultOrder);
  });
});

describe('useColumnState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('initializes with default column widths', () => {
    const { result } = renderHook(() => useColumnState());
    expect(result.current.colWidths.name).toBe(240);
    expect(result.current.colWidths.size).toBe(96);
  });

  it('initializes with default visible columns', () => {
    const { result } = renderHook(() => useColumnState());
    expect(result.current.visibleCols.name).toBe(true);
    expect(result.current.visibleCols.retries).toBe(false);
  });

  it('initializes with default column order', () => {
    const { result } = renderHook(() => useColumnState());
    expect(result.current.colOrder).toEqual(defaultOrder);
  });

  it('computes visibleColsCount from visible columns + 2', () => {
    const { result } = renderHook(() => useColumnState());
    const visibleCount = Object.values(result.current.visibleCols).filter(Boolean).length + 2;
    expect(result.current.visibleColsCount).toBe(visibleCount);
  });

  it('sets showColConfig', () => {
    const { result } = renderHook(() => useColumnState());
    expect(result.current.showColConfig).toBe(false);
    act(() => result.current.setShowColConfig(true));
    expect(result.current.showColConfig).toBe(true);
  });

  it('sets colWidths via setColWidths', () => {
    const { result } = renderHook(() => useColumnState());
    act(() => result.current.setColWidths({ name: 300 }));
    expect(result.current.colWidths.name).toBe(300);
  });

  it('sets visibleCols via setVisibleCols', () => {
    const { result } = renderHook(() => useColumnState());
    act(() => result.current.setVisibleCols({ name: false }));
    expect(result.current.visibleCols.name).toBe(false);
  });

  it('sets colOrder via setColOrder', () => {
    const { result } = renderHook(() => useColumnState());
    act(() => result.current.setColOrder(['size', 'name']));
    expect(result.current.colOrder[0]).toBe('size');
  });

  it('handles drag start/end for header columns', () => {
    const { result } = renderHook(() => useColumnState());
    expect(result.current.draggingCol).toBeNull();

    const dragEvent = {
      dataTransfer: {
        effectAllowed: '',
        setData: vi.fn(),
        getData: vi.fn(),
      },
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    } as unknown as React.DragEvent;

    act(() => result.current.handleDragStart(dragEvent, 'name'));
    expect(result.current.draggingCol).toBe('name');

    act(() => result.current.handleDragEnd());
    expect(result.current.draggingCol).toBeNull();
  });

  it('handles customize drag start/end', () => {
    const { result } = renderHook(() => useColumnState());
    expect(result.current.draggingCustomizeCol).toBeNull();

    const dragEvent = {
      dataTransfer: {
        effectAllowed: '',
        setData: vi.fn(),
        getData: vi.fn(),
      },
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    } as unknown as React.DragEvent;

    act(() => result.current.handleCustomizeDragStart(dragEvent, 'size'));
    expect(result.current.draggingCustomizeCol).toBe('size');

    act(() => result.current.handleCustomizeDragEnd());
    expect(result.current.draggingCustomizeCol).toBeNull();
  });

  it('persists column widths to localStorage', () => {
    const { result } = renderHook(() => useColumnState());
    act(() => result.current.setColWidths({ name: 300 }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.colWidths) || '{}');
    expect(stored.name).toBe(300);
  });

  it('persists visible columns to localStorage', () => {
    const { result } = renderHook(() => useColumnState());
    act(() => result.current.setVisibleCols({ retries: true }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.visibleCols) || '{}');
    expect(stored.retries).toBe(true);
  });

  it('persists column order to localStorage', () => {
    const { result } = renderHook(() => useColumnState());
    act(() => result.current.setColOrder(['size', 'name']));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.colOrder) || '[]');
    expect(stored[0]).toBe('size');
  });
});
