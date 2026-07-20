import React, { useState, useRef, useCallback } from 'react';
import { GripVertical, Check, ChevronUp, ChevronDown, X, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useI18n } from '../store/selectors';

const colKeyToTKey: Record<string, string> = {
  name: 'col_name',
  size: 'col_size',
  progress: 'col_progress',
  speed: 'col_speed',
  timeLeft: 'col_time_left',
  date: 'col_date_added',
  status: 'col_status',
  retries: 'col_retries',
  connections: 'col_threads',
  priority: 'col_priority',
  completedDate: 'col_date_completed',
  sourceUrl: 'col_url',
  smartCategory: 'col_smart_category',
};

interface ColumnConfigPanelProps {
  colOrder: string[];
  visibleCols: { [key: string]: boolean };
  draggingCustomizeCol: string | null;
  setVisibleCols: (fn: (prev: { [key: string]: boolean }) => { [key: string]: boolean }) => void;
  setColOrder: (fn: (prev: string[]) => string[]) => void;
  handleCustomizeDragStart: (e: React.DragEvent, colKey: string) => void;
  handleCustomizeDragOver: (e: React.DragEvent, colKey: string) => void;
  handleCustomizeDrop: (e: React.DragEvent, targetColKey: string) => void;
  handleCustomizeDragEnd: () => void;
}

const ColumnConfigPanel: React.FC<ColumnConfigPanelProps> = ({
  colOrder,
  visibleCols,
  draggingCustomizeCol,
  setVisibleCols,
  setColOrder,
  handleCustomizeDragStart,
  handleCustomizeDragOver,
  handleCustomizeDrop,
  handleCustomizeDragEnd,
}) => {
  const t = useI18n();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragOverCounter = useRef<Record<string, number>>({});

  const moveCol = useCallback(
    (colKey: string, direction: -1 | 1) => {
      setColOrder((prev) => {
        const idx = prev.indexOf(colKey);
        if (idx === -1) return prev;
        const next = [...prev];
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= next.length) return prev;
        [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
        return next;
      });
    },
    [setColOrder],
  );

  const toggleCol = useCallback(
    (colKey: string) => {
      if (colKey === 'name') return;
      setVisibleCols((prev) => ({ ...prev, [colKey]: !prev[colKey] }));
    },
    [setVisibleCols],
  );

  const showAll = useCallback(() => {
    setVisibleCols((prev) => {
      const next = { ...prev };
      colOrder.forEach((k) => {
        if (k !== 'name') next[k] = true;
      });
      return next;
    });
  }, [colOrder, setVisibleCols]);

  const hideAll = useCallback(() => {
    setVisibleCols((prev) => ({ ...prev, name: true }));
  }, [setVisibleCols]);

  const resetDefaults = useCallback(() => {
    const defaults: { [key: string]: boolean } = {
      name: true,
      size: true,
      progress: true,
      speed: true,
      timeLeft: true,
      date: true,
      status: true,
      retries: false,
      connections: false,
      priority: false,
      completedDate: false,
      sourceUrl: false,
      smartCategory: false,
    };
    setVisibleCols(() => ({ ...defaults }));
  }, [setVisibleCols]);

  const onDragOver = (e: React.DragEvent, colKey: string) => {
    if (e.dataTransfer.types.includes('application/x-nova-customize-column')) {
      e.preventDefault();
      handleCustomizeDragOver(e, colKey);
      if (draggingCustomizeCol && draggingCustomizeCol !== colKey) {
        dragOverCounter.current[colKey] = (dragOverCounter.current[colKey] || 0) + 1;
        setDropTarget(colKey);
      }
    }
  };

  const onDragLeave = (colKey: string) => {
    if (dragOverCounter.current[colKey]) {
      dragOverCounter.current[colKey] -= 1;
      if (dragOverCounter.current[colKey] === 0) {
        setDropTarget(null);
      }
    }
  };

  const onDrop = (e: React.DragEvent, colKey: string) => {
    handleCustomizeDrop(e, colKey);
    setDropTarget(null);
    dragOverCounter.current = {};
  };

  return (
    <div className="absolute top-full mt-1.5 ltr:right-0 rtl:left-0 z-[100] w-72 p-3 bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] rounded-lg shadow-2xl space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
      {/* Header with close */}
      <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-2">
        <div className="flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
          <h4 className="text-xs font-extrabold text-[var(--text-primary)]">{t('col_customize_title')}</h4>
        </div>
        <button
          type="button"
          onClick={() => {
            const evt = new MouseEvent('click', { bubbles: true });
            document.body.dispatchEvent(evt);
          }}
          className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">{t('col_customize_desc')}</p>

      {/* Action bar */}
      <div className="flex items-center gap-1 py-1 border-b border-[var(--border-color)]/50">
        <button
          type="button"
          onClick={showAll}
          className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          <Eye className="w-3 h-3" />
          All
        </button>
        <button
          type="button"
          onClick={hideAll}
          className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          <EyeOff className="w-3 h-3" />
          None
        </button>
        <button
          type="button"
          onClick={resetDefaults}
          className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>

      {/* Column list */}
      <div className="space-y-0.5 max-h-72 overflow-y-auto pr-1 -mr-1">
        {colOrder.map((colKey, idx) => {
          const label = colKeyToTKey[colKey] ? t(colKeyToTKey[colKey]) : colKey;
          const isVisible = visibleCols[colKey] || false;
          const isLocked = colKey === 'name';
          const isDragging = draggingCustomizeCol === colKey;
          const isDropTarget = dropTarget === colKey && !isDragging;

          return (
            <div
              key={colKey}
              draggable={!isLocked}
              onDragStart={(e) => {
                if (isLocked) {
                  e.preventDefault();
                  return;
                }
                handleCustomizeDragStart(e, colKey);
              }}
              onDragOver={(e) => {
                onDragOver(e, colKey);
              }}
              onDragLeave={() => {
                onDragLeave(colKey);
              }}
              onDrop={(e) => {
                onDrop(e, colKey);
              }}
              onDragEnd={handleCustomizeDragEnd}
              className={`group flex items-center gap-1.5 p-1.5 rounded-md text-[11px] font-semibold border transition-all ${
                isDragging
                  ? 'opacity-30 border-dashed border-[var(--accent-primary)]'
                  : isDropTarget
                    ? 'border-solid border-[var(--accent-primary)] bg-[var(--accent-primary)]/10'
                    : isVisible
                      ? 'border-[var(--border-color)]/40 bg-[var(--bg-surface)]'
                      : 'border-transparent bg-[var(--bg-surface)]/30 opacity-60'
              } ${isLocked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
            >
              {/* Checkbox (left) */}
              <button
                type="button"
                onClick={() => {
                  toggleCol(colKey);
                }}
                disabled={isLocked}
                className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-all cursor-pointer disabled:cursor-default disabled:opacity-60 ${
                  isVisible
                    ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)]'
                    : 'bg-[var(--bg-input)] border-[var(--border-color)]'
                }`}
                aria-label={`Toggle ${label}`}
              >
                {isVisible && <Check className="w-2.5 h-2.5 text-white" strokeWidth={4} />}
              </button>

              {/* Drag handle (between) */}
              {!isLocked && (
                <GripVertical className="w-3 h-3 text-[var(--text-muted)] shrink-0 group-hover:text-[var(--text-primary)]" />
              )}

              {/* Label (right) */}
              <span
                className={`flex-1 truncate ${isVisible ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] line-through decoration-1'}`}
              >
                {label}
              </span>

              {/* Move buttons (right) */}
              {!isLocked && (
                <div className="flex flex-col shrink-0 -my-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      moveCol(colKey, -1);
                    }}
                    disabled={idx === 0}
                    className="p-0.5 text-[var(--text-muted)] hover:text-[var(--accent-primary)] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Move up"
                  >
                    <ChevronUp className="w-2.5 h-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      moveCol(colKey, 1);
                    }}
                    disabled={idx === colOrder.length - 1}
                    className="p-0.5 text-[var(--text-muted)] hover:text-[var(--accent-primary)] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Move down"
                  >
                    <ChevronDown className="w-2.5 h-2.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[9px] text-[var(--text-muted)] leading-relaxed border-t border-[var(--border-color)]/50 pt-1.5">
        Drag rows to reorder • Click ✓ to toggle • Use ↑↓ for fine control
      </p>
    </div>
  );
};

export default ColumnConfigPanel;
