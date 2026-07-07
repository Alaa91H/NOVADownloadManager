import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SchedulerPanel } from '../SchedulerPanel';

const {
  mockTasks,
  mockQueue,
  mockAddToast,
  mockUpdateQueue,
  mockResumeTask,
  mockPauseTask,
  mockAddQueue,
  mockDeleteQueue,
  mockRemoveTaskFromQueue,
  storeRef,
} = vi.hoisted(() => {
  const mockTasks = [
    {
      id: 'task-1',
      name: 'File1.zip',
      url: 'https://example.com/file1.zip',
      fileType: 'compressed' as const,
      status: 'queued' as const,
      sizeBytes: 1024 * 1024,
      downloadedBytes: 0,
      speedBytesPerSec: 0,
      timeLeftSeconds: 0,
      dateAdded: '2024-01-01T00:00:00Z',
      category: 'compressed' as const,
      queueId: 'main',
      connections: 1,
      resumable: true,
      savePath: '/downloads',
      description: '',
      segments: [],
    },
    {
      id: 'task-2',
      name: 'File2.mp4',
      url: 'https://example.com/file2.mp4',
      fileType: 'video' as const,
      status: 'downloading' as const,
      sizeBytes: 50 * 1024 * 1024,
      downloadedBytes: 10 * 1024 * 1024,
      speedBytesPerSec: 500 * 1024,
      timeLeftSeconds: 80,
      dateAdded: '2024-01-01T00:00:00Z',
      category: 'video' as const,
      queueId: 'main',
      connections: 4,
      resumable: true,
      savePath: '/downloads',
      description: '',
      segments: [],
    },
  ];

  const mockQueue = (overrides: Record<string, unknown> = {}) => ({
    id: 'main',
    name: 'Main Download Queue',
    active: true,
    scheduled: false,
    scheduleType: 'daily' as const,
    maxActive: 3,
    scheduleCompleted: false,
    startTime: '02:00',
    endTime: '08:00',
    days: [1, 2, 3, 4, 5],
    limitSpeed: false,
    speedLimitKbs: 0,
    oneTimeLimit: false,
    shutdownOnComplete: false,
    hangupOnComplete: false,
    retryCount: 5,
    downloadOrder: ['task-1', 'task-2'],
    ...overrides,
  });

  const mockAddToast = vi.fn();
  const mockUpdateQueue = vi.fn();
  const mockResumeTask = vi.fn();
  const mockPauseTask = vi.fn();
  const mockAddQueue = vi.fn();
  const mockDeleteQueue = vi.fn();
  const mockRemoveTaskFromQueue = vi.fn();

  const storeRef: { current: Record<string, unknown> } = { current: {} };

  return {
    mockTasks,
    mockQueue,
    mockAddToast,
    mockUpdateQueue,
    mockResumeTask,
    mockPauseTask,
    mockAddQueue,
    mockDeleteQueue,
    mockRemoveTaskFromQueue,
    storeRef,
  };
});

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

describe('SchedulerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      tasks: mockTasks,
      queues: [mockQueue()],
      updateQueue: mockUpdateQueue,
      resumeTask: mockResumeTask,
      pauseTask: mockPauseTask,
      addToast: mockAddToast,
      addQueue: mockAddQueue,
      deleteQueue: mockDeleteQueue,
      removeTaskFromQueue: mockRemoveTaskFromQueue,
      t: (k: string) => {
        const map: Record<string, string> = {
          sched_no_queues: 'No queues available',
          sched_select_queue: 'Select Queue:',
          sched_new_name: 'New queue name...',
          sched_add_btn: 'Add',
          sched_create_btn: 'Create new queue',
          sched_delete_list_tip: 'Delete this queue',
          sched_delete_confirm: 'Delete this queue?',
          action_delete: 'Delete',
          btn_cancel: 'Cancel',
          sched_start_queue: 'Start Queue',
          sched_stop_queue: 'Stop Queue',
          sched_background_note: 'Changes apply when queue runs in background',
          sched_num_files: '{count} file(s)',
          sched_toast_nothing_to_start: 'No tasks to start',
          sched_toast_started_title: 'Queue Started',
          sched_toast_started_desc: 'Started queue {name}',
          sched_toast_nothing_to_stop: 'No active tasks',
          sched_toast_stopped_title: 'Queue Stopped',
          sched_toast_stopped_desc: 'Stopped queue {name}',
          sched_toast_priority_title: 'Priority Changed',
          sched_toast_moved_up: 'Moved up',
          sched_toast_moved_down: 'Moved down',
          sched_toast_reordered: 'Task reordered',
          sched_tab_files: 'Files',
          sched_tab_schedule: 'Schedule',
          sched_tab_speed: 'Speed',
          sched_tab_actions: 'Actions',
          sched_tab_retries: 'Retries',
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
          sched_speed_limiter: 'Speed Limiter',
          sched_speed_limiter_desc: 'Limit download speed',
          sched_set_max_speed: 'Set Maximum Speed',
          sched_speed_limit_note: 'Note: Speed limit applies per download',
          sched_one_time_speed: 'One-Time Speed Limit',
          sched_one_time_speed_desc: 'Apply limit only for this session',
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
          sched_files_of_list: 'Files of',
          sched_schedule_active: 'Active {start} - {end}',
          sched_total_files: 'Total files:',
          sched_dnd_hint: 'Drag to reorder',
          sched_search_placeholder: 'Search tasks...',
          sched_clear_filter: 'Clear',
          sched_empty_title: 'No tasks in {name}',
          sched_empty_desc: 'Add tasks from the downloads page',
          sched_size_unknown: 'Unknown',
          sched_size_progress: '{size} · {percent}%',
          sched_prio_up: 'Move Up',
          sched_prio_down: 'Move Down',
          sched_menu_remove: 'Remove',
          sched_remove_confirm: 'Remove?',
          sched_yes: 'Yes',
          sched_no: 'No',
          sched_menu_move_top: 'Move to Top',
          sched_menu_move_bottom: 'Move to Bottom',
          nav_properties: 'Properties',
        };
        return map[k] || k;
      },
      openDialog: vi.fn(),
    };
  });

  it('renders empty state when no queues', () => {
    storeRef.current = {
      tasks: [],
      queues: [],
      t: (k: string) => {
        const map: Record<string, string> = { sched_no_queues: 'No queues available' };
        return map[k] || k;
      },
      updateQueue: vi.fn(),
      resumeTask: vi.fn(),
      pauseTask: vi.fn(),
      addToast: vi.fn(),
      addQueue: vi.fn(),
      deleteQueue: vi.fn(),
      removeTaskFromQueue: vi.fn(),
      openDialog: vi.fn(),
    };

    render(<SchedulerPanel />);
    expect(screen.getByText('No queues available')).toBeInTheDocument();
  });

  it('renders with main queue selected by default', () => {
    render(<SchedulerPanel />);
    expect(screen.getByText('Files (2)')).toBeInTheDocument();
    expect(screen.getByText('File1.zip')).toBeInTheDocument();
    expect(screen.getByText('File2.mp4')).toBeInTheDocument();
  });

  it('renders queue selector with main queue', () => {
    render(<SchedulerPanel />);
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    const queueOptions = screen.getAllByText('Main Download Queue');
    expect(queueOptions.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show delete button for main queue', () => {
    render(<SchedulerPanel />);
    expect(screen.queryByTitle('Delete this queue')).not.toBeInTheDocument();
  });

  it('shows start and stop queue buttons on files tab', () => {
    render(<SchedulerPanel />);
    expect(screen.getByText('Start Queue')).toBeInTheDocument();
    expect(screen.getByText('Stop Queue')).toBeInTheDocument();
  });

  it('calls resumeTask when start queue clicked', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Start Queue'));
    expect(mockResumeTask).toHaveBeenCalledWith('task-1');
    expect(mockAddToast).toHaveBeenCalled();
  });

  it('calls pauseTask when stop queue clicked', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Stop Queue'));
    expect(mockPauseTask).toHaveBeenCalledWith('task-2');
    expect(mockAddToast).toHaveBeenCalled();
  });

  it('switches to schedule tab when clicking schedule in sidebar', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Schedule'));
    expect(screen.getByText('Queue Name')).toBeInTheDocument();
    expect(screen.getByText('Schedule Type')).toBeInTheDocument();
  });

  it('switches to speed tab when clicking speed in sidebar', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Speed'));
    expect(screen.getByText('Speed Limiter')).toBeInTheDocument();
  });

  it('switches to actions tab when clicking actions in sidebar', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Actions'));
    expect(screen.getByText('On Completion Actions')).toBeInTheDocument();
  });

  it('switches to retries tab when clicking retries in sidebar', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Retries'));
    expect(screen.getByText('Retry Configuration')).toBeInTheDocument();
  });

  it('switches back to files tab', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Schedule'));
    fireEvent.click(screen.getByText('Files (2)'));
    expect(screen.getByText('File1.zip')).toBeInTheDocument();
  });

  it('hides start/stop buttons on non-files tabs', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Schedule'));
    expect(screen.queryByText('Start Queue')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop Queue')).not.toBeInTheDocument();
  });

  it('calls updateQueue via auto-save effect', () => {
    render(<SchedulerPanel />);
    expect(mockUpdateQueue).toHaveBeenCalled();
  });

  it('creates new queue when add button clicked', () => {
    render(<SchedulerPanel />);
    const input = screen.getByPlaceholderText('New queue name...');
    fireEvent.change(input, { target: { value: 'Night Queue' } });
    fireEvent.click(screen.getByText('Add'));
    expect(mockAddQueue).toHaveBeenCalledWith('Night Queue');
  });

  it('does not create empty queue', () => {
    render(<SchedulerPanel />);
    const addBtn = screen.getByText('Add');
    expect(addBtn.closest('button')).toBeDisabled();
  });

  it('shows background note on non-files tabs', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Schedule'));
    expect(screen.getByText(/Changes apply when queue runs in background/)).toBeInTheDocument();
  });

  it('shows file count on files tab', () => {
    render(<SchedulerPanel />);
    expect(screen.getByText(/file\(s\)/)).toBeInTheDocument();
  });

  it('calls updateQueue with scheduleCompleted reset when toggling schedule type', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Schedule'));
    fireEvent.click(screen.getByText('Once'));
    expect(mockUpdateQueue).toHaveBeenCalledWith('main', expect.objectContaining({ scheduleCompleted: false }), true);
  });

  it('calls updateQueue with scheduleCompleted reset when enabling schedule', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByText('Schedule'));
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
  });
});
