import React from 'react';
import { TimePicker } from './primitives/TimePicker';

interface SchedulerBasicTabProps {
  name: string;
  onNameChange: (v: string) => void;
  smartScheduleType: 'once' | 'daily' | 'weekly';
  onScheduleTypeChange: (v: 'once' | 'daily' | 'weekly') => void;
  isScheduled: boolean;
  onScheduledChange: (v: boolean) => void;
  startTime: string;
  onStartTimeChange: (v: string) => void;
  endTime: string;
  onEndTimeChange: (v: string) => void;
  days: number[];
  onToggleDay: (day: number) => void;
  maxActive: number;
  onMaxActiveChange: (v: number) => void;
}

const weekDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const SchedulerBasicTab: React.FC<SchedulerBasicTabProps> = ({
  name,
  onNameChange,
  smartScheduleType,
  onScheduleTypeChange,
  isScheduled,
  onScheduledChange,
  startTime,
  onStartTimeChange,
  endTime,
  onEndTimeChange,
  days,
  onToggleDay,
  maxActive,
  onMaxActiveChange,
}) => {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <span className="text-[11px] font-bold text-[var(--text-secondary)]">{'List name to edit:'}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => {
            onNameChange(e.target.value);
          }}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg p-2.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)] font-bold shadow-sm"
        />
      </div>

      <div className="space-y-1">
        <span className="text-[11px] font-bold text-[var(--text-secondary)]">{'Schedule Type:'}</span>
        <div className="grid grid-cols-3 gap-1 bg-[var(--bg-input)] p-1 rounded-lg border border-[var(--border-color)]">
          {(['once', 'daily', 'weekly'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                onScheduleTypeChange(type);
              }}
              className={`py-1.5 text-[10px] md:text-xs font-bold rounded-md cursor-pointer ${
                smartScheduleType === type
                  ? 'text-white font-extrabold bg-[var(--accent-primary)]/10'
                  : 'text-[var(--text-muted)] hover:text-white bg-transparent'
              }`}
            >
              {type === 'once' ? 'Once' : type === 'daily' ? 'Daily Recurrent' : 'Custom Days'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
        <div className="flex flex-col text-right">
          <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">{'Enable Automatic Timer'}</span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {'Start and stop the list automatically based on the time below'}
          </span>
        </div>
        <input
          type="checkbox"
          checked={isScheduled}
          onChange={(e) => {
            onScheduledChange(e.target.checked);
          }}
          className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
        />
      </div>

      {isScheduled && (
        <div className="space-y-4 p-4 bg-[var(--bg-input)]/40 border border-[var(--border-color)] rounded-xl shadow-inner">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TimePicker label={'Start Time:'} value={startTime} onChange={onStartTimeChange} />
            <TimePicker label={'Stop Time:'} value={endTime} onChange={onEndTimeChange} />
          </div>

          <div className="space-y-1.5 pt-1">
            <span className="text-[11px] text-[var(--text-muted)] block mb-1 font-bold">{'Days of the Week:'}</span>
            <div className="flex flex-wrap gap-1.5">
              {[0, 1, 2, 3, 4, 5, 6].map((d) => {
                const active = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      onToggleDay(d);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${
                      active
                        ? 'text-white font-extrabold bg-[var(--accent-primary)]/10 shadow-sm'
                        : 'text-[var(--text-muted)] hover:text-white bg-transparent'
                    }`}
                  >
                    {weekDays[d]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <span className="text-[11px] font-bold text-[var(--text-secondary)]">{'Max Concurrent Downloads:'}</span>
        <select
          value={maxActive}
          onChange={(e) => {
            onMaxActiveChange(Number(e.target.value));
          }}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-8 pr-3 py-2.5 text-xs focus:outline-none text-[var(--text-primary)] font-bold cursor-pointer shadow-sm"
        >
          <option value={1}>{'1 file sequentially (Recommended)'}</option>
          <option value={2}>{'2 files concurrently'}</option>
          <option value={3}>{'3 files concurrently'}</option>
          <option value={4}>{'4 files concurrently'}</option>
          <option value={6}>{'6 files concurrently'}</option>
          <option value={10}>{'10 files concurrently (Max performance)'}</option>
        </select>
      </div>
    </div>
  );
};
