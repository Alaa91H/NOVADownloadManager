/* src/dialogs/settings/sections/EngineControls.tsx */
import React, { useState } from 'react';
import { Gauge, RefreshCw, Pause, Play, Save, Trash2, AlertCircle } from 'lucide-react';
import { useToastActions, useEngineActions } from '../../../store/selectors';
import {
  useEngineBandwidth,
  useEngineRateLimit,
  useEngineRetryPolicy,
  useEngineProfiles,
  useEngineCache,
} from '../../../store/selectors';
import { formatSpeed } from '../../../utils/formatUtils';

const PRESETS = [
  { id: 'default', label: 'Default (balanced)' },
  { id: 'aggressive', label: 'Aggressive (more retries)' },
  { id: 'conservative', label: 'Conservative (longer waits)' },
  { id: 'none', label: 'No retry' },
] as const;

export const EngineControls: React.FC = () => {
  const { addToast } = useToastActions();
  const actions = useEngineActions();
  const bandwidth = useEngineBandwidth();
  const rateLimit = useEngineRateLimit();
  const retryPolicy = useEngineRetryPolicy();
  const profiles = useEngineProfiles();

  const [globalLimit, setGlobalLimit] = useState('');
  const [retryMax, setRetryMax] = useState('');
  const [retryBaseDelay, setRetryBaseDelay] = useState('');
  const [retryPreset, setRetryPreset] = useState<string>('default');
  const [savingBandwidth, setSavingBandwidth] = useState(false);
  const [savingRetry, setSavingRetry] = useState(false);

  // Adjust local form state when the engine snapshot changes, using the
  // official React "adjust state during render" pattern (conditional setState
  // guarded by a tracked previous key). This avoids setState-in-effect while
  // keeping the form reactive to server-side changes.
  const rateLimitKey = rateLimit ? String(rateLimit.globalLimitKbps) : '';
  const [prevRateLimitKey, setPrevRateLimitKey] = useState<string | null>(null);
  if (rateLimitKey !== prevRateLimitKey) {
    setPrevRateLimitKey(rateLimitKey);
    setGlobalLimit(rateLimit ? String(rateLimit.globalLimitKbps || '') : '');
  }

  const retryKey = retryPolicy?.policy
    ? `${retryPolicy.policy.preset ?? ''}|${String(retryPolicy.policy.maxRetries ?? '')}|${String(retryPolicy.policy.baseDelaySecs ?? '')}`
    : '';
  const [prevRetryKey, setPrevRetryKey] = useState<string | null>(null);
  if (retryKey !== prevRetryKey) {
    setPrevRetryKey(retryKey);
    if (retryPolicy?.policy) {
      const p = retryPolicy.policy;
      setRetryMax(p.maxRetries != null ? String(p.maxRetries) : '');
      setRetryBaseDelay(p.baseDelaySecs != null ? String(p.baseDelaySecs) : '');
      if (typeof p.preset === 'string') setRetryPreset(p.preset);
    }
  }

  const handleSaveBandwidth = async () => {
    const kbps = Number(globalLimit);
    if (globalLimit && (!Number.isFinite(kbps) || kbps < 0)) {
      addToast('error', 'Invalid value', 'Bandwidth limit must be a non-negative number.');
      return;
    }
    setSavingBandwidth(true);
    try {
      await actions.setRateLimit({ globalLimitKbps: globalLimit ? kbps : 0 });
      addToast('success', 'Bandwidth saved', 'Global bandwidth limit was applied to the engine.');
    } catch (e) {
      addToast('error', 'Bandwidth', e instanceof Error ? e.message : 'Could not apply the bandwidth limit.');
    } finally {
      setSavingBandwidth(false);
    }
  };

  const handleTogglePause = async () => {
    if (!rateLimit) return;
    try {
      await actions.setBandwidth({ paused: !rateLimit.paused });
      addToast(
        'info',
        rateLimit.paused ? 'Resumed' : 'Paused',
        rateLimit.paused ? 'All downloads resumed.' : 'All downloads paused.',
      );
    } catch (e) {
      addToast('error', 'Bandwidth', e instanceof Error ? e.message : 'Could not toggle pause.');
    }
  };

  const handleSaveRetry = async () => {
    const max = Number(retryMax);
    const baseDelay = Number(retryBaseDelay);
    if (retryMax && (!Number.isFinite(max) || max < 0)) {
      addToast('error', 'Invalid value', 'Max retries must be a non-negative number.');
      return;
    }
    if (retryBaseDelay && (!Number.isFinite(baseDelay) || baseDelay < 0)) {
      addToast('error', 'Invalid value', 'Base delay must be a non-negative number (seconds).');
      return;
    }
    setSavingRetry(true);
    try {
      await actions.setRetryPolicy({
        preset: retryPreset as 'default' | 'aggressive' | 'conservative' | 'none',
        maxRetries: retryMax ? max : undefined,
        baseDelaySecs: retryBaseDelay ? baseDelay : undefined,
      });
      addToast('success', 'Retry policy saved', 'The engine will apply the new retry behavior.');
    } catch (e) {
      addToast('error', 'Retry policy', e instanceof Error ? e.message : 'Could not save the retry policy.');
    } finally {
      setSavingRetry(false);
    }
  };

  const handleProfileChange = async (id: string) => {
    try {
      await actions.setActiveProfile(id);
      addToast('success', 'Profile applied', 'The selected download profile is now active.');
    } catch (e) {
      addToast('error', 'Profile', e instanceof Error ? e.message : 'Could not apply the profile.');
    }
  };

  const activeProfileId = profiles?.activeProfile ?? '';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2 pb-2 border-b border-[var(--border-color)]">
        <Gauge className="w-4 h-4 text-[var(--accent-primary)]" />
        <h2 className="text-sm font-extrabold text-[var(--text-primary)]">Engine Controls</h2>
        <button
          onClick={() => {
            void actions.refreshAll();
          }}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="Refresh engine state"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        Drive the download engine directly: global bandwidth limit, pause/resume, retry policy presets, and active
        download profile. These controls operate on the live engine state and apply immediately.
      </p>

      {/* Bandwidth & Rate Limit */}
      <section className="rounded-lg border border-[var(--border-color)] p-3 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-[var(--text-primary)]">Bandwidth & Rate Limit</h3>
          {rateLimit?.paused && (
            <span className="text-[10px] font-bold text-[var(--warning)] flex items-center gap-1">
              <Pause className="w-3 h-3" />
              All downloads paused
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-[var(--text-secondary)]">
              Global limit (KB/s, 0 = unlimited)
            </span>
            <input
              type="number"
              min={0}
              value={globalLimit}
              onChange={(e) => {
                setGlobalLimit(e.target.value);
              }}
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-xs px-2 py-1.5 focus:border-[var(--accent-primary)] focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] focus-visible:outline-none"
              placeholder="0"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => {
                void handleSaveBandwidth();
              }}
              disabled={savingBandwidth}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              Save
            </button>
            <button
              onClick={() => {
                void handleTogglePause();
              }}
              disabled={!rateLimit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer disabled:opacity-50"
              title={rateLimit?.paused ? 'Resume all downloads' : 'Pause all downloads'}
            >
              {rateLimit?.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              {rateLimit?.paused ? 'Resume' : 'Pause All'}
            </button>
          </div>
        </div>

        {/* Active task bandwidth breakdown */}
        {bandwidth && bandwidth.tasks.length > 0 && (
          <div className="space-y-1 pt-1 border-t border-[var(--border-color)]/40">
            <span className="text-[10px] font-bold text-[var(--text-secondary)]">Active tasks</span>
            {bandwidth.tasks.slice(0, 5).map((task) => (
              <div key={task.taskId} className="flex items-center justify-between text-[10px] font-mono">
                <span className="text-[var(--text-muted)] truncate max-w-[60%]" title={task.taskId}>
                  {task.taskId}
                </span>
                <span className="text-[var(--text-secondary)]">
                  {formatSpeed(task.averageSpeedBps)}
                  {task.allowedKbps > 0 && (
                    <span className="text-[var(--text-muted)]"> / cap {String(task.allowedKbps)} KB/s</span>
                  )}
                </span>
              </div>
            ))}
            {bandwidth.tasks.length > 5 && (
              <span className="text-[10px] text-[var(--text-muted)]">+{String(bandwidth.tasks.length - 5)} more</span>
            )}
          </div>
        )}
      </section>

      {/* Retry Policy */}
      <section className="rounded-lg border border-[var(--border-color)] p-3 space-y-3">
        <h3 className="text-xs font-bold text-[var(--text-primary)]">Retry Policy</h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => {
                setRetryPreset(preset.id);
              }}
              className={`px-2 py-1.5 text-[10px] font-bold rounded-md border transition-colors cursor-pointer ${
                retryPreset === preset.id
                  ? 'border-[var(--accent-primary)] bg-[var(--accent-light)] text-[var(--accent-primary)]'
                  : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-[var(--text-secondary)]">Max retries</span>
            <input
              type="number"
              min={0}
              max={100}
              value={retryMax}
              onChange={(e) => {
                setRetryMax(e.target.value);
              }}
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-xs px-2 py-1.5 focus:border-[var(--accent-primary)] focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] focus-visible:outline-none"
              placeholder="preset default"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-[var(--text-secondary)]">Base delay (sec)</span>
            <input
              type="number"
              min={0}
              value={retryBaseDelay}
              onChange={(e) => {
                setRetryBaseDelay(e.target.value);
              }}
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-xs px-2 py-1.5 focus:border-[var(--accent-primary)] focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] focus-visible:outline-none"
              placeholder="preset default"
            />
          </label>
        </div>

        {/* Backoff preview */}
        {retryPolicy && retryPolicy.backoffPreviewSecs.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono text-[var(--text-muted)]">
            <span className="font-bold text-[var(--text-secondary)]">Backoff:</span>
            {retryPolicy.backoffPreviewSecs.map((secs, i) => (
              <span key={i} className="bg-[var(--bg-input)] px-1.5 py-0.5 rounded">
                {String(i + 1)}: {secs < 1 ? '<1s' : `${String(Math.round(secs))}s`}
              </span>
            ))}
          </div>
        )}

        <button
          onClick={() => {
            void handleSaveRetry();
          }}
          disabled={savingRetry}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          Apply Retry Policy
        </button>
      </section>

      {/* Download Profiles */}
      <section className="rounded-lg border border-[var(--border-color)] p-3 space-y-3">
        <h3 className="text-xs font-bold text-[var(--text-primary)]">Download Profile</h3>
        {profiles && profiles.profiles.length > 0 ? (
          <div className="space-y-1.5">
            {profiles.profiles.map((profile, idx) => {
              const p = profile as Record<string, unknown>;
              const id = typeof p.id === 'string' ? p.id : String(idx);
              const name = typeof p.name === 'string' ? p.name : id;
              const isActive = id === activeProfileId;
              return (
                <button
                  key={id}
                  onClick={() => {
                    void handleProfileChange(id);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-[11px] font-bold rounded-md border transition-colors cursor-pointer ${
                    isActive
                      ? 'border-[var(--accent-primary)] bg-[var(--accent-light)] text-[var(--accent-primary)]'
                      : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <span>{name}</span>
                  {isActive && <span className="text-[9px]">ACTIVE</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex items-start gap-2 text-[10px] text-[var(--text-muted)]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>No download profiles available. The engine uses its default profile.</span>
          </div>
        )}
      </section>

      {/* Metadata cache */}
      <EngineCacheSection />
    </div>
  );
};

const EngineCacheSection: React.FC = () => {
  const cache = useEngineCache();
  const actions = useEngineActions();
  const { addToast } = useToastActions();
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      await actions.clearCache();
      addToast('success', 'Cache cleared', 'The engine metadata cache was cleared.');
    } catch (e) {
      addToast('error', 'Cache', e instanceof Error ? e.message : 'Could not clear the cache.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="rounded-lg border border-[var(--border-color)] p-3 flex items-center justify-between">
      <div>
        <h3 className="text-xs font-bold text-[var(--text-primary)]">Metadata Cache</h3>
        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
          {cache ? `${String(cache.entries)} cached entries (probe/metadata results)` : 'Loading…'}
        </p>
      </div>
      <button
        onClick={() => {
          void handleClear();
        }}
        disabled={clearing || !cache || cache.entries === 0}
        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer disabled:opacity-50"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Clear
      </button>
    </section>
  );
};
