import { useState, useEffect, useRef, useCallback } from 'react';
import { engineApi } from '../../api/engineClient';

interface SpeedDataPoint {
  time: number;
  speed: number;
}

interface SpeedGraphProps {
  taskId?: string;
  maxPoints?: number;
  height?: number;
  className?: string;
}

export function SpeedGraph({ taskId, maxPoints = 60, height = 120, className = '' }: SpeedGraphProps) {
  const [dataPoints, setDataPoints] = useState<SpeedDataPoint[]>([]);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [peakSpeed, setPeakSpeed] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fetchSpeed = useCallback(async () => {
    try {
      const data = taskId
        ? await engineApi.getTaskEvents(taskId, 1)
        : await engineApi.getEvents(1);
      if (!data.ok || data.events.length === 0) return;
      const latest = data.events[data.events.length - 1];
      const speed = typeof latest.event.speed_bytes_per_sec === 'number' ? latest.event.speed_bytes_per_sec : 0;
      setCurrentSpeed(speed);
      setPeakSpeed((prev) => Math.max(prev, speed));
      setDataPoints((prev) => {
        const next = [...prev, { time: Date.now(), speed }];
        return next.length > maxPoints ? next.slice(-maxPoints) : next;
      });
    } catch {
      // silent
    }
  }, [taskId, maxPoints]);

  useEffect(() => {
    const timer = window.setInterval(() => { void fetchSpeed(); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [fetchSpeed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padding = { top: 4, right: 4, bottom: 4, left: 4 };

    ctx.clearRect(0, 0, w, h);

    const maxVal = Math.max(peakSpeed, 1024);
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    if (dataPoints.length < 2) return;

    const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.4)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.02)');

    ctx.beginPath();
    ctx.moveTo(padding.left, h - padding.bottom);

    for (let i = 0; i < dataPoints.length; i++) {
      const x = padding.left + (i / (dataPoints.length - 1)) * chartW;
      const y = padding.top + chartH - (dataPoints[i].speed / maxVal) * chartH;
      ctx.lineTo(x, y);
    }

    ctx.lineTo(padding.left + chartW, h - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < dataPoints.length; i++) {
      const x = padding.left + (i / (dataPoints.length - 1)) * chartW;
      const y = padding.top + chartH - (dataPoints[i].speed / maxVal) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [dataPoints, peakSpeed]);

  const formatSpeed = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${String(bytes)} B/s`;
  };

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatSpeed(currentSpeed)}</span>
        <span className="text-muted-foreground/60">Peak: {formatSpeed(peakSpeed)}</span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded border border-border/50 bg-background/50"
        style={{ height }}
      />
    </div>
  );
}
