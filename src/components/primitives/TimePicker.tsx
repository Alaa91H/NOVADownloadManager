import React from 'react';
import { parseTimeTo12Hour, formatTimeTo24Hour } from '../../utils/timeUtils';
import { useAppStore } from '../../state/appStore';

interface TimePickerProps {
  label: string;
  value: string;
  onChange: (newValue: string) => void;
}

export const TimePicker: React.FC<TimePickerProps> = ({ label, value, onChange }) => {
  const { t } = useAppStore();
  const { hour12, minute, ampm } = parseTimeTo12Hour(value);

  const handleHourChange = (newHour: number) => {
    onChange(formatTimeTo24Hour(newHour, minute, ampm));
  };

  const handleMinuteChange = (newMin: number) => {
    onChange(formatTimeTo24Hour(hour12, newMin, ampm));
  };

  const handleAmpmChange = (newAmpm: 'AM' | 'PM') => {
    onChange(formatTimeTo24Hour(hour12, minute, newAmpm));
  };

  return (
    <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)]/50 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-extrabold text-[var(--text-secondary)]">{label}</span>
        <span className="text-xs font-mono font-bold text-[var(--accent-primary)] flex items-center gap-1" dir="ltr">
          <span dir="ltr">
            {String(hour12).padStart(2, '0')}:{String(minute).padStart(2, '0')}
          </span>
          <span className="text-[10px] font-bold">{ampm}</span>
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 flex flex-col gap-1">
          <span className="text-[9px] text-[var(--text-muted)] font-bold">{t('time_picker_hour')}</span>
          <select
            value={hour12}
            onChange={(e) => {
              handleHourChange(Number(e.target.value));
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-6 pr-2.5 py-1.5 text-xs font-bold text-[var(--text-primary)] focus:outline-none cursor-pointer"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 flex flex-col gap-1">
          <span className="text-[9px] text-[var(--text-muted)] font-bold">{t('time_picker_minute')}</span>
          <select
            value={minute}
            onChange={(e) => {
              handleMinuteChange(Number(e.target.value));
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-6 pr-2.5 py-1.5 text-xs font-bold text-[var(--text-primary)] focus:outline-none cursor-pointer"
          >
            {Array.from({ length: 60 }, (_, i) => i).map((m) => (
              <option key={m} value={m}>
                {String(m).padStart(2, '0')}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 shrink-0">
          <span className="text-[9px] text-[var(--text-muted)] font-bold text-center">{t('time_picker_period')}</span>
          <div className="flex rounded-lg border border-[var(--border-color)] overflow-hidden bg-[var(--bg-input)] p-0.5">
            <button
              type="button"
              onClick={() => {
                handleAmpmChange('AM');
              }}
              className={`px-3 py-1 text-[10px] font-bold rounded-md cursor-pointer ${
                ampm === 'AM'
                  ? 'text-white font-extrabold bg-transparent'
                  : 'text-[var(--text-muted)] hover:text-white bg-transparent'
              }`}
            >
              AM
            </button>
            <button
              type="button"
              onClick={() => {
                handleAmpmChange('PM');
              }}
              className={`px-3 py-1 text-[10px] font-bold rounded-md cursor-pointer ${
                ampm === 'PM'
                  ? 'text-white font-extrabold bg-transparent'
                  : 'text-[var(--text-muted)] hover:text-white bg-transparent'
              }`}
            >
              PM
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
