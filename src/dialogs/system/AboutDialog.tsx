/* src/dialogs/system/AboutDialog.tsx */
import React from 'react';
import { Download, CheckCircle, Shield } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { DialogButton } from '../../components/primitives';

export const AboutDialog: React.FC = () => {
  const { closeDialog, bridge, t } = useAppStore();

  return (
    <div className="text-center space-y-5 py-2">
      <div className="flex flex-col items-center justify-center gap-3">
        <div className="w-16 h-16 rounded-2xl bg-[var(--accent-primary)] accent-glow border-2 border-white/10 flex items-center justify-center shadow-lg transform rotate-3">
          <Download className="w-9 h-9 text-white transform -rotate-3" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-[var(--text-primary)]">{t('app_name')}</h2>
          <p className="text-xs text-[var(--text-muted)] font-mono">{t('about_local_service')}</p>
        </div>
      </div>

      <div className="bg-[var(--bg-hover)] p-4 rounded-xl border border-[var(--border-color)] text-xs leading-relaxed space-y-3 max-w-md mx-auto text-center">
        <p className="text-[var(--text-secondary)]">
          {t('about_description')}
        </p>

        <div className="flex items-center justify-center gap-4 text-[11px] font-mono border-t border-[var(--border-color)] pt-3 text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <CheckCircle className="w-3.5 h-3.5 text-green-500" /> {t('about_service_label')} {bridge.version || 'v0.1.0'}
          </span>
          <span className="flex items-center gap-1">
            <Shield className="w-3.5 h-3.5 text-blue-500" /> {t('about_open_source_license')}
          </span>
        </div>
      </div>

      <p className="text-[10px] text-[var(--text-muted)]">{t('about_copyright')}</p>

      <div className="flex justify-center pt-3">
        <DialogButton onClick={closeDialog} variant="primary">
          {t('btn_ok')}
        </DialogButton>
      </div>
    </div>
  );
};
