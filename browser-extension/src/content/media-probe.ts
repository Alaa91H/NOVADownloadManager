export type MediaProbeSnapshot = {
  url: string;
  kind: 'video' | 'audio' | 'image';
  width?: number;
  height?: number;
  durationSec?: number;
  poster?: string;
};
