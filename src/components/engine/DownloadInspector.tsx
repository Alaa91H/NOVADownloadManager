import { useEffect, useState, useRef } from 'react';
import type { DownloadItem } from '../../types/desktop-ui.types';
import { SpeedGraph } from './SpeedGraph';
import { SegmentVisualization } from './SegmentVisualization';
import { engineApi, type EngineEvent } from '../../api/engineClient';
import {
  Activity,
  Clock,
  HardDrive,
  Layers,
  Link,
  RefreshCw,
  Shield,
  Zap,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';

interface DownloadInspectorProps {
  task: DownloadItem;
  onClose: () => void;
}

type InspectorTab = 'overview' | 'segments' | 'history' | 'checksum';

export const DownloadInspector: React.FC<DownloadInspectorProps> = ({ task, onClose }) => {
  const [activeTab, setActiveTab] = useState<InspectorTab>('overview');
  const [taskEvents, setTaskEvents] = useState<EngineEvent[]>([]);
  const [checksumResult, setChecksumResult] = useState<{
    status: 'idle' | 'verifying' | 'pass' | 'fail' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    connection: true,
    segments: true,
    meta: false,
  });
  const [expectedChecksum, setExpectedChecksum] = useState('');
  const [verifyPath, setVerifyPath] = useState('');
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await engineApi.getTaskEvents(task.id, 50);
        if (data.ok && mountedRef.current) setTaskEvents(data.events);
      } catch { /* silent */ }
    };
    void load();
    timerRef.current = window.setInterval(() => {
      void load();
    }, 2000);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [task.id]);

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleVerifyChecksum = async () => {
    if (!expectedChecksum.trim() || !verifyPath.trim()) return;
    setChecksumResult({ status: 'verifying' });
    try {
      const result = await engineApi.verifyChecksum(verifyPath.trim(), expectedChecksum.trim());
      if (result.ok && result.passed) {
        setChecksumResult({ status: 'pass', message: `Verified with ${result.algorithm ?? 'auto'}` });
      } else if (result.ok && !result.passed) {
        setChecksumResult({
          status: 'fail',
          message: `Expected: ${result.expected ?? ''}\nActual: ${result.actual ?? ''}`,
        });
      } else {
        setChecksumResult({ status: 'error', message: result.error ?? 'Verification failed' });
      }
    } catch (err) {
      setChecksumResult({ status: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${String(bytes)} B`;
  };

  const formatSpeed = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${String(bytes)} B/s`;
  };

  const formatDuration = (seconds: number): string => {
    if (seconds <= 0 || !isFinite(seconds)) return '--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${String(h)}h ${String(m)}m ${String(s)}s`;
    if (m > 0) return `${String(m)}m ${String(s)}s`;
    return `${String(s)}s`;
  };

  const progress = task.sizeBytes > 0 ? (task.downloadedBytes / task.sizeBytes) * 100 : 0;

  const tabs: Array<{ id: InspectorTab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <Activity className="h-3.5 w-3.5" /> },
    { id: 'segments', label: 'Segments', icon: <Layers className="h-3.5 w-3.5" /> },
    { id: 'history', label: 'Events', icon: <Clock className="h-3.5 w-3.5" /> },
    { id: 'checksum', label: 'Checksum', icon: <Shield className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h3 className="truncate text-sm font-semibold">{task.name}</h3>
        </div>
        <button onClick={onClose} className="rounded p-1 hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="border-b border-border px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>{progress.toFixed(1)}%</span>
          <span>{formatBytes(task.downloadedBytes)} / {formatBytes(task.sizeBytes)}</span>
        </div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${String(Math.min(progress, 100))}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{formatSpeed(task.speedBytesPerSec)}</span>
          <span>{formatDuration(task.timeLeftSeconds)} left</span>
        </div>
      </div>

      <div className="flex border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); }}
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {activeTab === 'overview' && (
          <div className="flex flex-col gap-3">
            <SectionHeader
              title="Connection"
              icon={<Zap className="h-3.5 w-3.5" />}
              expanded={expandedSections.connection}
              onToggle={() => { toggleSection('connection'); }}
            />
            {expandedSections.connection && (
              <div className="grid grid-cols-2 gap-2 rounded border border-border/50 p-2 text-xs">
                <InfoRow label="Engine" value={task.engine ?? 'auto'} />
                <InfoRow label="Status" value={task.status} />
                <InfoRow label="Connections" value={String(task.connections)} />
                <InfoRow label="Resumable" value={task.resumable ? 'Yes' : 'No'} />
                <InfoRow label="URL" value={task.url} className="col-span-2 truncate" />
              </div>
            )}

            <SpeedGraph taskId={task.id} height={100} />

            <SectionHeader
              title="Segments"
              icon={<Layers className="h-3.5 w-3.5" />}
              expanded={expandedSections.segments}
              onToggle={() => { toggleSection('segments'); }}
            />
            {expandedSections.segments && task.segments.length > 0 && (
              <SegmentVisualization
                segments={task.segments.map((s) => ({
                  id: s.id,
                  progress: s.progress / 100,
                  downloadedBytes: s.downloadedBytes,
                  totalBytes: s.totalBytes,
                  active: s.active,
                  speed: s.speed,
                }))}
              />
            )}

            <SectionHeader
              title="Metadata"
              icon={<Link className="h-3.5 w-3.5" />}
              expanded={expandedSections.meta}
              onToggle={() => { toggleSection('meta'); }}
            />
            {expandedSections.meta && (
              <div className="grid grid-cols-2 gap-2 rounded border border-border/50 p-2 text-xs">
                <InfoRow label="File type" value={task.fileType} />
                <InfoRow label="Category" value={task.category} />
                <InfoRow label="Added" value={new Date(task.dateAdded).toLocaleString()} />
                <InfoRow label="Save path" value={task.savePath} className="col-span-2 truncate" />
                {task.referer && (
                  <InfoRow label="Referer" value={task.referer} className="col-span-2 truncate" />
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'segments' && (
          <div className="flex flex-col gap-3">
            {task.segments.length > 0 ? (
              <SegmentVisualization
                segments={task.segments.map((s) => ({
                  id: s.id,
                  progress: s.progress / 100,
                  downloadedBytes: s.downloadedBytes,
                  totalBytes: s.totalBytes,
                  active: s.active,
                  speed: s.speed,
                }))}
              />
            ) : (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No segment data available for this download.
              </p>
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="flex flex-col gap-1">
            {taskEvents.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">No events recorded yet.</p>
            )}
            {taskEvents.map((evt) => (
              <div
                key={evt.id}
                className="flex items-start gap-2 rounded border border-border/30 px-2 py-1.5 text-[11px]"
              >
                <span className="shrink-0 font-mono text-muted-foreground">
                  {new Date(evt.timestamp_millis).toLocaleTimeString()}
                </span>
                <span className="font-medium">{typeof evt.event.type === 'string' ? evt.event.type : 'event'}</span>
                <span className="truncate text-muted-foreground">
                  {JSON.stringify(evt.event).slice(0, 120)}
                </span>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'checksum' && (
          <div className="flex flex-col gap-3">
            <input
              type="text"
              value={verifyPath}
              onChange={(e) => { setVerifyPath(e.target.value); }}
              placeholder="File path to verify"
              className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
            />
            <div className="flex gap-2">
              <input
                type="text"
                value={expectedChecksum}
                onChange={(e) => { setExpectedChecksum(e.target.value); }}
                placeholder="Expected checksum (SHA-256, SHA-1, or MD5)"
                className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
              />
              <button
                onClick={() => { void handleVerifyChecksum(); }}
                disabled={!expectedChecksum.trim() || !verifyPath.trim() || checksumResult.status === 'verifying'}
                className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3 w-3 ${checksumResult.status === 'verifying' ? 'animate-spin' : ''}`}
                />
                Verify
              </button>
            </div>
            {checksumResult.status !== 'idle' && (
              <div
                className={`rounded border px-3 py-2 text-xs ${
                  checksumResult.status === 'pass'
                    ? 'border-green-500/30 bg-green-500/10 text-green-400'
                    : checksumResult.status === 'fail'
                      ? 'border-red-500/30 bg-red-500/10 text-red-400'
                      : checksumResult.status === 'verifying'
                        ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
                        : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400'
                }`}
              >
                <span className="font-medium">
                  {checksumResult.status === 'pass' && 'Checksum verified'}
                  {checksumResult.status === 'fail' && 'Checksum mismatch'}
                  {checksumResult.status === 'verifying' && 'Verifying...'}
                  {checksumResult.status === 'error' && 'Verification error'}
                </span>
                {checksumResult.message && (
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] opacity-80">
                    {checksumResult.message}
                  </pre>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Paste the expected checksum hash to verify file integrity. The algorithm is auto-detected
              from the hash length.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

function SectionHeader({
  title,
  icon,
  expanded,
  onToggle,
}: {
  title: string;
  icon: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-primary"
    >
      {icon}
      {title}
      {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
    </button>
  );
}

function InfoRow({
  label,
  value,
  className = '',
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-foreground">{value || '--'}</span>
    </div>
  );
}
