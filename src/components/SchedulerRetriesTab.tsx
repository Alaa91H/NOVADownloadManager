import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useI18n } from '../store/selectors';

interface SchedulerRetriesTabProps {
  retryCount: number;
  onRetryCountChange: (v: number) => void;
  retryDelay: number;
  onRetryDelayChange: (v: number) => void;
}

export const SchedulerRetriesTab: React.FC<SchedulerRetriesTabProps> = ({
  retryCount,
  onRetryCountChange,
  retryDelay,
  onRetryDelayChange,
}) => {
  const t = useI18n();

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-bold text-[var(--text-muted)] border-b border-[var(--border-color)] pb-1.5">
        {t('sched_retries_title')}
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <span className="text-[11px] font-bold text-[var(--text-secondary)]">{t('sched_retry_max')}</span>
          <select
            value={retryCount}
            onChange={(e) => {
              onRetryCountChange(Number(e.target.value));
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-8 pr-3 py-2.5 text-xs focus-visible:outline-none text-[var(--text-primary)] font-bold cursor-pointer shadow-sm"
          >
            <option value={1}>{t('sched_retry_attempt_one')}</option>
            <option value={3}>{t('sched_retry_attempt_n', { count: 3 })}</option>
            <option value={5}>{t('sched_retry_attempt_default')}</option>
            <option value={10}>{t('sched_retry_attempt_weak')}</option>
            <option value={20}>{t('sched_retry_attempt_n', { count: 20 })}</option>
            <option value={50}>{t('sched_retry_attempt_n', { count: 50 })}</option>
            <option value={9999}>{t('sched_retry_attempt_infinite')}</option>
          </select>
        </div>

        <div className="space-y-1">
          <span className="text-[11px] font-bold text-[var(--text-secondary)]">{t('sched_retry_wait')}</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={120}
              value={retryDelay}
              onChange={(e) => {
                onRetryDelayChange(Number(e.target.value));
              }}
              className="w-24 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg p-2 text-center text-xs font-mono font-bold text-[var(--text-primary)] shadow-sm"
            />
            <span className="text-xs text-[var(--text-muted)] font-bold">{t('sched_retry_seconds_between')}</span>
          </div>
        </div>
      </div>

      <div className="p-3 bg-[var(--info)]/5 border border-[var(--info)]/10 text-[11px] text-[var(--text-secondary)] rounded-xl flex items-start gap-2.5 leading-relaxed shadow-sm">
        <CheckCircle2 className="w-5 h-5 text-[var(--info)] shrink-0 mt-0.5" />
        <div>
          <span className="font-bold text-[var(--text-primary)] block">{t('sched_smart_link_verification')}</span>
          {t('sched_smart_link_verification_desc')}
        </div>
      </div>
    </div>
  );
};
