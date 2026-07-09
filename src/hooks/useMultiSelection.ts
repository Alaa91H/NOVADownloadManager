import React, { useState } from 'react';

export function useMultiSelection(sortedTaskIds: string[]) {
  const [checkedTaskIds, setCheckedTaskIds] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);

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

  const selectAll = () => {
    setCheckedTaskIds(new Set(sortedTaskIds));
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
    handleToggleCheckAll,
    handleToggleCheckTask,
    selectAll,
    clearSelection,
  };
}
