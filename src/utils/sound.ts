import type { AppSettings } from '../types/desktop-ui.types';

type SoundEvent = 'complete' | 'error' | 'queueFinished' | 'notification' | 'start';

type SoundChoice = string;

type BrowserAudioWindow = {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

let audioContext: AudioContext | null = null;

const getAudioContext = () => {
  if (typeof window === 'undefined') return null;
  const audioWindow = window as unknown as BrowserAudioWindow;
  const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!audioContext) {
    audioContext = new AudioContextCtor();
  }
  return audioContext;
};

const clampVolume = (volume: number) => Math.max(0, Math.min(1, volume / 100));

const playTone = (choice: SoundChoice, volume: number) => {
  const context = getAudioContext();
  if (!context) return;

  const now = context.currentTime;
  const gain = context.createGain();
  const oscillator = context.createOscillator();
  const isAlert = choice === 'alert';
  const isChime = choice === 'chime';

  oscillator.type = isAlert ? 'square' : 'sine';
  oscillator.frequency.setValueAtTime(isAlert ? 220 : isChime ? 660 : 440, now);
  if (isChime) {
    oscillator.frequency.exponentialRampToValueAtTime(880, now + 0.08);
  }
  if (choice === 'tap') {
    oscillator.frequency.exponentialRampToValueAtTime(520, now + 0.04);
  }

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, clampVolume(volume) * 0.16), now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + (isAlert ? 0.28 : 0.18));

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + (isAlert ? 0.3 : 0.2));
};

const soundChoiceForEvent = (settings: AppSettings, event: SoundEvent): SoundChoice => {
  switch (event) {
    case 'complete':
      return settings.sounds.onComplete || 'chime';
    case 'error':
      return settings.sounds.onError || 'alert';
    case 'queueFinished':
      return settings.sounds.onQueueFinished || 'chime';
    case 'start':
      return settings.sounds.onStart || 'tap';
    case 'notification':
    default:
      return settings.sounds.onNotification || 'soft';
  }
};

const customSoundForEvent = (settings: AppSettings, event: SoundEvent) => {
  switch (event) {
    case 'complete':
      return settings.sounds.customCompleteDataUrl;
    case 'error':
      return settings.sounds.customErrorDataUrl;
    case 'queueFinished':
      return settings.sounds.customQueueFinishedDataUrl;
    case 'notification':
    case 'start':
    default:
      return settings.sounds.customNotificationDataUrl;
  }
};

export const playAppSound = (settings: AppSettings, event: SoundEvent) => {
  if (!settings.sounds.enabled) return;
  const choice = soundChoiceForEvent(settings, event);
  if (choice === 'off') return;
  const volume = settings.sounds.volume || 60;

  if (choice === 'custom') {
    const dataUrl = customSoundForEvent(settings, event);
    if (dataUrl) {
      const audio = new Audio(dataUrl);
      audio.volume = clampVolume(volume);
      void audio.play().catch(() => {
        playTone('soft', volume);
      });
      return;
    }
  }

  playTone(choice, volume);
};
