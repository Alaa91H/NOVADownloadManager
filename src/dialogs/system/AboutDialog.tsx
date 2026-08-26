/* src/dialogs/system/AboutDialog.tsx */
import React from 'react';
import { CheckCircle, Code2, Download, ExternalLink, Heart, Mail, Send, Shield } from 'lucide-react';
import { tauriClient } from '../../api/tauriClient';
import { DialogButton } from '../../components/primitives';
import { useBridgeData, useDialogActions, useI18n } from '../../store/selectors';

const CONTACT_LINKS = [
  { labelKey: 'about_github', href: 'https://github.com/Alaa91H', icon: Code2, detail: 'github.com/Alaa91H' },
  { labelKey: 'about_email', href: 'mailto:alahus2591@gmail.com', icon: Mail, detail: 'alahus2591@gmail.com' },
  { labelKey: 'about_telegram', href: 'https://t.me/Alaa91h', icon: Send, detail: 't.me/Alaa91h' },
  { labelKey: 'about_support', href: 'https://ko-fi.com/alaa91h', icon: Heart, detail: 'ko-fi.com/alaa91h' },
] as const;

export const AboutDialog: React.FC = () => {
  const { closeDialog } = useDialogActions();
  const bridge = useBridgeData();
  const t = useI18n();

  return (
    <div className="space-y-5 py-2">
      <div className="flex flex-col items-center justify-center gap-3 text-center">
        <div className="w-16 h-16 rounded-2xl bg-[var(--accent-primary)] accent-glow border-2 border-white/10 flex items-center justify-center shadow-lg transform rotate-3">
          <Download className="w-9 h-9 text-white transform -rotate-3" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-[var(--text-primary)]">NOVA Download Manager</h2>
          <p className="text-xs text-[var(--text-muted)] font-mono">{t('about_tagline')}</p>
        </div>
      </div>

      <div className="bg-[var(--bg-hover)] p-4 rounded-xl border border-[var(--border-color)] text-xs leading-relaxed space-y-3 max-w-md mx-auto text-center">
        <p className="text-[var(--text-secondary)]">{t('about_description')}</p>

        <div className="flex items-center justify-center gap-4 text-[11px] font-mono border-t border-[var(--border-color)] pt-3 text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <CheckCircle className="w-3.5 h-3.5 text-[var(--success)]" />{' '}
            {t('about_service_version', { version: bridge.version || 'v0.1.0' })}
          </span>
          <span className="flex items-center gap-1">
            <Shield className="w-3.5 h-3.5 text-[var(--info)]" /> {t('about_open_source_license')}
          </span>
        </div>
      </div>

      <section
        className="max-w-md mx-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-hover)]/45 p-3.5 space-y-2"
        aria-label={t('about_support_title')}
      >
        <h3 className="text-xs font-extrabold text-[var(--accent-primary)]">{t('about_support_title')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {CONTACT_LINKS.map((link) => {
            const Icon = link.icon;
            const label = t(link.labelKey);
            return (
              <button
                key={link.labelKey}
                type="button"
                onClick={() => {
                  void tauriClient.openExternalUrl(link.href);
                }}
                className="group flex min-w-0 items-center gap-2 rounded-lg border border-[var(--border-color)]/70 bg-[var(--bg-surface)] px-2.5 py-2 text-left transition-colors hover:border-[var(--accent-border)] hover:bg-[var(--accent-primary)]/8 cursor-pointer"
                aria-label={t('about_open_external', { label })}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${link.labelKey === 'about_support' ? 'text-[var(--danger)]' : 'text-[var(--info)]'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-bold text-[var(--text-primary)]">{label}</span>
                  <span className="block truncate text-[10px] text-[var(--text-muted)]" dir="ltr">
                    {link.detail}
                  </span>
                </span>
                <ExternalLink className="h-3 w-3 shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            );
          })}
        </div>
      </section>

      <p className="text-center text-[10px] text-[var(--text-muted)]">{t('about_copyright')}</p>

      <div className="flex justify-center pt-1">
        <DialogButton onClick={closeDialog} variant="primary">
          {t('btn_close')}
        </DialogButton>
      </div>
    </div>
  );
};
