import React, { useState, useEffect, useRef } from 'react';

const STORAGE_KEYS = {
  colWidths: 'nova_col_widths',
  visibleCols: 'nova_visible_cols',
  colOrder: 'nova_col_order',
} as const;

const defaultWidths: { [key: string]: number } = {
  name: 240,
  size: 96,
  progress: 160,
  speed: 110,
  timeLeft: 110,
  date: 130,
  status: 96,
  retries: 80,
  connections: 85,
  crc32: 90,
  priority: 95,
  completedDate: 130,
  sourceUrl: 180,
  smartCategory: 125,
};

const defaultCols: { [key: string]: boolean } = {
  name: true,
  size: true,
  progress: true,
  speed: true,
  timeLeft: true,
  date: true,
  status: true,
  retries: false,
  connections: false,
  crc32: false,
  priority: false,
  completedDate: false,
  sourceUrl: false,
  smartCategory: false,
};

const defaultOrder = [
  'name',
  'size',
  'progress',
  'speed',
  'timeLeft',
  'date',
  'status',
  'retries',
  'connections',
  'crc32',
  'priority',
  'completedDate',
  'sourceUrl',
  'smartCategory',
];

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const cached = localStorage.getItem(key);
    if (cached) {
      const parsed = JSON.parse(cached) as Partial<T>;
      return { ...fallback, ...parsed };
    }
  } catch {
    // Corrupt localStorage entry — fall back to defaults.
  }
  return fallback;
}

function loadColOrder(): string[] {
  try {
    const cached = localStorage.getItem(STORAGE_KEYS.colOrder);
    if (cached) {
      const parsed = JSON.parse(cached) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const valid = parsed.filter((item) => defaultOrder.includes(item));
        const missing = defaultOrder.filter((item) => !valid.includes(item));
        return [...valid, ...missing];
      }
    }
  } catch {
    // Corrupt localStorage entry — fall back to defaults.
  }
  return defaultOrder;
}

export function useColumnState() {
  const [colWidths, setColWidths] = useState<{ [key: string]: number }>(() =>
    loadFromStorage(STORAGE_KEYS.colWidths, defaultWidths),
  );
  const [visibleCols, setVisibleCols] = useState<{ [key: string]: boolean }>(() =>
    loadFromStorage(STORAGE_KEYS.visibleCols, defaultCols),
  );
  const [colOrder, setColOrder] = useState<string[]>(loadColOrder);
  const [draggingCol, setDraggingCol] = useState<string | null>(null);
  const [draggingCustomizeCol, setDraggingCustomizeCol] = useState<string | null>(null);
  const [showColConfig, setShowColConfig] = useState(false);
  const colConfigRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.colWidths, JSON.stringify(colWidths));
  }, [colWidths]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.visibleCols, JSON.stringify(visibleCols));
  }, [visibleCols]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.colOrder, JSON.stringify(colOrder));
  }, [colOrder]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (colConfigRef.current && !colConfigRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (!target.closest('button')) {
          setShowColConfig(false);
        }
      }
    };
    window.addEventListener('click', handleOutsideClick);
    return () => {
      window.removeEventListener('click', handleOutsideClick);
    };
  }, []);

  const visibleColsCount = Object.values(visibleCols).filter(Boolean).length + 2;

  // Column resizing
  const startResize = (colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[colKey];

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const diff = moveEvent.clientX - startX;
      const directionMultiplier = document.documentElement.dir === 'rtl' ? -1 : 1;
      const calculatedWidth = startWidth + diff * directionMultiplier;
      setColWidths((prev) => ({
        ...prev,
        [colKey]: Math.max(60, calculatedWidth),
      }));
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('select-none');
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.classList.add('select-none');
  };

  // Header column drag-and-drop
  const handleDragStart = (e: React.DragEvent, colKey: string) => {
    if (e.target instanceof HTMLElement && e.target.closest('.cursor-col-resize')) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    setDraggingCol(colKey);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-nova-column', colKey);
    e.dataTransfer.setData('text/plain', colKey);
  };

  const handleDragOver = (e: React.DragEvent, colKey: string) => {
    if (draggingCol && draggingCol !== colKey) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleDrop = (e: React.DragEvent, targetColKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceColKey =
      e.dataTransfer.getData('application/x-nova-column') || e.dataTransfer.getData('text/plain') || draggingCol;
    if (sourceColKey && sourceColKey !== targetColKey) {
      setColOrder((prev) => {
        const newOrder = prev.filter((k) => k !== sourceColKey);
        const targetIdx = newOrder.indexOf(targetColKey);
        if (targetIdx !== -1) {
          newOrder.splice(targetIdx, 0, sourceColKey);
        } else {
          newOrder.push(sourceColKey);
        }
        return newOrder;
      });
    }
    setDraggingCol(null);
  };

  const handleDragEnd = () => {
    setDraggingCol(null);
  };

  // Customize panel drag-and-drop
  const handleCustomizeDragStart = (e: React.DragEvent, colKey: string) => {
    setDraggingCustomizeCol(colKey);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-nova-customize-column', colKey);
    e.dataTransfer.setData('text/plain', colKey);
  };

  const handleCustomizeDragOver = (e: React.DragEvent, colKey: string) => {
    if (draggingCustomizeCol && draggingCustomizeCol !== colKey) {
      e.preventDefault();
    }
  };

  const handleCustomizeDrop = (e: React.DragEvent, targetColKey: string) => {
    e.preventDefault();
    const sourceColKey =
      e.dataTransfer.getData('application/x-nova-customize-column') ||
      e.dataTransfer.getData('text/plain') ||
      draggingCustomizeCol;
    if (sourceColKey && sourceColKey !== targetColKey) {
      setColOrder((prev) => {
        const newOrder = prev.filter((k) => k !== sourceColKey);
        const targetIdx = newOrder.indexOf(targetColKey);
        if (targetIdx !== -1) {
          newOrder.splice(targetIdx, 0, sourceColKey);
        } else {
          newOrder.push(sourceColKey);
        }
        return newOrder;
      });
    }
    setDraggingCustomizeCol(null);
  };

  const handleCustomizeDragEnd = () => {
    setDraggingCustomizeCol(null);
  };

  return {
    colWidths,
    visibleCols,
    colOrder,
    draggingCol,
    draggingCustomizeCol,
    showColConfig,
    colConfigRef,
    visibleColsCount,
    setColWidths,
    setVisibleCols,
    setColOrder,
    setShowColConfig,
    startResize,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
    handleCustomizeDragStart,
    handleCustomizeDragOver,
    handleCustomizeDrop,
    handleCustomizeDragEnd,
  };
}
