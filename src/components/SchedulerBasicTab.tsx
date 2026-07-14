import React from 'react';
import { TimePicker } from './primitives/TimePicker';
import { useAppStore } from '../state/appStore';

type ScheduleType = 'once' | 'daily' | 'custom';

interface SchedulerBasicTabProps {
  name: string;
  onNameChange: (v: string) => void;
  smartScheduleType: ScheduleType;
  onScheduleTypeChange: (v: ScheduleType) => void;
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

const weekDayKeys = [
  'weekday_sunday',
  'weekday_monday',
  'weekday_tuesday',
  'weekday_wednesday',
  'weekday_thursday',
  'weekday_friday',
  'weekday_saturday',
] as const;

const scheduleTypes: ScheduleType[] = ['once', 'daily', 'custom'];

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
  const { t } = useAppStore();
  const selectedDayNames = days.map((day) => t(weekDayKeys[day])).join(', ');

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <span className="text-[11px] font-bold text-[var(--text-secondary)]">{t('sched_list_name_edit')}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => {
            onNameChange(e.target.value);
          }}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg p-2.5 text-xs text-[var(--text-primary)] focus-visible:outline-none focus-visible:border-[var(--accent-primary)] focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] font-bold shadow-sm"
        />
      </div>

      <div className="space-y-1">
        <span className="text-[11px] font-bold text-[var(--text-secondary)]">{t('sched_schedule_type')}</span>
        <div className="grid grid-cols-3 gap-1 bg-[var(--bg-input)] p-1 rounded-lg border border-[var(--border-color)]">
          {scheduleTypes.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                onScheduleTypeChange(type);
              }}
              className={`py-1.5 text-[10px] md:text-xs font-bold rounded-md cursor-pointer ${
                smartScheduleType === type
                  ? 'text-[var(--accent-primary)] font-extrabold bg-[var(--accent-primary)]/10'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent'
              }`}
              title={t(`sched_schedule_type_${type}_desc`)}
            >
              {t(`sched_schedule_type_${type}`)}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          {t(`sched_schedule_type_${smartScheduleType}_desc`)}
        </p>
      </div>

      <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
        <div className="flex flex-col text-right">
          <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">{t('sched_enable_timer')}</span>
          <span className="text-[10px] text-[var(--text-muted)]">{t('sched_enable_timer_desc')}</span>
        </div>
        <input
          type="checkbox"
          checked={isScheduled}
          onChange={(e) => {
            onScheduledChange(e.target.checked);
          }}
          className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus-visible:ring-[var(--accent-primary)] cursor-pointer"
        />
      </div>

      {isScheduled && (
        <div className="space-y-4 p-4 bg-[var(--bg-input)]/40 border border-[var(--border-color)] rounded-xl shadow-inner">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TimePicker label={t('sched_start_time')} value={startTime} onChange={onStartTimeChange} />
            <TimePicker label={t('sched_stop_time')} value={endTime} onChange={onEndTimeChange} />
          </div>

          <div className="space-y-1.5 pt-1">
            <span className="text-[11px] text-[var(--text-muted)] block mb-1 font-bold">{t('sched_days_of_week')}</span>
            {smartScheduleType === 'custom' ? (
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
                          ? 'text-[var(--accent-primary)] font-extrabold bg-[var(--accent-primary)]/10 shadow-sm'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent'
                      }`}
                    >
                      {t(weekDayKeys[d])}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-secondary)] bg-[var(--bg-hover)]/40 rounded-lg border border-[var(--border-color)] px-3 py-2">
                {smartScheduleType === 'daily'
                  ? t('sched_days_daily_summary')
                  : t('sched_days_once_summary', { days: selectedDayNames })}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="space-y-1">
        <span className="text-[11px] font-bold text-[var(--text-secondary)]">{t('sched_max_concurrent')}</span>
        <select
          value={maxActive}
          onChange={(e) => {
            onMaxActiveChange(Number(e.target.value));
          }}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-8 pr-3 py-2.5 text-xs focus-visible:outline-none text-[var(--text-primary)] font-bold cursor-pointer shadow-sm"
        >
          <option value={1}>{t('sched_concurrent_1')}</option>
          <option value={2}>{t('sched_concurrent_n', { count: 2 })}</option>
          <option value={3}>{t('sched_concurrent_n', { count: 3 })}</option>
          <option value={4}>{t('sched_concurrent_n', { count: 4 })}</option>
          <option value={6}>{t('sched_concurrent_n', { count: 6 })}</option>
          <option value={10}>{t('sched_concurrent_10')}</option>
        </select>
      </div>
    </div>
  );
};
