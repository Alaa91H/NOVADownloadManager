/* src/dialogs/diagnostics/DiagnosticsDialog.tsx */
import React, { useEffect, useRef, useState } from 'react';
import { Cpu, HardDrive, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { tauriClient, DiagnosticData } from '../../api/tauriClient';
import { useAppStore } from '../../state/appStore';
import { DialogButton, Button } from '../../components/primitives';

export const DiagnosticsDialog: React.FC = () => {
  const { t } = useAppStore();
  const [data, setData] = useState<DiagnosticData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetchDiagnostics = async () => {
    try {
      setError(null);
      const result = await tauriClient.getDiagnostics();
      if (cancelledRef.current) return;
      setData(result);
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    cancelledRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch with cancellation ref; setState guarded by cancelledRef
    void fetchDiagnostics();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return (
    <div className="space-y-4 text-left" dir="ltr">
      <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-2">
        <p className="text-[11px] text-[var(--text-muted)]">
          {t('diag_refresh_desc')}
        </p>
        <Button
          onClick={() => {
            setLoading(true);
            void fetchDiagnostics();
          }}
          variant="ghost"
          icon={RefreshCw}
          size="sm"
          disabled={loading}
        >
          {t('diag_refresh_btn')}
        </Button>
      </div>

      {loading ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <span className="w-8 h-8 rounded-full border-4 border-[var(--accent-primary)] border-t-transparent animate-spin" />
          <span className="text-xs text-[var(--text-secondary)]">{t('diag_loading')}</span>
        </div>
      ) : error ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <div className="p-3 rounded-full bg-rose-500/10">
            <AlertTriangle className="w-8 h-8 text-rose-500" />
          </div>
          <h3 className="text-sm font-bold text-[var(--text-secondary)]">{t('diag_error')}</h3>
          <p className="text-[11px] text-[var(--text-muted)] max-w-xs leading-relaxed">{t('diag_error_desc')}</p>
          <span className="text-[10px] text-rose-400 font-mono mt-1">{error}</span>
        </div>
      ) : data ? (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] p-3 rounded-lg flex flex-col gap-1">
              <div className="flex justify-between items-center text-[var(--text-secondary)] mb-1">
                <span className="text-xs">{t('diag_cpu')}</span>
                <Cpu className="w-4 h-4 text-orange-500" />
              </div>
              <span className="text-lg font-bold font-mono">{data.cpuUsage}%</span>
              <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden mt-1">
                <div className="bg-orange-500 h-full" style={{ width: `${String(data.cpuUsage)}%` }} />
              </div>
            </div>

            <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] p-3 rounded-lg flex flex-col gap-1">
              <div className="flex justify-between items-center text-[var(--text-secondary)] mb-1">
                <span className="text-xs">{t('diag_memory')}</span>
                <Cpu className="w-4 h-4 text-emerald-500" />
              </div>
              <span className="text-lg font-bold font-mono">{data.memoryUsageMb} MB</span>
              <p className="text-[10px] text-[var(--text-muted)]">{t('diag_memory_desc')}</p>
            </div>

            <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] p-3 rounded-lg flex flex-col gap-1">
              <div className="flex justify-between items-center text-[var(--text-secondary)] mb-1">
                <span className="text-xs">{t('diag_disk')}</span>
                <HardDrive className="w-4 h-4 text-blue-500" />
              </div>
              <span className="text-lg font-bold font-mono">{data.diskFreeGb} GB</span>
              <p className="text-[10px] text-[var(--text-muted)]">{t('diag_disk_desc')}</p>
            </div>
          </div>

          <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-lg p-3 space-y-2">
            <h4 className="text-xs font-semibold text-[var(--text-primary)] border-b border-[var(--border-color)] pb-1 mb-2">
              {t('diag_system_details')}
            </h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">{t('diag_os')}</span>
                <span className="font-medium font-mono text-left">{data.osName}</span>
              </div>
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">{t('diag_service_version')}</span>
                <span className="font-medium font-mono text-left text-green-500">{data.daemonVersion}</span>
              </div>
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">{t('diag_runtime_target')}</span>
                <span className="font-medium font-mono text-left">{data.rustTarget}</span>
              </div>
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">{t('diag_sqlite')}</span>
                <span className="font-medium font-mono text-left">{data.sqliteVersion}</span>
              </div>
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">{t('diag_active_connections')}</span>
                <span className="font-medium font-mono text-left">{data.activeThreads} {t('diag_active')}</span>
              </div>
            </div>
          </div>

          <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-lg p-3 space-y-2">
            <h4 className="text-xs font-semibold text-[var(--text-primary)] border-b border-[var(--border-color)] pb-1 mb-2">
              {t('diag_network_interfaces')}
            </h4>
            <div className="space-y-1">
              {data.networkInterfaces.map((net, index) => {
                // The daemon reports interfaces as "name=ip" strings; tolerate the
                // structured object form as well.
                const iface =
                  typeof net === 'string'
                    ? {
                        name: net.split('=')[0] || net,
                        ip: net.split('=').slice(1).join('=') || '—',
                        speedMbps: undefined,
                      }
                    : net;
                return (
                  <div
                    key={`${iface.name}-${String(index)}`}
                    className="flex justify-between items-center text-xs border-b border-[var(--border-color)] py-1.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      <span className="text-[var(--text-secondary)]">{iface.name}</span>
                    </div>
                    <div className="flex items-center gap-4 font-mono">
                      <span className="text-slate-400">{iface.ip}</span>
                      {iface.speedMbps !== undefined && (
                        <span className="text-[var(--accent-primary)] font-semibold">{iface.speedMbps} Mbps</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {data.engineCapabilities ? (
            <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-lg p-3 space-y-2">
              <h4 className="text-xs font-semibold text-[var(--text-primary)] border-b border-[var(--border-color)] pb-1 mb-2">
                {t('diag_engine_capabilities')}
              </h4>
              <p className="text-[10px] text-[var(--text-muted)]">
                {t('diag_engine_caps_desc')}
              </p>
              <pre className="max-h-80 overflow-auto rounded-md bg-black/20 p-3 text-[10px] leading-4 text-[var(--text-secondary)] whitespace-pre-wrap">
                {JSON.stringify(data.engineCapabilities, null, 2)}
              </pre>
            </div>
          ) : null}

          <div className="flex gap-2 items-center p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded-lg text-[11px]">
            <ShieldCheck className="w-5 h-5 shrink-0" />
            <span>{t('diag_success')}</span>
          </div>
        </div>
      ) : null}

      <div className="flex justify-end pt-4 border-t border-[var(--border-color)]">
        <DialogButton
          onClick={() => {
            setData(null);
          }}
          variant="primary"
        >
          {t('diag_close_report')}
        </DialogButton>
      </div>
    </div>
  );
};
