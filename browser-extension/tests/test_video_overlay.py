from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_video_overlay_content_entrypoint_is_registered() -> None:
    entrypoint = read('src/entrypoints/content.ts')
    config = read('wxt.config.ts')

    assert "export { default } from '../content/scanner';" in entrypoint
    assert "resources: ['icons/icon-48.png']" in config
    assert "matches: ['<all_urls>']" in config


def test_video_overlay_is_positioned_configurable_draggable_and_edge_aware() -> None:
    scanner = read('src/content/scanner.ts')
    settings = read('src/contracts/settings.schema.ts')
    options = read('src/ui/options/OverlaySettings.tsx')

    assert 'installVideoDownloadOverlay();' in scanner
    assert "VIDEO_OVERLAY_HOST_ID = 'adm-video-download-overlay-host'" in scanner
    assert "VIDEO_OVERLAY_POSITION_STORAGE_KEY = 'adm.videoOverlayPosition.v1'" in scanner
    assert "host.style.inset = '86px 18px auto auto';" in scanner
    assert 'chooseOverlayPlacement' in scanner
    assert 'chooseOverlayAlignment' in scanner
    assert "popover.dataset.placement" in scanner
    assert "popover.dataset.align" in scanner
    assert 'makeVideoOverlayDraggable(host, popover, settings, updatePlacement' in scanner
    assert "handle.addEventListener('pointerdown'" in scanner
    assert "handle.addEventListener('pointermove'" in scanner
    assert 'saveOverlayPosition(host, settings)' in scanner
    assert 'snapToEdges' in scanner
    assert 'readOverlaySettings' in scanner
    assert 'showOnlyWhenCandidates' in scanner
    assert 'destroyVideoOverlayHost(host)' in scanner
    assert 'VIDEO_OVERLAY_DESTROY_EVENT' in scanner
    assert 'PICKER_DESTROY_EVENT' in scanner
    assert 'currentOverlayPositionScopeKey(settings)' in scanner
    assert 'positionScope' in scanner
    assert 'hasOverlayCandidateHint(overlaySettings)' in scanner
    assert 'positionCandidatePicker(host, anchor' in scanner
    assert 'aria-keyshortcuts' in scanner
    assert 'nudgeOverlay(event.key, event.shiftKey)' in scanner
    assert 'settings.autoHideWhenIdle' in scanner
    assert 'isCandidateSelectedByDefault(candidate, settings)' in scanner
    assert "translate('videoOverlay.download', locale)" in scanner
    assert "translate('videoOverlay.close', locale)" in scanner
    assert "browser.runtime.getURL('icons/icon-48.png')" in scanner
    assert 'settings.compactPermanentActions' in scanner
    assert 'settings.showProgramLogo' in scanner
    assert 'settings.attachPickerToOverlay' in scanner
    assert 'positionCandidatePicker(picker, host, true)' in scanner
    assert "close.textContent = '×';" in scanner

    assert 'OverlaySettingsSchema' in settings
    assert "defaultPosition: OverlayPositionSchema.default('top-right')" in settings
    assert "openDirection: OverlayOpenDirectionSchema.default('auto')" in settings
    assert 'opacity:' in settings
    assert 'minConfidence' in settings
    assert 'OverlayPresetSchema' in settings
    assert 'OverlayPositionScopeSchema' in settings
    assert 'OverlayPickerSelectionSchema' in settings
    assert 'hideWhenFiltersRejectAll' in settings
    assert 'keyboardNudgePx' in settings
    assert 'autoHideWhenIdle' in settings
    assert 'maxPickerItems' in settings
    assert 'compactPermanentActions' in settings
    assert 'showProgramLogo' in settings
    assert 'attachPickerToOverlay' in settings
    assert 'defaultPickerSelection' in settings
    assert 'extensionsAllowlist' in settings
    assert 'extensionsBlocklist' in settings

    assert "t('overlay.options.resetSavedPosition')" in options
    assert 'compactPermanentActions' in options
    assert 'showProgramLogo' in options
    assert 'attachPickerToOverlay' in options
    assert 'Professional preset' in options
    assert 'Position scope' in options
    assert 'overlayPresetPatches' in options
    assert 'Smart filtering' in options
    assert 'Extension allowlist' in options
    assert 'Extension blocklist' in options
    assert 'Keyboard move step' in options
    assert 'Maximum picker items' in options
    assert 'Default picker selection' in options



def test_video_overlay_router_reports_filtering_and_diagnostics() -> None:
    router = read('src/background/message-router.ts')
    diagnostics = read('src/ui/diagnostics/DiagnosticsPanel.tsx')

    assert 'totalCandidates: candidates.length' in router
    assert 'filteredOut: Math.max(0, candidates.length - pickerCandidates.length)' in router
    assert 'Files were detected but hidden by overlay filters' in router
    assert 'analyzeOverlayCandidates(candidates, settings, smartVideoMode)' in router
    assert 'handoffPolicyDecision(candidate).allowed' in router
    assert 'filterReasons: overlayAnalysis.filterReasons' in router
    assert 'OVERLAY_DIAGNOSTICS_STORAGE_KEY' in router
    assert 'writeOverlayDiagnostics({ lastScan' in router
    assert 'overlayPositionDiagnostics' in router
    assert 'adm.downloadOverlayPosition.v2.' in router
    assert '<h2>Floating overlay</h2>' in diagnostics
    assert 'savedPositions' in diagnostics
    assert 'Last scan total' in diagnostics
    assert 'Non-handoffable' in diagnostics
    assert 'filterReasons' in diagnostics
