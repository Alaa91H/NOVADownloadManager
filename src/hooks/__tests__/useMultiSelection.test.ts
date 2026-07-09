import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMultiSelection } from '../useMultiSelection';

describe('useMultiSelection', () => {
  const taskIds = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('initial state is empty selection', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    expect(result.current.checkedTaskIds.size).toBe(0);
    expect(result.current.isAllChecked).toBe(false);
    expect(result.current.isSomeChecked).toBe(false);
  });

  it('toggles a single task on click', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => {
      result.current.handleToggleCheckTask('id-1', { stopPropagation: vi.fn(), shiftKey: false } as unknown as React.MouseEvent);
    });
    expect(result.current.checkedTaskIds.has('id-1')).toBe(true);
    expect(result.current.checkedTaskIds.size).toBe(1);
    act(() => {
      result.current.handleToggleCheckTask('id-1', { stopPropagation: vi.fn(), shiftKey: false } as unknown as React.MouseEvent);
    });
    expect(result.current.checkedTaskIds.has('id-1')).toBe(false);
    expect(result.current.checkedTaskIds.size).toBe(0);
  });

  it('selects all with selectAll', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => { result.current.selectAll(); });
    expect(result.current.checkedTaskIds.size).toBe(5);
    expect(result.current.isAllChecked).toBe(true);
    expect(result.current.isSomeChecked).toBe(false);
  });

  it('clears selection with clearSelection', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => { result.current.selectAll(); });
    act(() => { result.current.clearSelection(); });
    expect(result.current.checkedTaskIds.size).toBe(0);
  });

  it('toggles all with handleToggleCheckAll', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => { result.current.handleToggleCheckAll(); });
    expect(result.current.checkedTaskIds.size).toBe(5);
    act(() => { result.current.handleToggleCheckAll(); });
    expect(result.current.checkedTaskIds.size).toBe(0);
  });

  it('selects range with shift+click', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => {
      result.current.handleToggleCheckTask('id-1', { stopPropagation: vi.fn(), shiftKey: false } as unknown as React.MouseEvent);
    });
    act(() => {
      result.current.handleToggleCheckTask('id-3', { stopPropagation: vi.fn(), shiftKey: true } as unknown as React.MouseEvent);
    });
    expect(result.current.checkedTaskIds.size).toBe(3);
    expect(result.current.checkedTaskIds.has('id-1')).toBe(true);
    expect(result.current.checkedTaskIds.has('id-2')).toBe(true);
    expect(result.current.checkedTaskIds.has('id-3')).toBe(true);
  });

  it('isSomeChecked is true when only some are selected', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => {
      result.current.handleToggleCheckTask('id-1', { stopPropagation: vi.fn(), shiftKey: false } as unknown as React.MouseEvent);
    });
    expect(result.current.isAllChecked).toBe(false);
    expect(result.current.isSomeChecked).toBe(true);
  });

  it('returns isAllChecked=false for empty task list', () => {
    const { result } = renderHook(() => useMultiSelection([]));
    expect(result.current.isAllChecked).toBe(false);
    expect(result.current.isSomeChecked).toBe(false);
  });

  it('long press toggles task after 600ms', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => {
      result.current.startRowPress('id-2', { button: 0 } as unknown as React.MouseEvent);
    });
    expect(result.current.checkedTaskIds.size).toBe(0);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.checkedTaskIds.has('id-2')).toBe(true);
  });

  it('cancelRowPress clears the press timer', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => {
      result.current.startRowPress('id-3', { button: 0 } as unknown as React.MouseEvent);
    });
    act(() => {
      result.current.cancelRowPress();
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.checkedTaskIds.size).toBe(0);
  });

  it('endRowPress toggles if some items already checked', () => {
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => { result.current.selectAll(); });
    act(() => {
      result.current.endRowPress('id-5', {} as unknown as React.MouseEvent);
    });
    expect(result.current.checkedTaskIds.has('id-5')).toBe(false);
  });

  it('endRowPress with onSelect and no checked items selects normally', () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useMultiSelection(taskIds));
    act(() => {
      result.current.endRowPress('id-1', {} as unknown as React.MouseEvent, onSelect);
    });
    expect(onSelect).toHaveBeenCalledWith('id-1');
  });
});
