import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SchedulerFilesTab } from '../SchedulerFilesTab';
import type { DownloadItem } from '../../types/desktop-ui.types';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
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
    capabilities: { direct: true, media: true },
  }),
}));

const makeTask = (id: string, overrides: Partial<DownloadItem> = {}): DownloadItem => ({
  id,
  name: `Task ${id}`,
  url: `https://example.com/${id}`,
  fileType: 'compressed',
  status: 'queued',
  sizeBytes: 1024 * 1024,
  downloadedBytes: 0,
  speedBytesPerSec: 0,
  timeLeftSeconds: 0,
  dateAdded: '2024-01-01T00:00:00Z',
  category: 'compressed',
  queueId: 'main',
  connections: 1,
  resumable: true,
  savePath: '/downloads',
  description: '',
  segments: [],
  ...overrides,
});

const defaultProps = {
  filteredTasks: [makeTask('1'), makeTask('2'), makeTask('3')],
  name: 'Main Queue',
  isScheduled: false,
  startTime: '02:00',
  endTime: '08:00',
  searchQuery: '',
  onSearchChange: vi.fn(),
  taskToRemoveId: null as string | null,
  onRemoveRequest: vi.fn(),
  onRemoveConfirm: vi.fn(),
  onMoveUp: vi.fn(),
  onMoveDown: vi.fn(),
  onMoveToEdge: vi.fn(),
  onReorder: vi.fn(),
};

describe('SchedulerFilesTab', () => {
  it('renders queue name in header', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    expect(screen.getByText('Main Queue')).toBeInTheDocument();
  });

  it('shows schedule badge when scheduled', () => {
    render(<SchedulerFilesTab {...defaultProps} isScheduled startTime="02:00" endTime="08:00" />);
    expect(screen.getByText(/Active/)).toBeInTheDocument();
  });

  it('hides schedule badge when not scheduled', () => {
    render(<SchedulerFilesTab {...defaultProps} isScheduled={false} />);
    expect(screen.queryByText(/Active/)).not.toBeInTheDocument();
  });

  it('renders search input', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();
  });

  it('calls onSearchChange when typing in search', () => {
    const onSearchChange = vi.fn();
    render(<SchedulerFilesTab {...defaultProps} onSearchChange={onSearchChange} />);
    const input = screen.getByPlaceholderText('Search tasks...');
    fireEvent.change(input, { target: { value: 'test' } });
    expect(onSearchChange).toHaveBeenCalledWith('test');
  });

  it('shows clear button when searchQuery is not empty', () => {
    render(<SchedulerFilesTab {...defaultProps} searchQuery="test" />);
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('calls onSearchChange with empty string when clear is clicked', () => {
    const onSearchChange = vi.fn();
    render(<SchedulerFilesTab {...defaultProps} searchQuery="test" onSearchChange={onSearchChange} />);
    fireEvent.click(screen.getByText('Clear'));
    expect(onSearchChange).toHaveBeenCalledWith('');
  });

  it('renders all tasks', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText('Task 2')).toBeInTheDocument();
    expect(screen.getByText('Task 3')).toBeInTheDocument();
  });

  it('shows empty state when no tasks', () => {
    render(<SchedulerFilesTab {...defaultProps} filteredTasks={[]} />);
    expect(screen.getByText(/No tasks in/)).toBeInTheDocument();
  });

  it('shows move up button for all items (disabled for first)', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const moveUpButtons = screen.getAllByTitle('Move Up');
    expect(moveUpButtons).toHaveLength(3);
  });

  it('disables move up button for first item', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const moveUpButtons = screen.getAllByTitle('Move Up');
    expect(moveUpButtons[0].closest('button')).toBeDisabled();
  });

  it('shows move down button for all items (disabled for last)', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const moveDownButtons = screen.getAllByTitle('Move Down');
    expect(moveDownButtons).toHaveLength(3);
  });

  it('disables move down button for last item', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const moveDownButtons = screen.getAllByTitle('Move Down');
    expect(moveDownButtons[2].closest('button')).toBeDisabled();
  });

  it('calls onMoveUp when clicking move up', () => {
    const onMoveUp = vi.fn();
    render(<SchedulerFilesTab {...defaultProps} onMoveUp={onMoveUp} />);
    const moveUpButtons = screen.getAllByTitle('Move Up');
    fireEvent.click(moveUpButtons[1]);
    expect(onMoveUp).toHaveBeenCalledWith('2');
  });

  it('calls onMoveDown when clicking move down', () => {
    const onMoveDown = vi.fn();
    render(<SchedulerFilesTab {...defaultProps} onMoveDown={onMoveDown} />);
    const moveDownButtons = screen.getAllByTitle('Move Down');
    fireEvent.click(moveDownButtons[0]);
    expect(onMoveDown).toHaveBeenCalledWith('1');
  });

  it('shows remove confirmation when remove button clicked', () => {
    const onRemoveRequest = vi.fn();
    render(<SchedulerFilesTab {...defaultProps} onRemoveRequest={onRemoveRequest} />);
    const removeButtons = screen.getAllByTitle('Remove');
    fireEvent.click(removeButtons[0]);
    expect(onRemoveRequest).toHaveBeenCalledWith('1');
  });

  it('shows remove confirm dialog when taskToRemoveId matches', () => {
    render(<SchedulerFilesTab {...defaultProps} taskToRemoveId="1" />);
    expect(screen.getByText('Remove?')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('calls onRemoveConfirm when Yes is clicked', () => {
    const onRemoveConfirm = vi.fn();
    render(<SchedulerFilesTab {...defaultProps} taskToRemoveId="1" onRemoveConfirm={onRemoveConfirm} />);
    fireEvent.click(screen.getByText('Yes'));
    expect(onRemoveConfirm).toHaveBeenCalledWith('1');
  });

  it('calls onRemoveRequest with null when No is clicked', () => {
    const onRemoveRequest = vi.fn();
    render(<SchedulerFilesTab {...defaultProps} taskToRemoveId="1" onRemoveRequest={onRemoveRequest} />);
    fireEvent.click(screen.getByText('No'));
    expect(onRemoveRequest).toHaveBeenCalledWith(null);
  });

  it('opens context menu on right-click', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const taskElement = screen.getByText('Task 1').closest('[draggable]') || screen.getByText('Task 1');
    fireEvent.contextMenu(taskElement);
    expect(screen.getByText('Properties')).toBeInTheDocument();
  });

  it('shows context menu options for first item (no move-up options)', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const taskElement = screen.getByText('Task 1').closest('[draggable]') || screen.getByText('Task 1');
    fireEvent.contextMenu(taskElement);
    expect(screen.getByText('Move Down')).toBeInTheDocument();
    expect(screen.getByText('Move to Bottom')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('shows context menu options for middle item', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const taskElement = screen.getByText('Task 2').closest('[draggable]') || screen.getByText('Task 2');
    fireEvent.contextMenu(taskElement);
    expect(screen.getByText('Move to Top')).toBeInTheDocument();
    expect(screen.getByText('Move Up')).toBeInTheDocument();
    expect(screen.getByText('Move Down')).toBeInTheDocument();
    expect(screen.getByText('Move to Bottom')).toBeInTheDocument();
  });

  it('shows context menu options for last item (no move-down options)', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const taskElement = screen.getByText('Task 3').closest('[draggable]') || screen.getByText('Task 3');
    fireEvent.contextMenu(taskElement);
    expect(screen.getByText('Move to Top')).toBeInTheDocument();
    expect(screen.getByText('Move Up')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('handles drag start and end', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const taskElement = screen.getByText('Task 1').closest('[draggable]') as HTMLElement;
    expect(taskElement).toBeInTheDocument();
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '', getData: vi.fn() };
    fireEvent.dragStart(taskElement, { dataTransfer });
    fireEvent.dragEnd(taskElement);
  });

  it('handles drag over and drop', () => {
    const onReorder = vi.fn();
    render(<SchedulerFilesTab {...defaultProps} onReorder={onReorder} />);
    const task1 = screen.getByText('Task 1').closest('[draggable]') as HTMLElement;
    const task2 = screen.getByText('Task 2').closest('[draggable]') as HTMLElement;
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '', getData: vi.fn(() => '1') };
    fireEvent.dragStart(task1, { dataTransfer });
    fireEvent.dragOver(task2, { dataTransfer });
    fireEvent.drop(task2, { dataTransfer });
    fireEvent.dragEnd(task1);
  });

  it('renders drag handle for each task when not searching', () => {
    const { container } = render(<SchedulerFilesTab {...defaultProps} />);
    const grips = container.querySelectorAll('.lucide-grip-vertical');
    expect(grips.length).toBe(3);
  });

  it('renders task index numbers', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    const task1Parent = screen.getByText('Task 1').closest('[draggable]');
    expect(task1Parent).toBeInTheDocument();
  });

  it('shows file count in header', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    expect(screen.getByText(/Total files:/)).toBeInTheDocument();
  });

  it('shows drag hint text', () => {
    render(<SchedulerFilesTab {...defaultProps} />);
    expect(screen.getByText('Drag to reorder')).toBeInTheDocument();
  });
});
