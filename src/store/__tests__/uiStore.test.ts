import { describe, it, expect, beforeEach, vi } from 'vitest';
import { uiStore } from '../uiStore';
import type { DownloadItem } from '../../types/desktop-ui.types';

vi.mock('../../utils/sound', () => ({ playAppSound: vi.fn() }));

describe('uiStore', () => {
  beforeEach(() => {
    uiStore.setState({
      selectedTaskId: null,
      workspaceView: 'all',
      searchQuery: '',
      dialog: { active: null },
      activePage: 'downloads',
      toasts: [],
      isNotificationsMuted: false,
      activeProgressMinimizedToTaskbar: false,
      minimizedProgressTask: null,
    });
  });

  it('has correct initial state', () => {
    const s = uiStore.getState();
    expect(s.selectedTaskId).toBeNull();
    expect(s.workspaceView).toBe('all');
    expect(s.searchQuery).toBe('');
    expect(s.dialog).toEqual({ active: null });
    expect(s.activePage).toBe('downloads');
    expect(s.toasts).toEqual([]);
  });

  it('setSelectedTaskId', () => {
    uiStore.getState().setSelectedTaskId('abc');
    expect(uiStore.getState().selectedTaskId).toBe('abc');
    uiStore.getState().setSelectedTaskId(null);
    expect(uiStore.getState().selectedTaskId).toBeNull();
  });

  it('setWorkspaceView', () => {
    uiStore.getState().setWorkspaceView('finished');
    expect(uiStore.getState().workspaceView).toBe('finished');
  });

  it('setSearchQuery', () => {
    uiStore.getState().setSearchQuery('test.pdf');
    expect(uiStore.getState().searchQuery).toBe('test.pdf');
  });

  it('setActivePage', () => {
    uiStore.getState().setActivePage('scheduler');
    expect(uiStore.getState().activePage).toBe('scheduler');
  });

  describe('openDialog', () => {
    it('opens a regular dialog', () => {
      uiStore.getState().openDialog('activeProgress', { id: 'task1' });
      expect(uiStore.getState().dialog.active).toBe('activeProgress');
      expect(uiStore.getState().dialog.payload).toEqual({ id: 'task1' });
    });

    it('redirects settings to page navigation', () => {
      uiStore.getState().openDialog('settings');
      expect(uiStore.getState().dialog.active).toBeNull();
      expect(uiStore.getState().activePage).toBe('settings');
    });

    it('redirects scheduler to page navigation', () => {
      uiStore.getState().openDialog('scheduler');
      expect(uiStore.getState().dialog.active).toBeNull();
      expect(uiStore.getState().activePage).toBe('scheduler');
    });

    it('redirects mediaDownload to page', () => {
      uiStore.getState().openDialog('mediaDownload', { url: 'http://example.com' });
      expect(uiStore.getState().dialog.active).toBeNull();
      expect(uiStore.getState().activePage).toBe('mediaDownload');
      expect(uiStore.getState().dialog.payload).toEqual({ url: 'http://example.com' });
    });

    it('resets minimized progress on activeProgress', () => {
      uiStore.setState({ activeProgressMinimizedToTaskbar: true, minimizedProgressTask: { id: 'x' } as DownloadItem });
      uiStore.getState().openDialog('activeProgress', { id: 'task1' });
      expect(uiStore.getState().activeProgressMinimizedToTaskbar).toBe(false);
      expect(uiStore.getState().minimizedProgressTask).toBeNull();
      expect(uiStore.getState().dialog.active).toBe('activeProgress');
    });
  });

  describe('closeDialog', () => {
    it('resets dialog state', () => {
      uiStore.setState({ dialog: { active: 'settings', payload: { tab: 'general' } } });
      uiStore.getState().closeDialog();
      expect(uiStore.getState().dialog).toEqual({ active: null });
      expect(uiStore.getState().activeProgressMinimizedToTaskbar).toBe(false);
      expect(uiStore.getState().minimizedProgressTask).toBeNull();
    });

    it('navigates back to downloads from mediaDownload', () => {
      uiStore.setState({ activePage: 'mediaDownload', dialog: { active: 'some' } });
      uiStore.getState().closeDialog();
      expect(uiStore.getState().activePage).toBe('downloads');
    });

    it('does not navigate away from non-mediaDownload pages', () => {
      uiStore.setState({ activePage: 'scheduler', dialog: { active: 'some' } });
      uiStore.getState().closeDialog();
      expect(uiStore.getState().activePage).toBe('scheduler');
    });
  });

  describe('addToast', () => {
    it('adds a toast', () => {
      uiStore.getState().addToast('success', 'Title', 'Message');
      expect(uiStore.getState().toasts).toHaveLength(1);
      expect(uiStore.getState().toasts[0].type).toBe('success');
      expect(uiStore.getState().toasts[0].title).toBe('Title');
      expect(uiStore.getState().toasts[0].message).toBe('Message');
    });

    it('does not add toast when muted', () => {
      uiStore.setState({ isNotificationsMuted: true });
      uiStore.getState().addToast('success', 'Title', 'Message');
      expect(uiStore.getState().toasts).toHaveLength(0);
    });

    it('caps toasts at 50', () => {
      const manyToasts = Array.from({ length: 50 }, (_, i) => ({
        id: `t${String(i)}`,
        type: 'info' as const,
        title: `T${String(i)}`,
        message: `M${String(i)}`,
      }));
      uiStore.setState({ toasts: manyToasts });
      uiStore.getState().addToast('info', 'New', 'Extra');
      expect(uiStore.getState().toasts).toHaveLength(50);
      expect(uiStore.getState().toasts[uiStore.getState().toasts.length - 1].title).toBe('New');
    });
  });

  it('removeToast removes by id', () => {
    uiStore.setState({
      toasts: [
        { id: 'a', type: 'info', title: 'A', message: '' },
        { id: 'b', type: 'error', title: 'B', message: '' },
      ],
    });
    uiStore.getState().removeToast('a');
    expect(uiStore.getState().toasts).toHaveLength(1);
    expect(uiStore.getState().toasts[0].id).toBe('b');
  });

  describe('minimizeActiveProgressToTaskbar', () => {
    it('minimizes with explicit task', () => {
      const task = { id: 't1', name: 'file.zip' } as DownloadItem;
      uiStore.getState().openDialog('activeProgress', task);
      uiStore.getState().minimizeActiveProgressToTaskbar(task);
      expect(uiStore.getState().minimizedProgressTask).toEqual(task);
      expect(uiStore.getState().activeProgressMinimizedToTaskbar).toBe(true);
      expect(uiStore.getState().dialog.active).toBeNull();
    });

    it('no-ops when no task available', () => {
      uiStore.setState({ dialog: { active: null } });
      uiStore.getState().minimizeActiveProgressToTaskbar();
      expect(uiStore.getState().activeProgressMinimizedToTaskbar).toBe(false);
    });
  });
});
