import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initialSettings } from '../../initialData';
import type { AppSettings } from '../../types/desktop-ui.types';

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...initialSettings,
    ...overrides,
    sounds: {
      ...initialSettings.sounds,
      ...(overrides.sounds || {}),
    },
  };
}

describe('playAppSound', () => {
  let playAppSoundFn: typeof import('../sound')['playAppSound'];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('../sound');
    playAppSoundFn = mod.playAppSound;
  });

  afterEach(() => {
    vi.useRealTimers();
    (window as any).AudioContext = undefined;
    (window as any).webkitAudioContext = undefined;
    (globalThis as any).Audio = undefined;
  });

  it('does nothing when sounds are disabled', () => {
    const settings = createSettings({ sounds: { ...initialSettings.sounds, enabled: false } });
    expect(() => playAppSoundFn(settings, 'complete')).not.toThrow();
  });

  it('does nothing when sound choice is "off"', () => {
    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onComplete: 'off' },
    });
    expect(() => playAppSoundFn(settings, 'complete')).not.toThrow();
  });

  it('plays a tone for "chime" choice', () => {
    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain);

    (window as any).AudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onComplete: 'chime', volume: 60 },
    });
    playAppSoundFn(settings, 'complete');

    expect(mockContext.createOscillator).toHaveBeenCalled();
    expect(mockOscillator.type).toBe('sine');
    expect(mockOscillator.start).toHaveBeenCalledWith(100);
    expect(mockOscillator.stop).toHaveBeenCalledWith(100.2);
  });

  it('plays a tone for "alert" choice (square wave)', () => {
    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain, 200);

    (window as any).AudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onError: 'alert', volume: 80 },
    });
    playAppSoundFn(settings, 'error');

    expect(mockOscillator.type).toBe('square');
    expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(220, 200);
  });

  it('plays a tone for "tap" choice', () => {
    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain, 50);

    (window as any).AudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onStart: 'tap', volume: 50 },
    });
    playAppSoundFn(settings, 'start');

    expect(mockOscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(520, 50.04);
  });

  it('plays a "soft" tone for notification event by default', () => {
    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain, 10);

    (window as any).AudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onNotification: 'soft' },
    });
    playAppSoundFn(settings, 'notification');

    expect(mockOscillator.type).toBe('sine');
    expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(440, 10);
  });

  it('handles queueFinished event', () => {
    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain, 0);

    (window as any).AudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onQueueFinished: 'chime' },
    });
    expect(() => playAppSoundFn(settings, 'queueFinished')).not.toThrow();
    expect(mockContext.createOscillator).toHaveBeenCalled();
  });

  it('does not throw when AudioContext is unavailable', () => {
    (window as any).AudioContext = undefined;
    (window as any).webkitAudioContext = undefined;

    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onComplete: 'chime' },
    });
    expect(() => playAppSoundFn(settings, 'complete')).not.toThrow();
  });

  it('plays custom sound via Audio element', () => {
    const mockPlay = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).Audio = vi.fn().mockImplementation(function (this: any, _url: string) {
      this.play = mockPlay;
      this.volume = 1;
    });

    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain, 0);

    (window as any).AudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: {
        ...initialSettings.sounds,
        enabled: true,
        onComplete: 'custom',
        customCompleteDataUrl: 'data:audio/wav;base64,test',
        volume: 70,
      },
    });
    playAppSoundFn(settings, 'complete');

    expect(globalThis.Audio).toHaveBeenCalledWith('data:audio/wav;base64,test');
    expect(mockPlay).toHaveBeenCalled();
  });

  it('falls back to "soft" tone when custom Audio play fails', () => {
    const mockPlay = vi.fn().mockRejectedValue(new Error('playback denied'));
    (globalThis as any).Audio = vi.fn().mockImplementation(function (this: any, _url: string) {
      this.play = mockPlay;
      this.volume = 1;
    });

    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain, 0);

    (window as any).AudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: {
        ...initialSettings.sounds,
        enabled: true,
        onComplete: 'custom',
        customCompleteDataUrl: 'data:audio/wav;base64,test',
        volume: 70,
      },
    });
    playAppSoundFn(settings, 'complete');

    expect(mockPlay).toHaveBeenCalled();
    expect(mockOscillator).toBeDefined();
  });

  it('uses webkitAudioContext as fallback', () => {
    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain, 0);

    (window as any).AudioContext = undefined;
    (window as any).webkitAudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onComplete: 'chime' },
    });
    playAppSoundFn(settings, 'complete');

    expect(mockContext.createOscillator).toHaveBeenCalled();
  });

  it('clamps volume to valid range', () => {
    const mockOscillator = createMockOscillator();
    const mockGain = createMockGain();
    const mockContext = createMockContext(mockOscillator, mockGain, 0);

    (window as any).AudioContext = vi.fn().mockImplementation(function () {
      return mockContext;
    });

    const settings = createSettings({
      sounds: { ...initialSettings.sounds, enabled: true, onComplete: 'chime', volume: 999 },
    });
    playAppSoundFn(settings, 'complete');

    expect(mockGain.gain.exponentialRampToValueAtTime).toHaveBeenCalled();
  });
});

function createMockOscillator() {
  return {
    type: '',
    frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockGain() {
  return {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
}

function createMockContext(
  mockOscillator: ReturnType<typeof createMockOscillator>,
  mockGain: ReturnType<typeof createMockGain>,
  currentTime = 100,
) {
  return {
    currentTime,
    createGain: vi.fn(() => mockGain),
    createOscillator: vi.fn(() => mockOscillator),
    destination: 'dest',
  };
}
