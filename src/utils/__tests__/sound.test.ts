import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '../../types/desktop-ui.types';

type SoundEvent = 'complete' | 'error' | 'queueFinished' | 'notification' | 'start';
type PlayAppSound = (settings: AppSettings, event: SoundEvent) => void;

const baseSettings = (overrides: Partial<AppSettings['sounds']> = {}): AppSettings =>
  ({
    sounds: {
      enabled: true,
      volume: 60,
      onComplete: 'chime',
      onError: 'alert',
      onQueueFinished: 'chime',
      onStart: 'tap',
      onNotification: 'soft',
      customCompleteDataUrl: '',
      customErrorDataUrl: '',
      customQueueFinishedDataUrl: '',
      customNotificationDataUrl: '',
      ...overrides,
    },
  }) as unknown as AppSettings;

/** Fresh AudioContext constructor spy. */
function makeAudioContextSpy() {
  return vi.fn(function AudioContextSpy(this: Record<string, unknown>) {
    this.currentTime = 0;
    this.destination = {};
    this.createGain = () => ({
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    });
    this.createOscillator = () => ({
      type: '',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    });
    this.close = vi.fn().mockResolvedValue(undefined);
  });
}

/** Audio constructor that is both spy-able and `new`-able. */
function makeAudioStub(this: { volume: number; play: ReturnType<typeof vi.fn> }, playImpl: () => Promise<void>) {
  this.volume = 0;
  this.play = vi.fn(playImpl);
}
const AudioStub = vi.fn(function AudioStub(this: { volume: number; play: ReturnType<typeof vi.fn> }) {
  makeAudioStub.call(this, () => Promise.resolve());
});
const AudioRejectStub = vi.fn(function AudioRejectStub(this: { volume: number; play: ReturnType<typeof vi.fn> }) {
  makeAudioStub.call(this, () => Promise.reject(new Error('playback blocked')));
});

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let AudioContextSpy: ReturnType<typeof makeAudioContextSpy>;
let playAppSound: PlayAppSound;

beforeEach(async () => {
  vi.restoreAllMocks();
  // Module-level mocks accumulate call counts across tests; clear them so
  // assertions like `not.toHaveBeenCalled()` stay isolated.
  AudioStub.mockClear();
  AudioRejectStub.mockClear();
  // sound.ts caches a module-level AudioContext singleton; reset it so each
  // test exercises the fresh AudioContextSpy.
  vi.resetModules();
  AudioContextSpy = makeAudioContextSpy();
  vi.stubGlobal('AudioContext', AudioContextSpy);
  vi.stubGlobal('Audio', AudioStub);
  playAppSound = (await import('../sound')).playAppSound;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const expectAudioContext = (called: boolean) => {
  if (called) {
    expect(AudioContextSpy).toHaveBeenCalled();
  } else {
    expect(AudioContextSpy).not.toHaveBeenCalled();
  }
};

describe('playAppSound', () => {
  it('does nothing when sounds are disabled', () => {
    playAppSound(baseSettings({ enabled: false }), 'complete');
    expectAudioContext(false);
    expect(AudioStub).not.toHaveBeenCalled();
  });

  it('does nothing when the choice is off', () => {
    playAppSound(baseSettings({ onComplete: 'off' }), 'complete');
    expectAudioContext(false);
  });

  it('plays a tone for built-in choices', () => {
    playAppSound(baseSettings({ onComplete: 'chime' }), 'complete');
    expectAudioContext(true);
  });

  it('falls back to a soft tone when custom sound has no data URL', () => {
    playAppSound(baseSettings({ onComplete: 'custom', customCompleteDataUrl: '' }), 'complete');
    expectAudioContext(true);
    expect(AudioStub).not.toHaveBeenCalled();
  });

  it('plays a custom sound via the Audio element when a data URL exists', async () => {
    const dataUrl = 'data:audio/wav;base64,AAAA';
    playAppSound(baseSettings({ onComplete: 'custom', customCompleteDataUrl: dataUrl }), 'complete');
    expect(AudioStub).toHaveBeenCalledWith(dataUrl);
    await flushMicrotasks();
    expectAudioContext(false);
  });

  it('falls back to a tone when the custom Audio play rejects', async () => {
    vi.stubGlobal('Audio', AudioRejectStub);
    playAppSound(
      baseSettings({ onComplete: 'custom', customCompleteDataUrl: 'data:audio/wav;base64,AAAA' }),
      'complete',
    );
    expect(AudioRejectStub).toHaveBeenCalled();
    await flushMicrotasks();
    expectAudioContext(true);
  });

  it('rejects oversized custom sounds and plays a tone instead', () => {
    // 700_000 base64 chars decode to ~525_000 bytes, above the 512_000 limit.
    const huge = 'data:audio/wav;base64,' + 'A'.repeat(700_000);
    playAppSound(baseSettings({ onComplete: 'custom', customCompleteDataUrl: huge }), 'complete');
    expect(AudioStub).not.toHaveBeenCalled();
    expectAudioContext(true);
  });

  it('maps each event to a sound choice', () => {
    const settings = baseSettings({
      onError: 'alert',
      onStart: 'tap',
      onNotification: 'soft',
      onQueueFinished: 'chime',
    });
    playAppSound(settings, 'error');
    playAppSound(settings, 'start');
    playAppSound(settings, 'notification');
    playAppSound(settings, 'queueFinished');
    // sound.ts reuses a single AudioContext singleton across calls.
    expectAudioContext(true);
  });
});
