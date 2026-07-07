import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SchedulerPage } from '../SchedulerPage';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        sched_title: 'Scheduler',
        sched_desc: 'Manage your download queues and schedules',
      };
      return map[k] || k;
    },
  }),
}));

vi.mock('../../components/SchedulerPanel', () => ({
  SchedulerPanel: () => <div data-testid="scheduler-panel">Scheduler Panel</div>,
}));

describe('SchedulerPage', () => {
  it('renders the scheduler title', () => {
    render(<SchedulerPage />);
    expect(screen.getByText('Scheduler')).toBeInTheDocument();
  });

  it('renders the scheduler description', () => {
    render(<SchedulerPage />);
    expect(screen.getByText('Manage your download queues and schedules')).toBeInTheDocument();
  });

  it('renders the SchedulerPanel component', () => {
    render(<SchedulerPage />);
    expect(screen.getByTestId('scheduler-panel')).toBeInTheDocument();
  });

  it('renders the clock icon', () => {
    const { container } = render(<SchedulerPage />);
    expect(container.querySelector('.lucide-clock')).toBeInTheDocument();
  });
});
