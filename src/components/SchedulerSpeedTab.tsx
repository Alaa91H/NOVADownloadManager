import React, { useMemo, useState } from 'react';
import { Sliders } from 'lucide-react';
import { SpeedLimitInput } from './SpeedLimitInput';
import { useI18n } from '../store/selectors';
import { normalizeDownloadProfiles, selectActiveDownloadProfile } from '../utils/downloadProfiles';

interface SchedulerSpeedTabProps {
  limitSpeed: boolean;
  onLimitSpeedChange: (v: boolean) => void;
  speedLimitKbs: number;
  onSpeedLimitChange: (v: number) => void;
  oneTimeLimit: boolean;
  onOneTimeLimitChange: (v: boolean) => void;
  downloadProfiles?: unknown[];
  activeDownloadProfile?: string;
  onActiveDownloadProfileChange?: (profileId: string) => Promise<void>;
}

export const SchedulerSpeedTab: React.FC<SchedulerSpeedTabProps> = ({
  limitSpeed,
  onLimitSpeedChange,
  speedLimitKbs,
  onSpeedLimitChange,
  oneTimeLimit,
  onOneTimeLimitChange,
  downloadProfiles,
  activeDownloadProfile,
  onActiveDownloadProfileChange,
}) => {
  const t = useI18n();
  const [profileChangePending, setProfileChangePending] = useState(false);
  const [profileChangeFailed, setProfileChangeFailed] = useState(false);
  const profiles = useMemo(() => normalizeDownloadProfiles(downloadProfiles), [downloadProfiles]);
  const selectedProfileId = useMemo(
    () => selectActiveDownloadProfile(activeDownloadProfile, profiles),
    [activeDownloadProfile, profiles],
  );
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const canSelectProfile = Boolean(selectedProfileId && onActiveDownloadProfileChange && profiles.length > 0);

  const changeProfile = async (profileId: string) => {
    if (!onActiveDownloadProfileChange || profileId === selectedProfileId) return;
    setProfileChangePending(true);
    setProfileChangeFailed(false);
    try {
      await onActiveDownloadProfileChange(profileId);
    } catch {
      // The engine store keeps the server-authoritative active profile on failure.
      setProfileChangeFailed(true);
    } finally {
      setProfileChangePending(false);
    }
  };

  return (
    <div className="space-y-4">
      {canSelectProfile && (
        <section
          data-testid="download-profile-control"
          className="flex flex-col gap-3 bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm"
          aria-busy={profileChangePending}
        >
          <div className="flex flex-col text-right">
            <label
              htmlFor="scheduler-download-profile"
              className="text-xs md:text-sm font-bold text-[var(--text-primary)]"
            >
              {t('settings_network_profile')}
            </label>
            {selectedProfile?.description && (
              <span className="text-[10px] text-[var(--text-muted)]">{selectedProfile.description}</span>
            )}
          </div>
          <select
            id="scheduler-download-profile"
            data-testid="download-profile-select"
            value={selectedProfileId}
            disabled={profileChangePending}
            onChange={(event) => {
              void changeProfile(event.target.value);
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent-primary)] focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] disabled:cursor-wait disabled:opacity-60"
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          {profileChangeFailed && (
            <p role="alert" className="text-[10px] font-semibold text-[var(--danger)]">
              {t('settings_proxy_failed')}
            </p>
          )}
        </section>
      )}
      <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
        <div className="flex flex-col text-right">
          <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">{t('sched_speed_limiter')}</span>
          <span className="text-[10px] text-[var(--text-muted)]">{t('sched_speed_limiter_desc')}</span>
        </div>
        <input
          type="checkbox"
          checked={limitSpeed}
          onChange={(e) => {
            onLimitSpeedChange(e.target.checked);
          }}
          className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus-visible:ring-[var(--accent-primary)] cursor-pointer"
        />
      </div>

      {limitSpeed && (
        <div className="p-4 bg-[var(--bg-input)]/40 border border-[var(--border-color)] rounded-xl space-y-4 shadow-inner">
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <span className="text-xs text-[var(--text-secondary)] font-bold">{t('sched_set_max_speed')}</span>
              <div dir="ltr">
                <SpeedLimitInput
                  maxSpeedKbs={speedLimitKbs}
                  onChange={(v) => {
                    onSpeedLimitChange(v);
                  }}
                  compact={false}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 text-xs text-[var(--text-secondary)] leading-relaxed bg-[var(--warning)]/5 border border-[var(--warning)]/10 p-3 rounded-lg">
            <Sliders className="w-4 h-4 text-[var(--warning)] shrink-0" />
            <span>{t('sched_speed_limit_note')}</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
        <div className="flex flex-col text-right">
          <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">{t('sched_one_time_speed')}</span>
          <span className="text-[10px] text-[var(--text-muted)]">{t('sched_one_time_speed_desc')}</span>
        </div>
        <input
          type="checkbox"
          checked={oneTimeLimit}
          onChange={(e) => {
            onOneTimeLimitChange(e.target.checked);
          }}
          className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus-visible:ring-[var(--accent-primary)] cursor-pointer"
        />
      </div>
    </div>
  );
};
