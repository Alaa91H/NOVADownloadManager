/* src/components/TopBar.tsx */
import React from 'react';
import { 
  Plus, Layers, Play, Pause, Square, Trash2, Settings, Search, 
  Clock, Globe, Youtube, ChevronDown
} from 'lucide-react';
import { useAppStore } from '../state/appStore';

export const TopBar: React.FC = () => {
  const { 
    selectedTaskId, 
    tasks, 
    pauseTask, 
    resumeTask, 
    deleteTask,
    searchQuery, 
    setSearchQuery, 
    openDialog,
    addToast
  } = useAppStore();

  const selectedTask = tasks.find(t => t.id === selectedTaskId);
  
  // Dynamic contexts for TopBar buttons:
  const hasSelectedTask = !!(selectedTaskId && selectedTask);

  // Resume State
  const canResumeSelected = hasSelectedTask && selectedTask && (selectedTask.status === 'paused' || selectedTask.status === 'failed' || selectedTask.status === 'queued');

  // Pause State
  const canPauseSelected = hasSelectedTask && selectedTask && selectedTask.status === 'downloading';

  // Stop State
  const canStopSelected = hasSelectedTask && selectedTask && selectedTask.status === 'downloading';

  // Resume All Tasks
  const handleResumeAll = () => {
    const inactive = tasks.filter(t => t.status === 'paused' || t.status === 'queued');
    if (inactive.length === 0) {
      addToast('info', 'Resume All', 'No paused files to resume.');
      return;
    }
    inactive.forEach(t => resumeTask(t.id));
    addToast('success', 'Resume All', `Resuming download of ${inactive.length} files.`);
  };

  // Pause All Tasks
  const handlePauseAll = () => {
    const active = tasks.filter(t => t.status === 'downloading');
    if (active.length === 0) {
      addToast('info', 'Pause All', 'No active downloads to pause.');
      return;
    }
    active.forEach(t => pauseTask(t.id));
    addToast('warning', 'Pause All', `Paused all active downloads (${active.length} files).`);
  };

  // Stop All Tasks
  const handleStopAll = () => {
    const active = tasks.filter(t => t.status === 'downloading');
    if (active.length === 0) {
      addToast('info', 'Stop All', 'No active downloads to stop.');
      return;
    }
    active.forEach(t => pauseTask(t.id));
    addToast('warning', 'Stop All', `Stopped all active downloads (${active.length} files).`);
  };

  // Delete All Tasks
  const handleDeleteAll = () => {
    if (tasks.length === 0) {
      addToast('info', 'Delete All', 'No downloads to delete.');
      return;
    }
    tasks.forEach(t => deleteTask(t.id, false));
    addToast('warning', 'Delete All', `Deleted all files from download list (${tasks.length} files).`);
  };

  const [isNewDownloadDropdownOpen, setIsNewDownloadDropdownOpen] = React.useState(false);

  return (
    <header className="bg-[var(--bg-sidebar)] border-b border-[var(--border-color)] p-2 flex flex-nowrap items-center justify-between gap-3 select-none text-ui shrink-0 relative z-30">
      
      {/* LEFT: Toolbar actions */}
      <div className="flex flex-nowrap items-center gap-1.5 shrink-0">
        {/* Action: Unified Add Task Button with Dropdown (Split Button Pattern) */}
        <div className="relative">
          <div className="flex items-stretch rounded-lg bg-[var(--accent-primary)] hover:scale-[1.03] active:scale-[0.97] transition-all duration-150 shadow-md accent-glow select-none shrink-0 overflow-hidden">
            {/* Main Action: Add Single Download */}
            <button 
              onClick={() => openDialog('addDownload')}
              className="px-3 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white font-extrabold transition-all cursor-pointer flex items-center gap-1.5 text-xs border-r border-white/15"
              title="Add new download link"
            >
              <Plus className="w-3.5 h-3.5 stroke-[3]" />
              <span>New Download</span>
            </button>

            {/* Split Dropdown Trigger: Show other options */}
            <button 
              onClick={(e) => {
                e.stopPropagation();
                const nextVal = !isNewDownloadDropdownOpen;
                setIsNewDownloadDropdownOpen(nextVal);
              }}
              data-dialog-trigger="true"
              className="px-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white transition-all cursor-pointer flex items-center justify-center"
              title="More download options"
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isNewDownloadDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {isNewDownloadDropdownOpen && (
            <>
              <div 
                className="fixed inset-0 z-40 bg-transparent" 
                onClick={() => setIsNewDownloadDropdownOpen(false)} 
              />
              <div className="absolute top-full left-0 mt-1.5 w-64 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg shadow-xl p-1.5 z-50 animate-in fade-in slide-in-from-top-1 duration-100 flex flex-col gap-0.5">
                <button
                  onClick={() => {
                    openDialog('addDownload');
                    setIsNewDownloadDropdownOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                >
                  <Plus className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Single URL Download</span>
                </button>

                <button
                  onClick={() => {
                    openDialog('batchDownload');
                    setIsNewDownloadDropdownOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                >
                  <Layers className="w-4 h-4 text-sky-500 shrink-0" />
                  <span>Batch Download</span>
                </button>

                <button
                  onClick={() => {
                    openDialog('webpageGrabber');
                    setIsNewDownloadDropdownOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                >
                  <Globe className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span>Webpage Grabber</span>
                </button>

                <button
                  onClick={() => {
                    openDialog('youtubeDownload');
                    setIsNewDownloadDropdownOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                >
                  <Youtube className="w-4 h-4 text-red-500 shrink-0" />
                  <span>Media Downloader</span>
                </button>
              </div>
            </>
          )}
        </div>

        <div className="h-5 w-px bg-[var(--border-color)] mx-1 shrink-0" />

        {/* Action: Resume */}
        <button 
          onClick={() => {
            if (canResumeSelected && selectedTaskId) {
              resumeTask(selectedTaskId);
            } else {
              handleResumeAll();
            }
          }}
          className="px-3 py-1.5 border border-[var(--border-color)] rounded-lg text-[var(--text-secondary)] hover:text-emerald-400 hover:border-emerald-500/20 hover:bg-emerald-500/10 transition-all cursor-pointer flex items-center gap-1 text-xs font-bold shrink-0 hover:scale-[1.03] active:scale-[0.97] duration-150"
          title={hasSelectedTask ? 'Resume selected download' : 'Resume all paused downloads'}
        >
          <Play className="w-4 h-4 text-emerald-500 fill-emerald-500/20" />
          <span className="hidden md:inline">Resume</span>
        </button>

        {/* Action: Pause */}
        <button 
          onClick={() => {
            if (canPauseSelected && selectedTaskId) {
              pauseTask(selectedTaskId);
            } else {
              handlePauseAll();
            }
          }}
          className="px-3 py-1.5 border border-[var(--border-color)] rounded-lg text-[var(--text-secondary)] hover:text-amber-400 hover:border-amber-500/20 hover:bg-amber-500/10 transition-all cursor-pointer flex items-center gap-1 text-xs font-bold shrink-0 hover:scale-[1.03] active:scale-[0.97] duration-150"
          title={hasSelectedTask ? 'Pause selected download' : 'Pause all active downloads'}
        >
          <Pause className="w-4 h-4 text-amber-500 fill-amber-500/20" />
          <span className="hidden md:inline">Pause</span>
        </button>

        {/* Action: Stop */}
        <button 
          onClick={() => {
            if (canStopSelected && selectedTaskId) {
              pauseTask(selectedTaskId);
            } else {
              handleStopAll();
            }
          }}
          className="px-3 py-1.5 border border-[var(--border-color)] rounded-lg text-[var(--text-secondary)] hover:text-rose-400 hover:border-rose-500/20 hover:bg-rose-500/10 transition-all cursor-pointer flex items-center gap-1 text-xs font-bold shrink-0 hover:scale-[1.03] active:scale-[0.97] duration-150"
          title={hasSelectedTask ? 'Stop selected download' : 'Stop all active downloads'}
        >
          <Square className="w-3.5 h-3.5 text-rose-500 fill-rose-500/20" />
          <span className="hidden md:inline">Stop</span>
        </button>

        {/* Action: Delete */}
        <button 
          onClick={() => {
            if (hasSelectedTask && selectedTask) {
              openDialog('confirmDelete', selectedTask);
            } else if (tasks.length > 0) {
              openDialog('genericConfirm', {
                message: 'Are you sure you want to delete all downloads from the list?',
                isDanger: true,
                onConfirm: () => { handleDeleteAll(); }
              });
            }
          }}
          className="px-3 py-1.5 border border-[var(--border-color)] rounded-lg text-red-500 hover:text-red-400 hover:border-red-500/20 hover:bg-red-500/10 transition-all cursor-pointer flex items-center gap-1 text-xs font-bold shrink-0 hover:scale-[1.03] active:scale-[0.97] duration-150"
          title={hasSelectedTask ? 'Delete selected download' : 'Delete all downloads'}
        >
          <Trash2 className="w-4 h-4" />
          <span className="hidden md:inline">Delete</span>
        </button>

        <div className="h-5 w-px bg-[var(--border-color)] mx-1 shrink-0" />

        {/* Action: Scheduler / Organiser */}
        <button 
          onClick={() => openDialog('scheduler')}
          data-dialog-trigger="true"
          className="px-3 py-1.5 border rounded-lg transition-all cursor-pointer flex items-center gap-1 text-xs font-bold shrink-0 hover:scale-[1.03] active:scale-[0.97] duration-150"
          title="Download queues and speed schedule"
        >
          <Clock className="w-4 h-4 text-amber-500" />
          <span className="hidden sm:inline">Scheduler</span>
        </button>

      </div>

      {/* RIGHT: Search Query Input bar & Settings icon */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Settings Button */}
        <button 
          onClick={() => openDialog('settings')}
          data-dialog-trigger="true"
          className="p-1.5 hover:bg-[var(--bg-hover)] rounded-lg text-slate-400 hover:text-slate-200 transition-all cursor-pointer shrink-0"
          title="General Settings"
        >
          <Settings className="w-4.5 h-4.5" />
        </button>

        {/* Search Input */}
        <div className="relative w-48 sm:w-60">
          <Search className="absolute right-2.5 top-2.5 w-3.5 h-3.5 text-[var(--text-muted)]" />
          <input 
            type="text" 
            placeholder="Search downloads and links..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg py-1.5 pr-8 pl-3 text-xs focus:outline-none focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] text-[var(--text-primary)] font-medium"
          />
        </div>
      </div>
    </header>
  );
};
