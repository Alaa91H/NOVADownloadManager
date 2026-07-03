import React, { useRef, useState } from 'react';
import { useI18n } from '../../i18n/react';

export function CopyDiagnostics({ diagnostics }: { diagnostics: unknown }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  async function copy(): Promise<void> {
    window.clearTimeout(timerRef.current);
    await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
    setCopied(true);
    timerRef.current = window.setTimeout(() => setCopied(false), 1800);
  }
  return <button data-variant="primary" onClick={() => void copy()}>{copied ? t('diagnostics.copied') : t('diagnostics.copy')}</button>;
}
export default CopyDiagnostics;
