import browser from 'webextension-polyfill';
import React, { useState } from 'react';
import { Settings } from '../../contracts/settings.schema';
import { useI18n } from '../../i18n/react';

const OVERLAY_POSITION_STORAGE_KEY = 'nova.videoOverlayPosition.v1';
const OVERLAY_POSITION_STORAGE_PREFIX = 'nova.downloadOverlayPosition.v2';
const mediaTypeOptions: Settings['overlay']['mediaTypes'] = ['video', 'audio', 'image', 'document', 'archive', 'app', 'torrent', 'magnet', 'manifest', 'other'];

const overlayPresetPatches: Record<Exclude<Settings['overlay']['preset'], 'custom'>, Partial<Settings['overlay']>> = {
  minimal: {
    preset: 'minimal',
    compactPermanentActions: true,
    showProgramLogo: false,
    attachPickerToOverlay: true,
    opacity: 0.62,
    hoverOpacity: 0.96,
    buttonSizePx: 40,
    autoHideWhenIdle: true,
    idleAfterMs: 5000,
    maxPickerItems: 60,
    smartVideoOnlyOnVideoPages: true,
    smartVideoMaxItems: 40,
    smartVideoContinuousRefresh: true,
    smartVideoRefreshMs: 3000,
    defaultPickerSelection: 'high-confidence',
    showOnlyWhenCandidates: true,
    minConfidence: 50,
    minFileSizeMB: 5,
    mediaTypes: ['video', 'audio', 'document', 'archive'],
    extensionsBlocklist: ['css', 'js', 'woff', 'woff2', 'ttf', 'ico', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'],
  },
  smart: {
    preset: 'smart',
    compactPermanentActions: true,
    showProgramLogo: false,
    attachPickerToOverlay: true,
    opacity: 0.86,
    hoverOpacity: 1,
    buttonSizePx: 46,
    autoHideWhenIdle: false,
    idleAfterMs: 8000,
    maxPickerItems: 100,
    smartVideoOnlyOnVideoPages: true,
    smartVideoMaxItems: 60,
    smartVideoContinuousRefresh: true,
    smartVideoRefreshMs: 2500,
    defaultPickerSelection: 'high-confidence',
    showOnlyWhenCandidates: true,
    minConfidence: 20,
    minFileSizeMB: 1,
    mediaTypes: ['video', 'audio', 'image', 'document', 'archive', 'app', 'torrent', 'magnet', 'manifest', 'other'],
    extensionsBlocklist: ['css', 'js', 'woff', 'woff2', 'ttf', 'ico'],
  },
  'media-focused': {
    preset: 'media-focused',
    compactPermanentActions: true,
    showProgramLogo: false,
    attachPickerToOverlay: true,
    opacity: 0.9,
    hoverOpacity: 1,
    buttonSizePx: 48,
    autoHideWhenIdle: false,
    idleAfterMs: 8000,
    maxPickerItems: 120,
    smartVideoOnlyOnVideoPages: true,
    smartVideoMaxItems: 80,
    smartVideoContinuousRefresh: true,
    smartVideoRefreshMs: 2000,
    defaultPickerSelection: 'high-confidence',
    showOnlyWhenCandidates: true,
    minConfidence: 15,
    minFileSizeMB: 2,
    mediaTypes: ['video', 'audio', 'manifest'],
    extensionsBlocklist: ['css', 'js', 'woff', 'woff2', 'ttf', 'ico', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'],
  },
  'power-user': {
    preset: 'power-user',
    compactPermanentActions: true,
    showProgramLogo: false,
    attachPickerToOverlay: true,
    opacity: 0.92,
    hoverOpacity: 1,
    buttonSizePx: 52,
    autoHideWhenIdle: false,
    idleAfterMs: 10000,
    maxPickerItems: 250,
    smartVideoOnlyOnVideoPages: false,
    smartVideoMaxItems: 120,
    smartVideoContinuousRefresh: true,
    smartVideoRefreshMs: 2500,
    defaultPickerSelection: 'all',
    showOnlyWhenCandidates: false,
    minConfidence: 0,
    minFileSizeMB: 0,
    mediaTypes: ['video', 'audio', 'image', 'document', 'archive', 'app', 'torrent', 'magnet', 'manifest', 'other'],
    extensionsBlocklist: [],
  },
  'store-safe': {
    preset: 'store-safe',
    compactPermanentActions: true,
    showProgramLogo: false,
    attachPickerToOverlay: true,
    opacity: 0.82,
    hoverOpacity: 1,
    buttonSizePx: 44,
    autoHideWhenIdle: true,
    idleAfterMs: 7000,
    maxPickerItems: 80,
    smartVideoOnlyOnVideoPages: true,
    smartVideoMaxItems: 60,
    smartVideoContinuousRefresh: true,
    smartVideoRefreshMs: 2500,
    defaultPickerSelection: 'high-confidence',
    showOnlyWhenCandidates: true,
    minConfidence: 35,
    minFileSizeMB: 1,
    mediaTypes: ['video', 'audio', 'document', 'archive', 'torrent', 'magnet', 'manifest'],
    extensionsBlocklist: ['css', 'js', 'woff', 'woff2', 'ttf', 'ico', 'svg'],
  },
};

type Overlay = Settings['overlay'];

function normalizeNumber(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function listToText(values: string[]): string {
  return values.join(', ');
}

function textToList(value: string): string[] {
  return value
    .split(/[,\n\s]+/)
    .map((item) => item.trim().replace(/^\.+/, '').toLowerCase())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
}

export function OverlaySettings({ settings, onChange }: { settings: Settings; onChange(settings: Settings): void }) {
  const overlay = settings.overlay;
  const [notice, setNotice] = useState<string>('');
  const { t } = useI18n();

  const positionOptions: Array<{ value: Settings['overlay']['defaultPosition']; label: string }> = [
    { value: 'top-right', label: t('overlay.options.position.topRight') },
    { value: 'top-left', label: t('overlay.options.position.topLeft') },
    { value: 'bottom-right', label: t('overlay.options.position.bottomRight') },
    { value: 'bottom-left', label: t('overlay.options.position.bottomLeft') },
    { value: 'custom', label: t('overlay.options.position.custom') },
  ];
  const directionOptions: Array<{ value: Settings['overlay']['openDirection']; label: string }> = [
    { value: 'auto', label: t('overlay.options.direction.auto') },
    { value: 'up', label: t('overlay.options.direction.up') },
    { value: 'down', label: t('overlay.options.direction.down') },
    { value: 'left', label: t('overlay.options.direction.left') },
    { value: 'right', label: t('overlay.options.direction.right') },
  ];

  const positionScopeOptions: Array<{ value: Settings['overlay']['positionScope']; label: string }> = [
    { value: 'global', label: t('overlay.options.scope.global') },
    { value: 'domain', label: t('overlay.options.scope.domain') /* Per domain */ },
    { value: 'site', label: t('overlay.options.scope.site') /* Per exact site origin */ },
  ];

  const presetOptions: Array<{ value: Settings['overlay']['preset']; label: string }> = [
    { value: 'custom', label: t('overlay.options.preset.custom') },
    { value: 'minimal', label: t('overlay.options.preset.minimal') /* Minimal */ },
    { value: 'smart', label: t('overlay.options.preset.smart') /* Smart */ },
    { value: 'media-focused', label: t('overlay.options.preset.mediaFocused') /* Media focused */ },
    { value: 'power-user', label: t('overlay.options.preset.powerUser') /* Power user */ },
    { value: 'store-safe', label: t('overlay.options.preset.storeSafe') /* Store safe */ },
  ];

  const pickerSelectionOptions: Array<{ value: Settings['overlay']['defaultPickerSelection']; label: string }> = [
    { value: 'all', label: t('overlay.options.pickerSelectAll') },
    { value: 'high-confidence', label: t('overlay.options.pickerSelectConfident') },
    { value: 'none', label: t('overlay.options.pickerSelectNone') },
  ];

  function patch(next: Partial<Overlay>, markCustom = true): void {
    onChange({ ...settings, overlay: { ...overlay, ...(markCustom && !('preset' in next) ? { preset: 'custom' as Overlay['preset'] } : {}), ...next } });
  }

  function applyPreset(preset: Overlay['preset']): void {
    if (preset === 'custom') {
      patch({ preset }, false);
      return;
    }
    const configuredPreset = preset as Exclude<Overlay['preset'], 'custom'>;
    onChange({ ...settings, overlay: { ...overlay, ...overlayPresetPatches[configuredPreset] } });
  }

  function toggleMedia(mediaType: Overlay['mediaTypes'][number], enabled: boolean): void {
    const next = enabled ? [...new Set([...overlay.mediaTypes, mediaType])] : overlay.mediaTypes.filter((value) => value !== mediaType);
    if (next.length > 0) patch({ mediaTypes: next });
  }

  async function resetPosition(): Promise<void> {
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key === OVERLAY_POSITION_STORAGE_KEY || key.startsWith(`${OVERLAY_POSITION_STORAGE_PREFIX}.`));
    await browser.storage.local.remove(keys.length > 0 ? keys : [OVERLAY_POSITION_STORAGE_KEY]);
    setNotice(t('overlay.options.positionResetNotice'));
  }

  return <section className="nova-section">
    <div className="nova-section-title-row">
      <div>
        <h2>{t('overlay.options.title')}</h2>
        <p className="nova-help">{t('overlay.options.subtitle')}</p>
      </div>
      <span className="nova-pill" data-tone={overlay.enabled ? 'success' : 'warning'}>{overlay.enabled ? t('overlay.options.visible') : t('overlay.options.disabled')}</span>
    </div>

    {notice ? <div className="nova-notice" data-kind="info" role="status">{notice}</div> : null}

    <div className="nova-card">
      <div className="nova-card-header">
        <div>
          <h3 className="nova-card-title">{t('overlay.options.positionBehavior')}</h3>
          <p className="nova-card-description">{t('overlay.options.positionBehaviorDescription')}</p>
        </div>
      </div>
      <div className="nova-field-grid">
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.preset')}</strong>{/* Professional preset */}<span>{t('overlay.options.presetHelp')}</span></span>
          <select value={overlay.preset} onChange={(event) => applyPreset(event.currentTarget.value as Overlay['preset'])}>
            {presetOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.enabled} onChange={(event) => patch({ enabled: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.enableButton')}</strong><span>{t('overlay.options.enableButtonHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.showOnlyWhenCandidates} onChange={(event) => patch({ showOnlyWhenCandidates: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.onlyWhenFiles')}</strong><span>{t('overlay.options.onlyWhenFilesHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.hideWhenFiltersRejectAll} onChange={(event) => patch({ hideWhenFiltersRejectAll: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.respectFilters')}</strong><span>{t('overlay.options.respectFiltersHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.defaultPosition')}</strong><span>{t('overlay.options.defaultPositionHelp')}</span></span>
          <select value={overlay.defaultPosition} onChange={(event) => patch({ defaultPosition: event.currentTarget.value as Overlay['defaultPosition'] })}>
            {positionOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.menuDirection')}</strong><span>{t('overlay.options.menuDirectionHelp')}</span></span>
          <select value={overlay.openDirection} onChange={(event) => patch({ openDirection: event.currentTarget.value as Overlay['openDirection'] })}>
            {directionOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.rememberDraggedPosition} onChange={(event) => patch({ rememberDraggedPosition: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.rememberDrag')}</strong><span>{t('overlay.options.rememberDragHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.positionScope')}</strong>{/* Position scope */}<span>{t('overlay.options.positionScopeHelp')}</span></span>
          <select value={overlay.positionScope} onChange={(event) => patch({ positionScope: event.currentTarget.value as Overlay['positionScope'] })}>
            {positionScopeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.snapToEdges} onChange={(event) => patch({ snapToEdges: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.snapToEdge')}</strong><span>{t('overlay.options.snapToEdgeHelp')}</span></span>
        </label>

        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.compactPermanentActions} onChange={(event) => patch({ compactPermanentActions: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.compactPermanentActions')}</strong><span>{t('overlay.options.compactPermanentActionsHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.showProgramLogo} onChange={(event) => patch({ showProgramLogo: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.showProgramLogo')}</strong><span>{t('overlay.options.showProgramLogoHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.attachPickerToOverlay} onChange={(event) => patch({ attachPickerToOverlay: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.attachPickerToOverlay')}</strong><span>{t('overlay.options.attachPickerToOverlayHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.keyboardMove')}</strong>{/* Keyboard move step */}<span>{t('overlay.options.keyboardMoveHelp')}</span></span>
          <input type="number" min={1} max={50} value={overlay.keyboardNudgePx} onChange={(event) => patch({ keyboardNudgePx: Math.round(normalizeNumber(event.currentTarget.value, overlay.keyboardNudgePx, 1, 50)) })} />
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.autoHideWhenIdle} onChange={(event) => patch({ autoHideWhenIdle: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.idleDimming')}</strong>{/* Idle dimming */}<span>{t('overlay.options.idleDimmingHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.idleDelay')}</strong><span>{t('overlay.options.idleDelayHelp')}</span></span>
          <input type="number" min={1000} max={60000} value={overlay.idleAfterMs} onChange={(event) => patch({ idleAfterMs: Math.round(normalizeNumber(event.currentTarget.value, overlay.idleAfterMs, 1000, 60000)) })} />
        </label>
      </div>
      <div className="nova-toolbar">
        <button type="button" onClick={() => void resetPosition()}>{t('overlay.options.resetSavedPosition')}</button>
      </div>
    </div>

    <div className="nova-card">
      <div className="nova-card-header">
        <div>
          <h3 className="nova-card-title">{t('overlay.options.visualTuning')}</h3>
          <p className="nova-card-description">{t('overlay.options.visualTuningHelp')}</p>
        </div>
      </div>
      <div className="nova-field-grid">
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.idleOpacity')}</strong><span>{Math.round(overlay.opacity * 100)}%</span></span>
          <input type="range" min="0.2" max="1" step="0.01" value={overlay.opacity} onChange={(event) => patch({ opacity: normalizeNumber(event.currentTarget.value, overlay.opacity, 0.2, 1) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.hoverOpacity')}</strong><span>{Math.round(overlay.hoverOpacity * 100)}%</span></span>
          <input type="range" min="0.2" max="1" step="0.01" value={overlay.hoverOpacity} onChange={(event) => patch({ hoverOpacity: normalizeNumber(event.currentTarget.value, overlay.hoverOpacity, 0.2, 1) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.buttonSize')}</strong><span>{t('overlay.options.buttonSizeHelp')}</span></span>
          <input type="number" min={32} max={72} value={overlay.buttonSizePx} onChange={(event) => patch({ buttonSizePx: Math.round(normalizeNumber(event.currentTarget.value, overlay.buttonSizePx, 32, 72)) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.scale')}</strong><span>{overlay.scale.toFixed(2)}×</span></span>
          <input type="range" min="0.7" max="1.4" step="0.01" value={overlay.scale} onChange={(event) => patch({ scale: normalizeNumber(event.currentTarget.value, overlay.scale, 0.7, 1.4) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.animationMs')}</strong><span>{t('overlay.options.animationMsHelp')}</span></span>
          <input type="number" min={0} max={400} value={overlay.menuAnimationMs} onChange={(event) => patch({ menuAnimationMs: Math.round(normalizeNumber(event.currentTarget.value, overlay.menuAnimationMs, 0, 400)) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.zIndex')}</strong><span>{t('overlay.options.zIndexHelp')}</span></span>
          <input type="number" min={1000} max={2147483647} value={overlay.zIndex} onChange={(event) => patch({ zIndex: Math.round(normalizeNumber(event.currentTarget.value, overlay.zIndex, 1000, 2147483647)) })} />
        </label>
      </div>
    </div>

    <div className="nova-card">
      <div className="nova-card-header">
        <div>
          <h3 className="nova-card-title">{t('overlay.options.smartFiltering')}</h3>{/* Smart filtering */}
          <p className="nova-card-description">{t('overlay.options.smartFilteringHelp')}</p>
        </div>
      </div>
      <div className="nova-field-grid">
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.smartVideoOnlyOnVideoPages} onChange={(event) => patch({ smartVideoOnlyOnVideoPages: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.smartVideoMode')}</strong>{/* Smart video-page mode */}<span>{t('overlay.options.smartVideoModeHelp')}</span></span>
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.videoItemLimit')}</strong>{/* Video-page item limit */}<span>{t('overlay.options.videoItemLimitHelp')}</span></span>
          <input type="number" min={1} max={200} value={overlay.smartVideoMaxItems} onChange={(event) => patch({ smartVideoMaxItems: Math.round(normalizeNumber(event.currentTarget.value, overlay.smartVideoMaxItems, 1, 200)) })} />
        </label>
        <label className="nova-toggle">
          <input type="checkbox" checked={overlay.smartVideoContinuousRefresh} onChange={(event) => patch({ smartVideoContinuousRefresh: event.currentTarget.checked })} />
          <span><strong>{t('overlay.options.continuousQuality')}</strong><span>{t('overlay.options.continuousQualityHelp')}</span></span>{/* Continuous quality discovery */}
        </label>
        <label className="nova-toggle">
            <span><strong>{t('overlay.options.refreshInterval')}</strong><span>{t('overlay.options.refreshIntervalHelp')}</span>{/* Live media/network/DOM changes refresh immediately */}{/* Refresh interval ms */}</span>
          <input type="number" min={250} max={15000} value={overlay.smartVideoRefreshMs} onChange={(event) => patch({ smartVideoRefreshMs: Math.round(normalizeNumber(event.currentTarget.value, overlay.smartVideoRefreshMs, 250, 15000)) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.minConfidence')}</strong><span>{Math.round(overlay.minConfidence)}%</span></span>
          <input type="range" min="0" max="100" step="1" value={overlay.minConfidence} onChange={(event) => patch({ minConfidence: normalizeNumber(event.currentTarget.value, overlay.minConfidence, 0, 100) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.minSize')}</strong><span>{t('overlay.options.minSizeHelp')}</span></span>
          <input type="number" min={0} value={overlay.minFileSizeMB} onChange={(event) => patch({ minFileSizeMB: normalizeNumber(event.currentTarget.value, overlay.minFileSizeMB, 0, 1024 * 1024) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.maxSize')}</strong><span>{t('overlay.options.maxSizeHelp')}</span></span>
          <input type="number" min={0} value={overlay.maxFileSizeMB} onChange={(event) => patch({ maxFileSizeMB: normalizeNumber(event.currentTarget.value, overlay.maxFileSizeMB, 0, 1024 * 1024) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.maxPickerItems')}</strong>{/* Maximum picker items */}<span>{t('overlay.options.maxPickerItemsHelp')}</span></span>
          <input type="number" min={10} max={500} value={overlay.maxPickerItems} onChange={(event) => patch({ maxPickerItems: Math.round(normalizeNumber(event.currentTarget.value, overlay.maxPickerItems, 10, 500)) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.defaultPickerSelection')}</strong>{/* Default picker selection */}<span>{t('overlay.options.defaultPickerSelectionHelp')}</span></span>
          <select value={overlay.defaultPickerSelection} onChange={(event) => patch({ defaultPickerSelection: event.currentTarget.value as Overlay['defaultPickerSelection'] })}>
            {pickerSelectionOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <div className="nova-check-grid">
        {mediaTypeOptions.map((mediaType) => <label key={mediaType} className="nova-check-chip">
          <input type="checkbox" checked={overlay.mediaTypes.includes(mediaType)} onChange={(event) => toggleMedia(mediaType, event.currentTarget.checked)} /> {mediaType}
        </label>)}
      </div>
      <div className="nova-field-grid">
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.allowlist')}</strong><span>{t('overlay.options.allowlistHelp')}</span></span>{/* Extension allowlist */}
          <textarea rows={3} value={listToText(overlay.extensionsAllowlist)} onChange={(event) => patch({ extensionsAllowlist: textToList(event.currentTarget.value) })} />
        </label>
        <label className="nova-toggle">
          <span><strong>{t('overlay.options.blocklist')}</strong><span>{t('overlay.options.blocklistHelp')}</span></span>{/* Extension blocklist */}
          <textarea rows={3} value={listToText(overlay.extensionsBlocklist)} onChange={(event) => patch({ extensionsBlocklist: textToList(event.currentTarget.value) })} />
        </label>
      </div>
    </div>
  </section>;
}

export default OverlaySettings;
