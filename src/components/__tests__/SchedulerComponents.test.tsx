import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SchedulerBasicTab } from '../SchedulerBasicTab';
import { SchedulerSidebar } from '../SchedulerSidebar';
import { SchedulerSpeedTab } from '../SchedulerSpeedTab';
import { SchedulerActionsTab } from '../SchedulerActionsTab';
import { SchedulerRetriesTab } from '../SchedulerRetriesTab';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        sched_list_name_edit: 'Queue Name',
        sched_schedule_type: 'Schedule Type',
        sched_schedule_type_once: 'Once',
        sched_schedule_type_daily: 'Daily',
        sched_schedule_type_custom: 'Custom',
        sched_schedule_type_once_desc: 'Run once at scheduled time',
        sched_schedule_type_daily_desc: 'Run daily at scheduled time',
        sched_schedule_type_custom_desc: 'Run on selected days',
        sched_enable_timer: 'Enable Timer',
        sched_enable_timer_desc: 'Activate scheduling for this queue',
        sched_start_time: 'Start Time',
        sched_stop_time: 'End Time',
        sched_days_of_week: 'Days of Week',
        sched_days_daily_summary: 'All days selected (daily)',
        sched_days_once_summary: 'Selected: {days}',
        sched_max_concurrent: 'Max Concurrent Downloads',
        sched_concurrent_1: '1 (Sequential)',
        sched_concurrent_n: '{count} Tasks',
        sched_concurrent_10: '10 (Max Parallel)',
        weekday_sunday: 'Sun',
        weekday_monday: 'Mon',
        weekday_tuesday: 'Tue',
        weekday_wednesday: 'Wed',
        weekday_thursday: 'Thu',
        weekday_friday: 'Fri',
        weekday_saturday: 'Sat',

        sched_tab_files: 'Files',
        sched_tab_schedule: 'Schedule',
        sched_tab_speed: 'Speed',
        sched_tab_actions: 'Actions',
        sched_tab_retries: 'Retries',

        sched_speed_limiter: 'Speed Limiter',
        sched_speed_limiter_desc: 'Limit download speed',
        sched_set_max_speed: 'Set Maximum Speed',
        sched_speed_limit_note: 'Note: Speed limit applies per download',
        sched_one_time_speed: 'One-Time Speed Limit',
        sched_one_time_speed_desc: 'Apply limit only for this session',

        sched_actions_on_complete: 'On Completion Actions',
        sched_action_shutdown: 'Shutdown',
        sched_action_shutdown_desc: 'Shutdown system when queue completes',
        sched_action_sleep: 'Sleep/Hibernate',
        sched_action_sleep_desc: 'Put system to sleep',
        sched_action_exit: 'Exit App',
        sched_action_exit_desc: 'Close downloader when done',
        sched_action_chime: 'Play Chime',
        sched_action_chime_desc: 'Play notification sound',
        sched_action_webhook: 'Webhook',
        sched_action_webhook_desc: 'Send webhook on completion',

        sched_retries_title: 'Retry Configuration',
        sched_retry_max: 'Maximum Retries',
        sched_retry_wait: 'Wait Between Retries',
        sched_retry_attempt_one: '1 Attempt',
        sched_retry_attempt_n: '{count} Attempts',
        sched_retry_attempt_default: '5 (Default)',
        sched_retry_attempt_weak: '10 (Weak network)',
        sched_retry_attempt_infinite: '9999 (Infinite)',
        sched_retry_seconds_between: 'seconds between retries',
        sched_smart_link_verification: 'Smart Link Verification',
        sched_smart_link_verification_desc: 'Automatically verify links before retry',
      };
      return map[k] || k;
    },
  }),
}));

describe('SchedulerBasicTab', () => {
  const defaultProps = {
    name: 'Test Queue',
    onNameChange: vi.fn(),
    smartScheduleType: 'daily' as const,
    onScheduleTypeChange: vi.fn(),
    isScheduled: true,
    onScheduledChange: vi.fn(),
    startTime: '02:00',
    onStartTimeChange: vi.fn(),
    endTime: '08:00',
    onEndTimeChange: vi.fn(),
    days: [1, 3, 5],
    onToggleDay: vi.fn(),
    maxActive: 3,
    onMaxActiveChange: vi.fn(),
  };

  it('renders queue name input', () => {
    render(<SchedulerBasicTab {...defaultProps} />);
    const input = screen.getByDisplayValue('Test Queue');
    expect(input).toBeInTheDocument();
  });

  it('renders schedule type buttons', () => {
    render(<SchedulerBasicTab {...defaultProps} />);
    expect(screen.getByText('Once')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('highlights active schedule type', () => {
    render(<SchedulerBasicTab {...defaultProps} smartScheduleType="daily" />);
    const dailyBtn = screen.getByText('Daily');
    expect(dailyBtn.className).toContain('bg-[var(--accent-primary)]');
  });

  it('calls onScheduleTypeChange when clicking schedule type', () => {
    const onScheduleTypeChange = vi.fn();
    render(<SchedulerBasicTab {...defaultProps} onScheduleTypeChange={onScheduleTypeChange} />);
    fireEvent.click(screen.getByText('Once'));
    expect(onScheduleTypeChange).toHaveBeenCalledWith('once');
  });

  it('renders enable timer checkbox', () => {
    render(<SchedulerBasicTab {...defaultProps} />);
    expect(screen.getByText('Enable Timer')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('calls onScheduledChange when toggling timer', () => {
    const onScheduledChange = vi.fn();
    render(<SchedulerBasicTab {...defaultProps} onScheduledChange={onScheduledChange} />);
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(onScheduledChange).toHaveBeenCalledWith(false);
  });

  it('shows time pickers when scheduled is true', () => {
    render(<SchedulerBasicTab {...defaultProps} isScheduled />);
    expect(screen.getByText('Start Time')).toBeInTheDocument();
    expect(screen.getByText('End Time')).toBeInTheDocument();
  });

  it('hides time pickers when scheduled is false', () => {
    render(<SchedulerBasicTab {...defaultProps} isScheduled={false} />);
    expect(screen.queryByText('Start Time')).not.toBeInTheDocument();
    expect(screen.queryByText('End Time')).not.toBeInTheDocument();
  });

  it('shows day selector for custom schedule type', () => {
    render(<SchedulerBasicTab {...defaultProps} smartScheduleType="custom" />);
    expect(screen.getByText('Sun')).toBeInTheDocument();
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Tue')).toBeInTheDocument();
  });

  it('shows summary for daily schedule type', () => {
    render(<SchedulerBasicTab {...defaultProps} smartScheduleType="daily" />);
    expect(screen.getByText('All days selected (daily)')).toBeInTheDocument();
  });

  it('calls onToggleDay when clicking a day in custom mode', () => {
    const onToggleDay = vi.fn();
    render(<SchedulerBasicTab {...defaultProps} smartScheduleType="custom" onToggleDay={onToggleDay} />);
    fireEvent.click(screen.getByText('Mon'));
    expect(onToggleDay).toHaveBeenCalledWith(1);
  });

  it('renders max concurrent downloads selector', () => {
    render(<SchedulerBasicTab {...defaultProps} isScheduled={false} />);
    expect(screen.getByText('Max Concurrent Downloads')).toBeInTheDocument();
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
  });

  it('calls onMaxActiveChange when selecting concurrent value', () => {
    const onMaxActiveChange = vi.fn();
    render(<SchedulerBasicTab {...defaultProps} isScheduled={false} onMaxActiveChange={onMaxActiveChange} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: '6' } });
    expect(onMaxActiveChange).toHaveBeenCalledWith(6);
  });

  it('calls onNameChange when editing queue name', () => {
    const onNameChange = vi.fn();
    render(<SchedulerBasicTab {...defaultProps} onNameChange={onNameChange} />);
    const input = screen.getByDisplayValue('Test Queue');
    fireEvent.change(input, { target: { value: 'New Name' } });
    expect(onNameChange).toHaveBeenCalledWith('New Name');
  });

  it('renders custom schedule type description', () => {
    render(<SchedulerBasicTab {...defaultProps} smartScheduleType="custom" />);
    expect(screen.getByText('Run on selected days')).toBeInTheDocument();
  });
});

describe('SchedulerSidebar', () => {
  it('renders all tab buttons', () => {
    const onChange = vi.fn();
    render(<SchedulerSidebar activeTab="basic" onChange={onChange} fileCount={5} />);
    expect(screen.getByText('Files (5)')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText('Speed')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('Retries')).toBeInTheDocument();
  });

  it('highlights active tab', () => {
    const onChange = vi.fn();
    render(<SchedulerSidebar activeTab="basic" onChange={onChange} fileCount={0} />);
    const scheduleBtn = screen.getByText('Schedule').closest('button')!;
    expect(scheduleBtn.className).toContain('text-[var(--accent-primary)]');
  });

  it('does not highlight inactive tabs', () => {
    const onChange = vi.fn();
    render(<SchedulerSidebar activeTab="basic" onChange={onChange} fileCount={0} />);
    const filesBtn = screen.getByText('Files (0)');
    expect(filesBtn.className).not.toContain('text-[var(--accent-primary)]');
  });

  it('calls onChange when tab clicked', () => {
    const onChange = vi.fn();
    render(<SchedulerSidebar activeTab="basic" onChange={onChange} fileCount={0} />);
    fireEvent.click(screen.getByText('Speed'));
    expect(onChange).toHaveBeenCalledWith('speed');
  });

  it('displays file count in files tab', () => {
    const onChange = vi.fn();
    render(<SchedulerSidebar activeTab="files" onChange={onChange} fileCount={3} />);
    expect(screen.getByText('Files (3)')).toBeInTheDocument();
  });

  it('shows zero count when no files', () => {
    const onChange = vi.fn();
    render(<SchedulerSidebar activeTab="files" onChange={onChange} fileCount={0} />);
    expect(screen.getByText('Files (0)')).toBeInTheDocument();
  });

  it('calls onChange with retries tab', () => {
    const onChange = vi.fn();
    render(<SchedulerSidebar activeTab="files" onChange={onChange} fileCount={0} />);
    fireEvent.click(screen.getByText('Retries'));
    expect(onChange).toHaveBeenCalledWith('retries');
  });

  it('renders correct number of tab buttons', () => {
    const onChange = vi.fn();
    const { container } = render(<SchedulerSidebar activeTab="files" onChange={onChange} fileCount={0} />);
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(5);
  });
});

describe('SchedulerSpeedTab', () => {
  const defaultProps = {
    limitSpeed: false,
    onLimitSpeedChange: vi.fn(),
    speedLimitKbs: 2048,
    onSpeedLimitChange: vi.fn(),
    oneTimeLimit: false,
    onOneTimeLimitChange: vi.fn(),
  };

  it('renders speed limiter checkbox', () => {
    render(<SchedulerSpeedTab {...defaultProps} />);
    expect(screen.getByText('Speed Limiter')).toBeInTheDocument();
  });

  it('shows speed input when limitSpeed is true', () => {
    render(<SchedulerSpeedTab {...defaultProps} limitSpeed />);
    expect(screen.getByText('Set Maximum Speed')).toBeInTheDocument();
  });

  it('hides speed input when limitSpeed is false', () => {
    render(<SchedulerSpeedTab {...defaultProps} limitSpeed={false} />);
    expect(screen.queryByText('Set Maximum Speed')).not.toBeInTheDocument();
  });

  it('calls onLimitSpeedChange when toggling speed limiter', () => {
    const onLimitSpeedChange = vi.fn();
    render(<SchedulerSpeedTab {...defaultProps} onLimitSpeedChange={onLimitSpeedChange} />);
    const checkbox = screen.getAllByRole('checkbox')[0];
    fireEvent.click(checkbox);
    expect(onLimitSpeedChange).toHaveBeenCalledWith(true);
  });

  it('renders one-time speed limit checkbox', () => {
    render(<SchedulerSpeedTab {...defaultProps} />);
    expect(screen.getByText('One-Time Speed Limit')).toBeInTheDocument();
  });

  it('calls onOneTimeLimitChange when toggling one-time limit', () => {
    const onOneTimeLimitChange = vi.fn();
    render(<SchedulerSpeedTab {...defaultProps} onOneTimeLimitChange={onOneTimeLimitChange} />);
    const checkbox = screen.getAllByRole('checkbox')[1];
    fireEvent.click(checkbox);
    expect(onOneTimeLimitChange).toHaveBeenCalledWith(true);
  });

  it('renders speed limit note when limitSpeed is enabled', () => {
    render(<SchedulerSpeedTab {...defaultProps} limitSpeed />);
    expect(screen.getByText('Note: Speed limit applies per download')).toBeInTheDocument();
  });

  it('renders MB unit for value 2048', () => {
    render(<SchedulerSpeedTab {...defaultProps} limitSpeed speedLimitKbs={2048} />);
    expect(screen.getByText('MB')).toBeInTheDocument();
  });

  it('renders KB unit for value 500', () => {
    render(<SchedulerSpeedTab {...defaultProps} limitSpeed speedLimitKbs={500} />);
    expect(screen.getByText('KB')).toBeInTheDocument();
  });
});

describe('SchedulerActionsTab', () => {
  const defaultProps = {
    shutdownOnComplete: false,
    onShutdownChange: vi.fn(),
    hangupOnComplete: false,
    onHangupChange: vi.fn(),
    exitOnComplete: false,
    onExitChange: vi.fn(),
    playChime: true,
    onChimeChange: vi.fn(),
    enableWebhook: false,
    onWebhookEnableChange: vi.fn(),
    webhookUrl: 'https://example.com/webhook',
    onWebhookUrlChange: vi.fn(),
  };

  it('renders section title', () => {
    render(<SchedulerActionsTab {...defaultProps} />);
    expect(screen.getByText('On Completion Actions')).toBeInTheDocument();
  });

  it('renders all action checkboxes', () => {
    render(<SchedulerActionsTab {...defaultProps} />);
    expect(screen.getByText('Shutdown')).toBeInTheDocument();
    expect(screen.getByText('Sleep/Hibernate')).toBeInTheDocument();
    expect(screen.getByText('Exit App')).toBeInTheDocument();
    expect(screen.getByText('Play Chime')).toBeInTheDocument();
  });

  it('renders webhook section', () => {
    render(<SchedulerActionsTab {...defaultProps} />);
    expect(screen.getByText('Webhook')).toBeInTheDocument();
  });

  it('shows webhook URL input when enabled', () => {
    render(<SchedulerActionsTab {...defaultProps} enableWebhook />);
    const input = screen.getByDisplayValue('https://example.com/webhook');
    expect(input).toBeInTheDocument();
  });

  it('hides webhook URL input when disabled', () => {
    render(<SchedulerActionsTab {...defaultProps} enableWebhook={false} />);
    expect(screen.queryByDisplayValue('https://example.com/webhook')).not.toBeInTheDocument();
  });

  it('calls onShutdownChange when toggling shutdown', () => {
    const onShutdownChange = vi.fn();
    render(<SchedulerActionsTab {...defaultProps} onShutdownChange={onShutdownChange} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(onShutdownChange).toHaveBeenCalledWith(true);
  });

  it('calls onHangupChange when toggling sleep', () => {
    const onHangupChange = vi.fn();
    render(<SchedulerActionsTab {...defaultProps} onHangupChange={onHangupChange} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    expect(onHangupChange).toHaveBeenCalledWith(true);
  });

  it('calls onExitChange when toggling exit', () => {
    const onExitChange = vi.fn();
    render(<SchedulerActionsTab {...defaultProps} onExitChange={onExitChange} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[2]);
    expect(onExitChange).toHaveBeenCalledWith(true);
  });

  it('calls onChimeChange when toggling chime', () => {
    const onChimeChange = vi.fn();
    render(<SchedulerActionsTab {...defaultProps} onChimeChange={onChimeChange} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[3]);
    expect(onChimeChange).toHaveBeenCalledWith(false);
  });

  it('calls onWebhookEnableChange when toggling webhook', () => {
    const onWebhookEnableChange = vi.fn();
    render(<SchedulerActionsTab {...defaultProps} onWebhookEnableChange={onWebhookEnableChange} />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[4]);
    expect(onWebhookEnableChange).toHaveBeenCalledWith(true);
  });

  it('calls onWebhookUrlChange when editing URL', () => {
    const onWebhookUrlChange = vi.fn();
    render(<SchedulerActionsTab {...defaultProps} enableWebhook onWebhookUrlChange={onWebhookUrlChange} />);
    const input = screen.getByDisplayValue('https://example.com/webhook');
    fireEvent.change(input, { target: { value: 'https://new-url.com/hook' } });
    expect(onWebhookUrlChange).toHaveBeenCalledWith('https://new-url.com/hook');
  });

  it('shows chime as checked by default', () => {
    render(<SchedulerActionsTab {...defaultProps} playChime />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[3]).toBeChecked();
  });
});

describe('SchedulerRetriesTab', () => {
  const defaultProps = {
    retryCount: 5,
    onRetryCountChange: vi.fn(),
    retryDelay: 10,
    onRetryDelayChange: vi.fn(),
  };

  it('renders section title', () => {
    render(<SchedulerRetriesTab {...defaultProps} />);
    expect(screen.getByText('Retry Configuration')).toBeInTheDocument();
  });

  it('renders retry count selector', () => {
    render(<SchedulerRetriesTab {...defaultProps} />);
    expect(screen.getByText('Maximum Retries')).toBeInTheDocument();
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
  });

  it('renders retry delay input', () => {
    render(<SchedulerRetriesTab {...defaultProps} />);
    expect(screen.getByText('Wait Between Retries')).toBeInTheDocument();
    const input = screen.getByDisplayValue('10');
    expect(input).toBeInTheDocument();
  });

  it('renders seconds label', () => {
    render(<SchedulerRetriesTab {...defaultProps} />);
    expect(screen.getByText('seconds between retries')).toBeInTheDocument();
  });

  it('calls onRetryCountChange when selecting retry count', () => {
    const onRetryCountChange = vi.fn();
    render(<SchedulerRetriesTab {...defaultProps} onRetryCountChange={onRetryCountChange} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: '10' } });
    expect(onRetryCountChange).toHaveBeenCalledWith(10);
  });

  it('calls onRetryDelayChange when editing delay', () => {
    const onRetryDelayChange = vi.fn();
    render(<SchedulerRetriesTab {...defaultProps} onRetryDelayChange={onRetryDelayChange} />);
    const input = screen.getByDisplayValue('10');
    fireEvent.change(input, { target: { value: '30' } });
    expect(onRetryDelayChange).toHaveBeenCalledWith(30);
  });

  it('renders smart link verification info', () => {
    render(<SchedulerRetriesTab {...defaultProps} />);
    expect(screen.getByText('Smart Link Verification')).toBeInTheDocument();
    expect(screen.getByText('Automatically verify links before retry')).toBeInTheDocument();
  });

  it('renders all retry count options', () => {
    render(<SchedulerRetriesTab {...defaultProps} />);
    const select = screen.getByRole('combobox');
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(7);
  });

  it('shows correct default retry count value', () => {
    render(<SchedulerRetriesTab {...defaultProps} retryCount={5} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('5');
  });
});
