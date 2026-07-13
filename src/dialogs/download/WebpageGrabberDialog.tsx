/* src/dialogs/download/WebpageGrabberDialog.tsx */
import React, { useState } from 'react';
import { Globe, FolderOpen, Layers, CheckSquare, Download, HelpCircle, FileText } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { TextField, SelectField, Switch, Checkbox, DialogButton, DegradedBanner } from '../../components/primitives';

export const WebpageGrabberDialog: React.FC = () => {
  const { closeDialog, queues, settings, addToast, t, isDegradedMode } = useAppStore();
  const [url, setUrl] = useState('');
  const [savePath, setSavePath] = useState(
    settings.saveAndCategories.categoryFolders.document || settings.saveAndCategories.defaultFolder || '',
  );
  const [depth, setDepth] = useState<number>(1);
  const [saveFormat, setSaveFormat] = useState<'single' | 'folder' | 'text'>('single');
  const [selectedQueue, setSelectedQueue] = useState('main');

  // File filters
  const [filters, setFilters] = useState({
    pages: true,
    styles: true,
    images: true,
    documents: false,
    media: false,
    others: false,
  });

  // Advanced settings
  const [followOuterDomains, setFollowOuterDomains] = useState(false);
  const [overwriteExisting, setOverwriteExisting] = useState(true);

  const handleStartScrape = () => {
    if (!url || !url.trim().startsWith('http')) {
      addToast('error', t('grabber_toast_invalid_title'), t('grabber_toast_invalid_desc'));
      return;
    }

    addToast(
      'warning',
      t('grabber_toast_backend_title'),
      t('grabber_toast_backend_desc'),
    );
  };
  return (
    <div className={`space-y-5 text-ui text-left`} dir={'ltr'}>
      {isDegradedMode && (
        <DegradedBanner title={t('dialog_degraded_title')} description={t('dialog_degraded_desc')} />
      )}
      {/* Intro info banner */}
      <div className="bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20 rounded-lg p-3 text-xs leading-relaxed text-slate-200">
        <p className="font-semibold flex items-center gap-1.5 text-[var(--accent-primary)] mb-1">
          <Globe className="w-4 h-4" />
          {t('grabber_title')}
        </p>
        <p className="text-[11px] text-slate-400">
          {t('grabber_description')}
        </p>
      </div>

      <div className="space-y-4">
        {/* Row 1: URL input */}
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

        {/* Row 2: Save Path & Queue */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TextField
            label={t('grabber_save_dir')}
            value={savePath}
            onChange={(e) => {
              setSavePath(e.target.value);
            }}
            icon={FolderOpen}
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
        </div>

        {/* Row 3: Scrape Depth & Save Format */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-[var(--border-color)]/50 pt-3">
          <div className="space-y-1.5">
            <label className="text-xs font-extrabold text-slate-300 flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
              {t('grabber_depth_label')}
            </label>
            <select
              value={depth}
              onChange={(e) => {
                setDepth(Number(e.target.value));
              }}
              className="w-full text-xs font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-[var(--accent-primary)]"
              id="grabber-depth"
            >
              <option value={1}>{t('grabber_depth_1')}</option>
              <option value={2}>{t('grabber_depth_2')}</option>
              <option value={3}>{t('grabber_depth_3')}</option>
              <option value={4}>{t('grabber_depth_4')}</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-extrabold text-slate-300 flex items-center gap-1">
              <FileText className="w-3.5 h-3.5 text-emerald-400" />
              {t('grabber_format_label')}
            </label>
            <select
              value={saveFormat}
              onChange={(e) => {
                setSaveFormat(e.target.value as 'single' | 'folder' | 'text');
              }}
              className="w-full text-xs font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-[var(--accent-primary)]"
              id="grabber-format"
            >
              <option value="single">{t('grabber_format_single')}</option>
              <option value="folder">{t('grabber_format_folder')}</option>
              <option value="text">{t('grabber_format_text')}</option>
            </select>
          </div>
        </div>

        {/* Row 4: File Type Filters */}
        <div className="space-y-2 border-t border-[var(--border-color)]/50 pt-3">
          <span className="text-xs font-extrabold text-slate-300 flex items-center gap-1">
            <CheckSquare className="w-3.5 h-3.5 text-teal-400" />
            {t('grabber_filters_label')}
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
              label={t('grabber_filter_documents')}
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

        {/* Row 5: Advanced Scraper Controls */}
        <div className="space-y-3.5 border-t border-[var(--border-color)]/50 pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Switch
              label={t('grabber_follow_domains')}
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
            <HelpCircle className="w-4 h-4 text-sky-400 shrink-0" />
            <div className="text-[10px] text-slate-400 leading-normal">
              {t('grabber_backend_note')}
            </div>
          </div>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex justify-end gap-2 border-t border-[var(--border-color)] pt-3">
        <DialogButton onClick={closeDialog} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
        <DialogButton onClick={handleStartScrape} variant="primary" className="flex items-center gap-1.5 font-bold">
          <Download className="w-3.5 h-3.5" />
          {t('grabber_start')}
        </DialogButton>
      </div>
    </div>
  );
};
