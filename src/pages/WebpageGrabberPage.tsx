/* src/pages/WebpageGrabberPage.tsx */
import React, { useState } from 'react';
import { ArrowLeft, Globe, FolderOpen, Layers, CheckSquare, Download, HelpCircle, FileText } from 'lucide-react';
import { useDialogActions, useDialogData, useQueueData, useSettingsData, useToastActions, useNavigationActions, useI18n } from '../store/selectors';
import { novaClient } from '../api/novaClient';
import { tauriClient } from '../api/tauriClient';
import { TextField, SelectField, Switch, Checkbox } from '../components/primitives';

export const WebpageGrabberPage: React.FC = () => {
  const dialog = useDialogData();
  const { closeDialog } = useDialogActions();
  const { setActivePage } = useNavigationActions();
  const queues = useQueueData();
  const settings = useSettingsData();
  const { addToast } = useToastActions();
  const t = useI18n();

  const [url, setUrl] = useState(() => (typeof dialog.payload === 'string' ? dialog.payload : ''));
  const [savePath, setSavePath] = useState(
    settings.saveAndCategories.categoryFolders.document || settings.saveAndCategories.defaultFolder || '',
  );
  const [depth, setDepth] = useState<number>(1);
  const [saveFormat, setSaveFormat] = useState<'single' | 'folder' | 'text'>('single');
  const [selectedQueue, setSelectedQueue] = useState('main');
  const [isStarting, setIsStarting] = useState(false);

  const [filters, setFilters] = useState({
    pages: true,
    styles: true,
    images: true,
    documents: false,
    media: false,
    others: false,
  });

  const [followOuterDomains, setFollowOuterDomains] = useState(false);
  const [overwriteExisting, setOverwriteExisting] = useState(true);

  const handleBack = () => {
    closeDialog();
  };

  const handleStartScrape = async () => {
    if (!url || !url.trim().startsWith('http')) {
      addToast('error', t('grabber_error_invalid_url'), t('grabber_error_invalid_url_msg'));
      return;
    }

    setIsStarting(true);
    try {
      const queue = queues.find((q) => q.id === selectedQueue);
      const fileName = url
        .replace(/^https?:\/\//, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 80);

      await novaClient.createDownload({
        url: url.trim(),
        name: `${fileName}_depth${String(depth)}.${saveFormat === 'text' ? 'txt' : 'html'}`,
        fileType: 'document',
        status: 'queued',
        sizeBytes: 0,
        category: 'document',
        queueId: queue?.id || 'main',
        connections: 1,
        resumable: false,
        savePath: savePath || settings.saveAndCategories.defaultFolder,
        description: `Webpage grabber: depth=${String(depth)}, format=${saveFormat}, followExternal=${String(followOuterDomains)}, overwrite=${String(overwriteExisting)}`,
        elapsedSeconds: 0,
        startImmediately: true,
      });

      addToast('success', t('grabber_banner_title'), `Queued: ${url.trim()}`);
      setActivePage('downloads');
    } catch (err) {
      addToast('error', t('grabber_error_no_backend'), err instanceof Error ? err.message : t('grabber_error_no_backend_msg'));
    } finally {
      setIsStarting(false);
    }
  };

  const validPreviewUrl = url.trim().startsWith('http');

  return (
    <div className="app-page flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--bg-app)]" dir="ltr">

      {/* HEADER */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)] shrink-0 select-none">
        <button
          type="button"
          onClick={handleBack}
          className="toolbar-btn shrink-0"
          title={t('page_back_tip')}
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">{t('page_back')}</span>
        </button>

        <div className="h-5 w-px bg-[var(--border-color)] shrink-0" />

        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <Globe className="w-4 h-4 text-[var(--accent-primary)] shrink-0" />
          <div className="min-w-0">
            <h1 className="text-sm font-extrabold text-[var(--text-primary)] truncate leading-tight">
              {t('dlg_webpage_grabber')}
            </h1>
          </div>
        </div>
      </div>

      {/* BODY */}
      <div className="flex-1 min-h-0 overflow-hidden flex">
        <div className="w-[44%] flex flex-col min-h-0 border-r border-[var(--border-color)]/50">
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin">
            <div className="bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20 rounded-lg p-3 text-xs leading-relaxed text-[var(--text-primary)]">
              <p className="font-semibold flex items-center gap-1.5 text-[var(--accent-primary)] mb-1">
                <Globe className="w-4 h-4" />
                {t('grabber_banner_title')}
              </p>
              <p className="text-[11px] text-[var(--text-muted)]">
                {t('grabber_banner_desc')}
              </p>
            </div>

            <div className="space-y-4">
              <TextField
                label={t('grabber_save_dir')}
                value={savePath}
                onChange={(e) => {
                  setSavePath(e.target.value);
                }}
                icon={FolderOpen}
                onIconClick={() => {
                  void (async () => {
                    const picked = await tauriClient.showDirectoryPicker(savePath || undefined);
                    if (picked) setSavePath(picked);
                  })();
                }}
                id="grabber-path"
              />

              <SelectField
                label={t('grabber_queue')}
                value={selectedQueue}
                onChange={(e) => {
                  setSelectedQueue(e.target.value);
                }}
                options={queues.map((q) => ({ value: q.id, label: q.name }))}
                id="grabber-queue"
              />

              <div className="space-y-4 border-t border-[var(--border-color)]/50 pt-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-[var(--text-primary)] flex items-center gap-1">
                    <Layers className="w-3.5 h-3.5 text-[var(--info)]" />
                    {t('grabber_depth_label')}
                  </label>
                  <select
                    value={depth}
                    onChange={(e) => {
                      setDepth(Number(e.target.value));
                    }}
                    className="w-full text-xs font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] rounded-lg p-2.5 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                    id="grabber-depth"
                  >
                    <option value={1}>{t('grabber_depth_1')}</option>
                    <option value={2}>{t('grabber_depth_2')}</option>
                    <option value={3}>{t('grabber_depth_3')}</option>
                    <option value={4}>{t('grabber_depth_4')}</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-extrabold text-[var(--text-primary)] flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5 text-[var(--success)]" />
                    {t('grabber_format_label')}
                  </label>
                  <select
                    value={saveFormat}
                    onChange={(e) => {
                      setSaveFormat(e.target.value as 'single' | 'folder' | 'text');
                    }}
                    className="w-full text-xs font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] rounded-lg p-2.5 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                    id="grabber-format"
                  >
                    <option value="single">{t('grabber_format_single')}</option>
                    <option value="folder">{t('grabber_format_folder')}</option>
                    <option value="text">{t('grabber_format_text')}</option>
                  </select>
                </div>
              </div>

              <div className="space-y-4 border-t border-[var(--border-color)]/50 pt-3">
                <span className="text-xs font-extrabold text-[var(--text-primary)] flex items-center gap-1">
                  <CheckSquare className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
                  {t('grabber_filter_label')}
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 bg-[var(--bg-hover)]/30 border border-[var(--border-color)]/40 rounded-lg">
                  <Checkbox
                    label={t('grabber_filter_pages')}
                    checked={filters.pages}
                    onChange={(val) => {
                      setFilters((prev) => ({ ...prev, pages: val }));
                    }}
                    id="filter-pages"
                  />
                  <Checkbox
                    label={t('grabber_filter_styles')}
                    checked={filters.styles}
                    onChange={(val) => {
                      setFilters((prev) => ({ ...prev, styles: val }));
                    }}
                    id="filter-styles"
                  />
                  <Checkbox
                    label={t('grabber_filter_images')}
                    checked={filters.images}
                    onChange={(val) => {
                      setFilters((prev) => ({ ...prev, images: val }));
                    }}
                    id="filter-images"
                  />
                  <Checkbox
                    label={t('grabber_filter_docs')}
                    checked={filters.documents}
                    onChange={(val) => {
                      setFilters((prev) => ({ ...prev, documents: val }));
                    }}
                    id="filter-documents"
                  />
                  <Checkbox
                    label={t('grabber_filter_media')}
                    checked={filters.media}
                    onChange={(val) => {
                      setFilters((prev) => ({ ...prev, media: val }));
                    }}
                    id="filter-media"
                  />
                  <Checkbox
                    label={t('grabber_filter_others')}
                    checked={filters.others}
                    onChange={(val) => {
                      setFilters((prev) => ({ ...prev, others: val }));
                    }}
                    id="filter-others"
                  />
                </div>
              </div>

              <div className="space-y-3.5 border-t border-[var(--border-color)]/50 pt-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Switch
                    label={t('grabber_follow_external')}
                    checked={followOuterDomains}
                    onChange={setFollowOuterDomains}
                    id="grabber-domains"
                  />
                  <Switch
                    label={t('grabber_overwrite')}
                    checked={overwriteExisting}
                    onChange={setOverwriteExisting}
                    id="grabber-overwrite"
                  />
                </div>

                <div className="flex items-center gap-3 bg-[var(--bg-hover)]/20 p-2.5 rounded-lg border border-[var(--border-color)]/20">
                  <HelpCircle className="w-4 h-4 text-[var(--info)] shrink-0" />
                  <div className="text-[10px] text-[var(--text-muted)] leading-normal">
                    {t('grabber_notice')}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="w-[56%] flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin">
            <TextField
              label={t('grabber_url_label')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
              }}
              placeholder=""
              icon={Globe}
              id="grabber-url"
            />

            <div className="rounded-xl border border-[var(--border-color)] overflow-hidden min-h-[28rem] bg-[var(--bg-hover)]">
              {validPreviewUrl ? (
                <iframe
                  title="Webpage Preview"
                  src={url.trim()}
                  className="w-full h-full"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              ) : (
                <div className="flex h-full items-center justify-center p-4 text-[13px] text-[var(--text-secondary)]">
                  {t('grabber_preview_placeholder')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border-color)] bg-[var(--bg-sidebar)] shrink-0">
        <button
          onClick={handleBack}
          className="px-4 py-2 text-xs font-bold rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
        >
          {t('btn_cancel')}
        </button>
        <button
          onClick={() => {
            void handleStartScrape();
          }}
          className="px-4 py-2 text-xs font-bold rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
          disabled={isStarting}
        >
          <Download className="w-3.5 h-3.5" />
          {isStarting ? t('add_dl_checking') : t('grabber_start')}
        </button>
      </div>
    </div>
  );
};
