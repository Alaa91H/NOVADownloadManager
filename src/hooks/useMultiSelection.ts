import React, { useState, useRef } from 'react';

export function useMultiSelection(sortedTaskIds: string[]) {
  const [checkedTaskIds, setCheckedTaskIds] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);

  const pressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isLongPressTriggered = useRef(false);

  const startRowPress = (taskId: string, e: React.MouseEvent | React.TouchEvent) => {
    if ('button' in e && e.button !== 0) return;
    isLongPressTriggered.current = false;
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
    }
    pressTimerRef.current = setTimeout(() => {
      isLongPressTriggered.current = true;
      setCheckedTaskIds((prev) => {
        const next = new Set(prev);
        if (next.has(taskId)) {
          next.delete(taskId);
        } else {
          next.add(taskId);
        }
        return next;
      });
    }, 600);
  };

  const endRowPress = (taskId: string, _e: React.MouseEvent | React.TouchEvent, onSelect?: (id: string) => void) => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    if (!isLongPressTriggered.current) {
      if (checkedTaskIds.size > 0) {
        setCheckedTaskIds((prev) => {
          const next = new Set(prev);
          if (next.has(taskId)) {
            next.delete(taskId);
          } else {
            next.add(taskId);
          }
          return next;
        });
      } else if (onSelect) {
        onSelect(taskId);
      }
    }
    isLongPressTriggered.current = false;
  };

  const cancelRowPress = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    isLongPressTriggered.current = false;
  };

  const handleToggleCheckAll = () => {
    const isAllChecked = sortedTaskIds.length > 0 && sortedTaskIds.every((id) => checkedTaskIds.has(id));
    setCheckedTaskIds((prev) => {
      const next = new Set(prev);
      if (isAllChecked) {
        sortedTaskIds.forEach((id) => next.delete(id));
      } else {
        sortedTaskIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const handleToggleCheckTask = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCheckedTaskIds((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastCheckedId) {
        const currentIndex = sortedTaskIds.indexOf(id);
        const lastIndex = sortedTaskIds.indexOf(lastCheckedId);
        if (currentIndex !== -1 && lastIndex !== -1) {
          const start = Math.min(currentIndex, lastIndex);
          const end = Math.max(currentIndex, lastIndex);
          const rangeIds = sortedTaskIds.slice(start, end + 1);
          const shouldCheck = !prev.has(id);
          rangeIds.forEach((rangeId) => {
            if (shouldCheck) {
              next.add(rangeId);
            } else {
              next.delete(rangeId);
            }
          });
        }
      } else {
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
    setLastCheckedId(id);
  };

  const clearSelection = () => {
    setCheckedTaskIds(new Set());
  };

  const isAllChecked = sortedTaskIds.length > 0 && sortedTaskIds.every((id) => checkedTaskIds.has(id));
  const isSomeChecked = sortedTaskIds.length > 0 && !isAllChecked && sortedTaskIds.some((id) => checkedTaskIds.has(id));

  return {
    checkedTaskIds,
    isAllChecked,
    isSomeChecked,
    startRowPress,
    endRowPress,
    cancelRowPress,
    handleToggleCheckAll,
    handleToggleCheckTask,
    clearSelection,
  };
}
