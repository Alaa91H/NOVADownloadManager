/* src/components/Sidebar.tsx */
import React from 'react';
import {
  FileText,
  Cpu,
  Sliders,
  Film,
  Music,
  Globe,
  Settings,
  Layers,
  Clock,
  Moon,
  Sun,
  CheckCircle,
  RefreshCw,
} from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { AppThemeSettings } from '../types/desktop-ui.types';
import { Logo } from './Logo';

export const Sidebar: React.FC = () => {
  const { tasks, workspaceView, setWorkspaceView, bridge, themeSettings, updateThemeSettings, openDialog, dialog, t } =
    useAppStore();

  const handleFilterClick = (view: typeof workspaceView) => {
    if (view === 'scheduler') {
      openDialog('scheduler');
    } else {
      setWorkspaceView(view);
    }
  };

  const taskCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: tasks.length };
    for (const t of tasks) {
      if (t.status !== 'completed') counts['unfinished'] = (counts['unfinished'] || 0) + 1;
      if (t.status === 'completed') counts['finished'] = (counts['finished'] || 0) + 1;
      if (t.status === 'queued') counts['queued'] = (counts['queued'] || 0) + 1;
      counts[t.fileType] = (counts[t.fileType] || 0) + 1;
    }
    return counts;
  }, [tasks]);
  const getTaskCount = (filter: string) => taskCounts[filter] || 0;

  // Accent colors list
  const accents: Array<{ id: AppThemeSettings['accent']; color: string; label: string }> = [
    { id: 'blue', color: 'bg-blue-500', label: t('accent_blue') },
    { id: 'emerald', color: 'bg-emerald-500', label: t('accent_emerald') },
    { id: 'amber', color: 'bg-amber-500', label: t('accent_amber') },
    { id: 'crimson', color: 'bg-red-500', label: t('accent_crimson') },
    { id: 'violet', color: 'bg-purple-500', label: t('accent_violet') },
  ];

  return (
    <aside className="w-64 bg-[var(--bg-sidebar)] border-x border-[var(--border-color)] h-full flex flex-col justify-between select-none p-4 overflow-y-auto shrink-0 transition-all duration-300 fixed md:static inset-y-0 relative z-40 md:z-auto shadow-2xl md:shadow-none">
      <div className="space-y-5">
        {/* Brand Banner */}
        <div className="flex items-center gap-3 border-b border-[var(--border-color)] pb-3">
          <Logo size={36} className="accent-glow filter drop-shadow-md" />
          <div>
            <h1 className="text-xs font-bold text-[var(--text-primary)]">NOVA Download Manager</h1>
            <p className="text-[9px] text-[var(--accent-primary)] font-extrabold uppercase font-mono tracking-wider">
              NOVA Engine
            </p>
          </div>
        </div>

        {/* Local Daemon Bridge Connection Widget */}
        <div
          onClick={() => {
            openDialog('diagnostics');
          }}
          className="p-2.5 bg-[var(--bg-hover)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-lg cursor-pointer transition-colors flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${bridge.status === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-orange-500'}`}
            />
            <div className="text-[10px]">
              <span className="font-semibold block text-[var(--text-primary)]">
                {bridge.status === 'connected' ? t('daemon_bridge_connected') : t('daemon_bridge_disconnected')}
              </span>
              <span className="text-[9px] text-[var(--text-muted)] font-mono">{bridge.version || '--'}</span>
            </div>
          </div>
          <RefreshCw className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        </div>

        {/* Quick Filter Lists */}
        <div className="space-y-0.5">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
            {t('download_lists')}
          </h3>

          <button
            onClick={() => {
              handleFilterClick('all');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'all' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" /> {t('all_downloads')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono font-bold text-[var(--text-secondary)]">
              {getTaskCount('all')}
            </span>
          </button>

          <button
            onClick={() => {
              handleFilterClick('unfinished');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'unfinished' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> {t('downloading')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono font-bold text-[var(--text-secondary)]">
              {getTaskCount('unfinished')}
            </span>
          </button>

          <button
            onClick={() => {
              handleFilterClick('finished');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'finished' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" /> {t('completed')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono font-bold text-[var(--text-secondary)]">
              {getTaskCount('finished')}
            </span>
          </button>

          <button
            onClick={() => {
              handleFilterClick('queued');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'queued' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> {t('queued_downloads')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono font-bold text-[var(--text-secondary)]">
              {getTaskCount('queued')}
            </span>
          </button>
        </div>

        {/* File category lists */}
        <div className="space-y-0.5">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
            {t('categories')}
          </h3>

          <button
            onClick={() => {
              handleFilterClick('compressed');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'compressed' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-amber-500" /> {t('compressed')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--text-muted)]">
              {getTaskCount('compressed')}
            </span>
          </button>

          <button
            onClick={() => {
              handleFilterClick('program');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'program' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-emerald-500" /> {t('programs')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--text-muted)]">
              {getTaskCount('program')}
            </span>
          </button>

          <button
            onClick={() => {
              handleFilterClick('video');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'video' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <Film className="w-3.5 h-3.5 text-sky-500" /> {t('videos')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--text-muted)]">
              {getTaskCount('video')}
            </span>
          </button>

          <button
            onClick={() => {
              handleFilterClick('audio');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'audio' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <Music className="w-3.5 h-3.5 text-violet-500" /> {t('audio')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--text-muted)]">
              {getTaskCount('audio')}
            </span>
          </button>

          <button
            onClick={() => {
              handleFilterClick('document');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${workspaceView === 'document' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-red-500" /> {t('documents')}
            </span>
            <span className="bg-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--text-muted)]">
              {getTaskCount('document')}
            </span>
          </button>
        </div>

        {/* Open workspace layouts */}
        <div className="space-y-0.5">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">Web Browser</h3>

          <button
            onClick={() => {
              window.open('https://arab-downloads.net/home', '_blank', 'noopener,noreferrer');
            }}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded text-[11px] transition-all text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-sky-500" /> System Web Browser
            </span>
            <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 px-1 py-0.5 rounded text-[9px] font-bold">
              OS
            </span>
          </button>
        </div>

        {/* Scheduler and organization layouts */}
        <div className="space-y-0.5">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">
            {t('download_lists')}
          </h3>

          <button
            onClick={() => {
              handleFilterClick('scheduler');
            }}
            className={`w-full flex items-center justify-between px-2 py-1 rounded text-[11px] transition-all ${dialog.active === 'scheduler' ? 'bg-[var(--bg-selected)] text-[var(--accent-primary)] font-bold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
          >
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-500 animate-pulse" /> {t('organize_scheduler')}
            </span>
            <span className="bg-amber-500/10 border border-amber-500/20 text-amber-500 px-1 py-0.5 rounded text-[9px] font-bold">
              {t('active_indicator')}
            </span>
          </button>
        </div>
      </div>

      {/* FOOTER WIDGET: Interface Customization Presets */}
      <div className="pt-4 border-t border-[var(--border-color)] space-y-3 mt-4 text-[11px]">
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-1">{t('theme')}</h3>

        {/* Theme selecter layout */}
        <div className="flex items-center justify-between gap-1">
          <span className="text-[var(--text-secondary)]">{t('set_theme_mode')}:</span>
          <div className="flex gap-1 bg-[var(--bg-hover)] p-0.5 rounded border border-[var(--border-color)]">
            <button
              onClick={() => {
                updateThemeSettings('theme', 'dark');
              }}
              className={`p-1.5 rounded cursor-pointer ${themeSettings.theme === 'dark' ? 'bg-[var(--bg-surface-elevated)] text-[var(--accent-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
              title={t('set_theme_mode_dark')}
            >
              <Moon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => {
                updateThemeSettings('theme', 'light');
              }}
              className={`p-1.5 rounded cursor-pointer ${themeSettings.theme === 'light' ? 'bg-[var(--bg-surface-elevated)] text-[var(--accent-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
              title={t('set_theme_mode_light')}
            >
              <Sun className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Density selecter layout */}
        <div className="flex items-center justify-between">
          <span className="text-[var(--text-secondary)]">{t('set_theme_density')}:</span>
          <select
            value={themeSettings.density}
            onChange={(e) => {
              updateThemeSettings('density', e.target.value);
            }}
            className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded text-[10px] px-1.5 py-0.5 focus:outline-none cursor-pointer text-[var(--text-primary)]"
          >
            <option value="compact">{t('set_theme_density_compact')}</option>
            <option value="dense">{t('set_theme_density_comfortable')}</option>
            <option value="normal">{t('set_theme_contrast_normal')}</option>
          </select>
        </div>

        {/* Accent selecter layout */}
        <div className="flex items-center justify-between">
          <span className="text-[var(--text-secondary)]">{t('set_theme_accent')}:</span>
          <div className="flex gap-1">
            {accents.map((acc) => (
              <button
                key={acc.id}
                onClick={() => {
                  updateThemeSettings('accent', acc.id);
                }}
                className={`w-3 h-3 rounded-full ${acc.color} cursor-pointer transition-all ${themeSettings.accent === acc.id ? 'ring-2 ring-white scale-110' : 'opacity-65 hover:opacity-100'}`}
                title={acc.label}
              />
            ))}
          </div>
        </div>

        {/* Settings button */}
        <button
          onClick={() => {
            openDialog('settings');
          }}
          className="w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-[var(--bg-hover)] border border-[var(--border-color)] hover:bg-[var(--border-color-hover)] rounded-lg text-xs font-semibold cursor-pointer text-[var(--text-primary)] transition-all"
        >
          <Settings className="w-4 h-4 text-[var(--text-muted)]" />
          <span>{t('settings_title')}</span>
        </button>
      </div>
    </aside>
  );
};
