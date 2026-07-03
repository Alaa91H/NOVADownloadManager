/* src/dialogs/diagnostics/DiagnosticsDialog.tsx */
import React, { useEffect, useState } from 'react';
import { Cpu, HardDrive, RefreshCw, ShieldCheck } from 'lucide-react';
import { tauriClient, DiagnosticData } from '../../api/tauriClient';
import { DialogButton, Button } from '../../components/primitives';

export const DiagnosticsDialog: React.FC = () => {
  const [data, setData] = useState<DiagnosticData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDiagnostics = async () => {
    setLoading(true);
    const result = await tauriClient.getDiagnostics();
    setData(result);
    setLoading(false);
  };

  useEffect(() => {
    // Initial load: `loading` already starts as true, so only the async
    // completion needs to touch state.
    let cancelled = false;
    tauriClient.getDiagnostics().then(result => {
      if (cancelled) return;
      setData(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4 text-left" dir="ltr">
      <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-2">
        <p className="text-[11px] text-[var(--text-muted)]">
          Report refreshed through the local service diagnostics API.
        </p>
        <Button onClick={fetchDiagnostics} variant="ghost" icon={RefreshCw} size="sm" disabled={loading}>
          Refresh Report
        </Button>
      </div>

      {loading ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3">
          <span className="w-8 h-8 rounded-full border-4 border-[var(--accent-primary)] border-t-transparent animate-spin" />
          <span className="text-xs text-[var(--text-secondary)]">Generating live diagnostics...</span>
        </div>
      ) : data ? (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] p-3 rounded-lg flex flex-col gap-1">
              <div className="flex justify-between items-center text-[var(--text-secondary)] mb-1">
                <span className="text-xs">Service CPU Usage</span>
                <Cpu className="w-4 h-4 text-orange-500" />
              </div>
              <span className="text-lg font-bold font-mono">{data.cpuUsage}%</span>
              <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden mt-1">
                <div className="bg-orange-500 h-full" style={{ width: `${data.cpuUsage}%` }} />
              </div>
            </div>

            <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] p-3 rounded-lg flex flex-col gap-1">
              <div className="flex justify-between items-center text-[var(--text-secondary)] mb-1">
                <span className="text-xs">Memory Usage</span>
                <Cpu className="w-4 h-4 text-emerald-500" />
              </div>
              <span className="text-lg font-bold font-mono">{data.memoryUsageMb} MB</span>
              <p className="text-[10px] text-[var(--text-muted)]">Allocated runtime memory</p>
            </div>

            <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] p-3 rounded-lg flex flex-col gap-1">
              <div className="flex justify-between items-center text-[var(--text-secondary)] mb-1">
                <span className="text-xs">Free Disk Space</span>
                <HardDrive className="w-4 h-4 text-blue-500" />
              </div>
              <span className="text-lg font-bold font-mono">{data.diskFreeGb} GB</span>
              <p className="text-[10px] text-[var(--text-muted)]">Default system drive</p>
            </div>
          </div>

          <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-lg p-3 space-y-2">
            <h4 className="text-xs font-semibold text-[var(--text-primary)] border-b border-[var(--border-color)] pb-1 mb-2">System Details</h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">Operating System</span>
                <span className="font-medium font-mono text-left">{data.osName}</span>
              </div>
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">Service Version</span>
                <span className="font-medium font-mono text-left text-green-500">{data.daemonVersion}</span>
              </div>
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">Runtime Target</span>
                <span className="font-medium font-mono text-left">{data.rustTarget}</span>
              </div>
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">SQLite</span>
                <span className="font-medium font-mono text-left">{data.sqliteVersion}</span>
              </div>
              <div className="flex justify-between border-b border-[var(--border-color)] py-1">
                <span className="text-[var(--text-secondary)]">Active Connections</span>
                <span className="font-medium font-mono text-left">{data.activeThreads} active</span>
              </div>
            </div>
          </div>

          <div className="bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-lg p-3 space-y-2">
            <h4 className="text-xs font-semibold text-[var(--text-primary)] border-b border-[var(--border-color)] pb-1 mb-2">Network Interfaces</h4>
            <div className="space-y-1">
              {data.networkInterfaces.map(net => (
                <div key={net.name} className="flex justify-between items-center text-xs border-b border-[var(--border-color)] py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                    <span className="text-[var(--text-secondary)]">{net.name}</span>
                  </div>
                  <div className="flex items-center gap-4 font-mono">
                    <span className="text-slate-400">{net.ip}</span>
                    <span className="text-[var(--accent-primary)] font-semibold">{net.speedMbps} Mbps</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2 items-center p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded-lg text-[11px]">
            <ShieldCheck className="w-5 h-5 shrink-0" />
            <span>Diagnostics were collected successfully.</span>
          </div>
        </div>
      ) : null}

      <div className="flex justify-end pt-4 border-t border-[var(--border-color)]">
        <DialogButton onClick={() => setData(null)} variant="primary">
          Close Report
        </DialogButton>
      </div>
    </div>
  );
};
