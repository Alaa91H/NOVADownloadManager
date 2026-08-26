import React, { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../store/selectors', () => ({
  useI18n: () => (key: string) => key,
}));

import { SchedulerSpeedTab } from '../SchedulerSpeedTab';

const profilePayload = [
  { id: 'balanced', name: 'Balanced', description: 'Balanced speed and resource usage' },
  { id: 'background', name: 'Background', description: 'Minimal resource usage' },
];

function ProfileHarness({ onChange }: { onChange: (profileId: string) => Promise<void> }) {
  const [activeProfile, setActiveProfile] = useState('balanced');
  return (
    <SchedulerSpeedTab
      limitSpeed={false}
      onLimitSpeedChange={() => {}}
      speedLimitKbs={2048}
      onSpeedLimitChange={() => {}}
      oneTimeLimit={false}
      onOneTimeLimitChange={() => {}}
      downloadProfiles={profilePayload}
      activeDownloadProfile={activeProfile}
      onActiveDownloadProfileChange={async (profileId) => {
        await onChange(profileId);
        setActiveProfile(profileId);
      }}
    />
  );
}

function SpeedLimitHarness() {
  const [limitSpeed, setLimitSpeed] = useState(false);
  return (
    <SchedulerSpeedTab
      limitSpeed={limitSpeed}
      onLimitSpeedChange={setLimitSpeed}
      speedLimitKbs={2048}
      onSpeedLimitChange={vi.fn()}
      oneTimeLimit={false}
      onOneTimeLimitChange={vi.fn()}
      downloadProfiles={profilePayload}
      activeDownloadProfile="balanced"
      onActiveDownloadProfileChange={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

describe('SchedulerSpeedTab download profile control', () => {
  it('renders the active daemon profile and updates only after a successful engine response', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<ProfileHarness onChange={onChange} />);

    const select = screen.getByTestId('download-profile-select');
    expect(select).toHaveValue('balanced');
    expect(screen.getByTestId('download-profile-control')).toHaveTextContent('Balanced speed and resource usage');

    await user.selectOptions(select, 'background');
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('background');
    });
    await waitFor(() => {
      expect(select).toHaveValue('background');
    });
    expect(screen.getByTestId('download-profile-control')).toHaveTextContent('Minimal resource usage');
  });

  it('keeps the server-authoritative active profile when the engine rejects a change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockRejectedValue(new Error('engine rejected profile'));
    render(<ProfileHarness onChange={onChange} />);

    const select = screen.getByTestId('download-profile-select');
    await user.selectOptions(select, 'background');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('background');
    });
    expect(select).toHaveValue('balanced');
    expect(screen.getByRole('alert')).toHaveTextContent('settings_proxy_failed');
  });

  it('keeps the existing list speed limiter available independently of a profile', async () => {
    const user = userEvent.setup();
    render(<SpeedLimitHarness />);

    await user.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('sched_set_max_speed')).toBeInTheDocument();
  });
});
