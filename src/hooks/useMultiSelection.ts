import type React from 'react';
import { useState, useCallback, useMemo } from 'react';

export function useMultiSelection(sortedTaskIds: string[]) {
  const [checkedTaskIds, setCheckedTaskIds] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);

  const cleanedCheckedTaskIds = useMemo(() => {
    const valid = new Set(sortedTaskIds);
    const next = new Set<string>();
    let changed = false;
    for (const id of checkedTaskIds) {
      if (valid.has(id)) next.add(id);
      else changed = true;
    }
    return changed ? next : checkedTaskIds;
  }, [sortedTaskIds, checkedTaskIds]);

  const handleToggleCheckAll = () => {
    const isAllChecked = sortedTaskIds.length > 0 && sortedTaskIds.every((id) => cleanedCheckedTaskIds.has(id));
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

  const selectAll = useCallback(() => {
    setCheckedTaskIds(new Set(sortedTaskIds));
  }, [sortedTaskIds]);

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

  const isAllChecked = useMemo(
    () => sortedTaskIds.length > 0 && sortedTaskIds.every((id) => checkedTaskIds.has(id)),
    [sortedTaskIds, checkedTaskIds],
  );
  const isSomeChecked = useMemo(
    () => sortedTaskIds.length > 0 && !isAllChecked && sortedTaskIds.some((id) => checkedTaskIds.has(id)),
    [sortedTaskIds, checkedTaskIds, isAllChecked],
  );

  return {
    checkedTaskIds: cleanedCheckedTaskIds,
    isAllChecked,
    isSomeChecked,
    handleToggleCheckAll,
    handleToggleCheckTask,
    selectAll,
    clearSelection,
  };
}
