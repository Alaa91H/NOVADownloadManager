import React from 'react';
import { GripVertical } from 'lucide-react';
import { useAppStore } from '../state/appStore';

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
  handleCustomizeDragStart,
  handleCustomizeDragOver,
  handleCustomizeDrop,
  handleCustomizeDragEnd,
}) => {
  const { t } = useAppStore();
  return (
    <div className="absolute left-3 top-10 z-[100] w-64 p-3 bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] rounded-lg shadow-xl space-y-2 animate-in fade-in duration-100">
      <div className="border-b border-[var(--border-color)] pb-1.5 mb-1">
        <h4 className="text-xs font-bold text-[var(--accent-primary)]">{t('col_customize_title')}</h4>
        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{t('col_customize_desc')}</p>
      </div>
      <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
        {colOrder.map((colKey) => {
          const label = colKeyToTKey[colKey] ? t(colKeyToTKey[colKey]) : colKey;
          const isDragging = draggingCustomizeCol === colKey;

          return (
            <div
              key={colKey}
              draggable="true"
              onDragStart={(e) => {
                handleCustomizeDragStart(e, colKey);
              }}
              onDragOver={(e) => {
                handleCustomizeDragOver(e, colKey);
              }}
              onDrop={(e) => {
                handleCustomizeDrop(e, colKey);
              }}
              onDragEnd={handleCustomizeDragEnd}
              className={`flex items-center gap-2 p-1.5 rounded text-[11px] font-semibold border transition-all ${
                isDragging
                  ? 'opacity-40 border-dashed border-[var(--accent-primary)] bg-[var(--bg-hover)]'
                  : 'border-transparent bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)]'
              } ${colKey === 'name' ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
            >
              <input
                type="checkbox"
                checked={visibleCols[colKey] || false}
                disabled={colKey === 'name'}
                onChange={() => {
                  if (colKey !== 'name') setVisibleCols((prev) => ({ ...prev, [colKey]: !prev[colKey] }));
                }}
                className="rounded border-[var(--border-color)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer disabled:opacity-40"
              />
              {colKey !== 'name' && <GripVertical className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />}
              <span className="flex-1 truncate">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ColumnConfigPanel;
