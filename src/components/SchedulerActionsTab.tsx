import React from 'react';
import { Server, Shield, ShieldAlert, Volume2, Globe } from 'lucide-react';

interface SchedulerActionsTabProps {
  shutdownOnComplete: boolean;
  onShutdownChange: (v: boolean) => void;
  hangupOnComplete: boolean;
  onHangupChange: (v: boolean) => void;
  exitOnComplete: boolean;
  onExitChange: (v: boolean) => void;
  playChime: boolean;
  onChimeChange: (v: boolean) => void;
  enableWebhook: boolean;
  onWebhookEnableChange: (v: boolean) => void;
  webhookUrl: string;
  onWebhookUrlChange: (v: string) => void;
}

export const SchedulerActionsTab: React.FC<SchedulerActionsTabProps> = ({
  shutdownOnComplete,
  onShutdownChange,
  hangupOnComplete,
  onHangupChange,
  exitOnComplete,
  onExitChange,
  playChime,
  onChimeChange,
  enableWebhook,
  onWebhookEnableChange,
  webhookUrl,
  onWebhookUrlChange,
}) => {
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-bold text-[var(--text-muted)] border-b border-[var(--border-color)] pb-1.5">
        {'Actions upon completion of all downloads:'}
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl cursor-pointer hover:bg-[var(--bg-hover)] shadow-sm">
          <div className="flex items-center gap-2.5">
            <Server className="w-4 h-4 text-red-500" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-[var(--text-primary)]">{'Shutdown PC'}</span>
              <span className="text-[10px] text-[var(--text-muted)]">Shutdown PC</span>
            </div>
          </div>
          <input
            type="checkbox"
            checked={shutdownOnComplete}
            onChange={(e) => {
              onShutdownChange(e.target.checked);
            }}
            className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
          />
        </label>

        <label className="flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl cursor-pointer hover:bg-[var(--bg-hover)] shadow-sm">
          <div className="flex items-center gap-2.5">
            <Shield className="w-4 h-4 text-blue-500" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-[var(--text-primary)]">{'Sleep Mode'}</span>
              <span className="text-[10px] text-[var(--text-muted)]">Sleep mode</span>
            </div>
          </div>
          <input
            type="checkbox"
            checked={hangupOnComplete}
            onChange={(e) => {
              onHangupChange(e.target.checked);
            }}
            className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
          />
        </label>

        <label className="flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl cursor-pointer hover:bg-[var(--bg-hover)] shadow-sm">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-4 h-4 text-amber-500" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-[var(--text-primary)]">{'Exit securely'}</span>
              <span className="text-[10px] text-[var(--text-muted)]">Exit program securely</span>
            </div>
          </div>
          <input
            type="checkbox"
            checked={exitOnComplete}
            onChange={(e) => {
              onExitChange(e.target.checked);
            }}
            className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
          />
        </label>

        <label className="flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl cursor-pointer hover:bg-[var(--bg-hover)] shadow-sm">
          <div className="flex items-center gap-2.5">
            <Volume2 className="w-4 h-4 text-emerald-500" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-[var(--text-primary)]">{'Chime Alert'}</span>
              <span className="text-[10px] text-[var(--text-muted)]">Chime sound alert</span>
            </div>
          </div>
          <input
            type="checkbox"
            checked={playChime}
            onChange={(e) => {
              onChimeChange(e.target.checked);
            }}
            className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
          />
        </label>
      </div>

      <div className="p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-xl space-y-2.5 shadow-sm">
        <label className="flex items-center justify-between cursor-pointer">
          <div className="flex items-center gap-2.5">
            <Globe className="w-4 h-4 text-violet-500" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-[var(--text-primary)]">{'Send HTTP Webhook'}</span>
              <span className="text-[10px] text-[var(--text-muted)]">Send HTTP POST payload notice</span>
            </div>
          </div>
          <input
            type="checkbox"
            checked={enableWebhook}
            onChange={(e) => {
              onWebhookEnableChange(e.target.checked);
            }}
            className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
          />
        </label>
        {enableWebhook && (
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => {
              onWebhookUrlChange(e.target.value);
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs font-mono text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
        )}
      </div>
    </div>
  );
};
