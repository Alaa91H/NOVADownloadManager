import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listProfiles, setActiveProfile } = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  setActiveProfile: vi.fn(),
}));

vi.mock('../../api/novaClient', () => ({
  novaClient: {
    listProfiles,
    setActiveProfile,
  },
}));

import { useEngineStore } from '../engineStore';

describe('engineStore profile operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEngineStore.setState({
      profiles: {
        profiles: [{ id: 'balanced', name: 'Balanced' }],
        activeProfile: 'balanced',
      },
      error: null,
    });
  });

  it('rejects an activation that the daemon declines without refreshing the active profile', async () => {
    setActiveProfile.mockResolvedValue({ ok: false });

    await expect(useEngineStore.getState().setActiveProfile('background')).rejects.toThrow(
      'The download engine rejected the selected profile',
    );

    expect(listProfiles).not.toHaveBeenCalled();
    expect(useEngineStore.getState().profiles?.activeProfile).toBe('balanced');
  });

  it('records an error rather than accepting an unsuccessful profile list response', async () => {
    listProfiles.mockResolvedValue({ ok: false, profiles: [{ id: 'background' }], activeProfile: 'background' });

    await useEngineStore.getState().refreshProfiles();

    expect(useEngineStore.getState().profiles?.activeProfile).toBe('balanced');
    expect(useEngineStore.getState().error).toBe('The download engine did not return a profile list');
  });
});
