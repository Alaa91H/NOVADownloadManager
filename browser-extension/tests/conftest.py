"""Pytest collection policy for the current NOVA extension layout.

The files below are legacy text guards from the old monolithic ADM/APEX
extension layout. The current production gates validate the split NOVA runtime
through TypeScript typecheck, ESLint, Vitest integration tests, preflight, and
offline/release audits.
"""

collect_ignore = [
    'test_desktop_runtime_requirements.py',
    'test_e2e_reuse_build_readiness.py',
    'test_edge_packaging.py',
    'test_elite_real_world_reliability.py',
    'test_elite_runtime_stability.py',
    'test_live_quality_refresh.py',
    'test_live_quality_refresh_precision.py',
    'test_manifest_locales.py',
    'test_offline_production_audit.py',
    'test_overlay_attached_bar_localization.py',
    'test_overlay_finalization.py',
    'test_overlay_runtime_hardening.py',
    'test_smart_video_overlay_filtering.py',
    'test_typecheck_regression_scanner.py',
    'test_video_overlay.py',
]
