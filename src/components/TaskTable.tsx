/* src/components/TaskTable.tsx */
import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, Trash2, Sliders, HardDrive, FileText, Cpu, Film, Music, Shield, HelpCircle, ChevronDown, ArrowUp, ArrowDown, GripVertical, ListPlus
} from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { DownloadItem, FileType } from '../types/desktop-ui.types';
import { StatusPill } from './primitives';

interface TaskCheckboxAndIconProps {
  isChecked: boolean;
  fileType: FileType;
  taskId: string;
  handleToggleCheckTask: (id: string, e: React.MouseEvent) => void;
  getFileTypeIcon: (type: FileType, customSize?: string) => React.ReactNode;
  hasSelection: boolean;
}

const TaskCheckboxAndIcon: React.FC<TaskCheckboxAndIconProps> = ({ 
  isChecked, 
  fileType, 
  taskId, 
  handleToggleCheckTask, 
  getFileTypeIcon,
  hasSelection
}) => {
  const showCheckbox = isChecked || hasSelection;
  return (
    <div 
      className="group relative w-6 h-6 flex items-center justify-center cursor-pointer"
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        handleToggleCheckTask(taskId, e);
      }}
    >
      {/* Checkbox: visible if checked, hasSelection, or on group-hover */}
      <div className={`transition-all duration-100 ${showCheckbox ? 'block' : 'hidden group-hover:block'}`}>
        <input 
          type="checkbox" 
          checked={isChecked}
          onChange={() => {}}
          className="rounded-none border-[var(--border-color)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer h-3.5 w-3.5 shrink-0"
        />
      </div>
      {/* Icon: hidden if checked, hasSelection, or on group-hover */}
      <div 
        className={`w-6 h-6 bg-[var(--bg-hover)]/60 border border-[var(--border-color)]/30 rounded-none flex items-center justify-center text-xs shrink-0 shadow-sm transition-all duration-100 ${
          showCheckbox ? 'hidden' : 'block group-hover:hidden'
        }`}
      >
        {getFileTypeIcon(fileType, "w-3.5 h-3.5")}
      </div>
    </div>
  );
};

export const TaskTable: React.FC = () => {
  const { 
    tasks, 
    selectedTaskId, 
    setSelectedTaskId, 
    searchQuery, 
    workspaceView,
    pauseTask, 
    resumeTask, 
    deleteTask,
    openDialog,
    t,
    addToast
  } = useAppStore();

  const isRtl = false;

  const getColAlign = (colKey: string) => {
    if (colKey === 'name' || colKey === 'sourceUrl') return 'text-left';
    return 'text-start';
  };

  const [sortBy, setSortBy] = useState<'name' | 'sizeBytes' | 'dateAdded' | 'status' | 'progress' | 'speed' | 'timeLeft' | 'retries' | 'connections' | 'crc32' | 'priority' | 'completedDate' | 'sourceUrl' | 'smartCategory'>('dateAdded');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  
  // Custom column widths and visibility state with localStorage caching
  const [colWidths, setColWidths] = useState<{ [key: string]: number }>(() => {
    const defaultWidths = {
      name: 240,
      size: 96,
      progress: 160,
      speed: 110,
      timeLeft: 110,
      date: 130,
      status: 96,
      retries: 80,
      connections: 85,
      crc32: 90,
      priority: 95,
      completedDate: 130,
      sourceUrl: 180,
      smartCategory: 125,
    };
    const cached = localStorage.getItem('nova_col_widths');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return { ...defaultWidths, ...parsed };
      } catch (e) {
        return defaultWidths;
      }
    }
    return defaultWidths;
  });

  const [visibleCols, setVisibleCols] = useState<{ [key: string]: boolean }>(() => {
    const defaultCols = {
      name: true,
      size: true,
      progress: true,
      speed: true,
      timeLeft: true,
      date: true,
      status: true,
      retries: false,
      connections: false,
      crc32: false,
      priority: false,
      completedDate: false,
      sourceUrl: false,
      smartCategory: false,
    };
    const cached = localStorage.getItem('nova_visible_cols');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return { ...defaultCols, ...parsed };
      } catch (e) {
        return defaultCols;
      }
    }
    return defaultCols;
  });

  // Dynamic Column Order State with LocalStorage Caching
  const [colOrder, setColOrder] = useState<string[]>(() => {
    const defaultOrder = ['name', 'size', 'progress', 'speed', 'timeLeft', 'date', 'status', 'retries', 'connections', 'crc32', 'priority', 'completedDate', 'sourceUrl', 'smartCategory'];
    const cached = localStorage.getItem('nova_col_order');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter(item => defaultOrder.includes(item));
          const missing = defaultOrder.filter(item => !valid.includes(item));
          return [...valid, ...missing];
        }
      } catch (e) {
        return defaultOrder;
      }
    }
    return defaultOrder;
  });

  // Checkbox Selection State for Multi-Selection Task Operations
  const [checkedTaskIds, setCheckedTaskIds] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);

  // Unified Press / Long Press Handlers for Multi-Selection
  const pressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isLongPressTriggered = useRef(false);

  const startRowPress = (taskId: string, e: React.MouseEvent | React.TouchEvent) => {
    // Only left click for mouse
    if ('button' in e && e.button !== 0) return;
    
    isLongPressTriggered.current = false;
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
    }
    
    pressTimerRef.current = setTimeout(() => {
      isLongPressTriggered.current = true;
      setCheckedTaskIds(prev => {
        const next = new Set(prev);
        if (next.has(taskId)) {
          next.delete(taskId);
        } else {
          next.add(taskId);
        }
        return next;
      });
      setSelectedTaskId(taskId);
    }, 600); // 600ms threshold for long press
  };

  const endRowPress = (taskId: string, e: React.MouseEvent | React.TouchEvent) => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    
    if (!isLongPressTriggered.current) {
      // Normal click behavior:
      if (checkedTaskIds.size > 0) {
        setCheckedTaskIds(prev => {
          const next = new Set(prev);
          if (next.has(taskId)) {
            next.delete(taskId);
          } else {
            next.add(taskId);
          }
          return next;
        });
      } else {
        setSelectedTaskId(taskId);
      }
    }
    isLongPressTriggered.current = false;
  };

  const cancelRowPress = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    isLongPressTriggered.current = false;
  };

  // Drag and Drop Column Tracking States
  const [draggingCol, setDraggingCol] = useState<string | null>(null);
  const [draggingCustomizeCol, setDraggingCustomizeCol] = useState<string | null>(null);

  const [showColConfig, setShowColConfig] = useState(false);

  useEffect(() => {
    localStorage.setItem('nova_col_widths', JSON.stringify(colWidths));
  }, [colWidths]);

  useEffect(() => {
    localStorage.setItem('nova_visible_cols', JSON.stringify(visibleCols));
  }, [visibleCols]);

  useEffect(() => {
    localStorage.setItem('nova_col_order', JSON.stringify(colOrder));
  }, [colOrder]);

  const colConfigRef = useRef<HTMLDivElement>(null);

  // Close menus on outside clicks
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (colConfigRef.current && !colConfigRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (!target.closest('button')) {
          setShowColConfig(false);
        }
      }
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  // Column resizing handler (Drag & Drop)
  const startResize = (colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[colKey];

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const diff = moveEvent.clientX - startX;
      // Since app direction is RTL, dragging left (negative diff) should expand widths, right (positive diff) contracts widths
      const directionMultiplier = document.documentElement.dir === 'rtl' ? -1 : 1;
      const calculatedWidth = startWidth + (diff * directionMultiplier);
      
      setColWidths(prev => ({
        ...prev,
        [colKey]: Math.max(60, calculatedWidth)
      }));
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('select-none');
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.classList.add('select-none');
  };

  // Drag and Drop Table Header Column Handlers
  const handleDragStart = (e: React.DragEvent, colKey: string) => {
    if (e.target instanceof HTMLElement && e.target.closest('.cursor-col-resize')) {
      e.preventDefault();
      return;
    }
    setDraggingCol(colKey);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-nova-column', colKey);
    e.dataTransfer.setData('text/plain', colKey);
  };

  const handleDragOver = (e: React.DragEvent, colKey: string) => {
    if (draggingCol && draggingCol !== colKey) {
      e.preventDefault();
    }
  };

  const handleDrop = (e: React.DragEvent, targetColKey: string) => {
    e.preventDefault();
    const sourceColKey = e.dataTransfer.getData('application/x-nova-column') || e.dataTransfer.getData('text/plain') || draggingCol;
    if (sourceColKey && sourceColKey !== targetColKey) {
      setColOrder(prev => {
        const newOrder = prev.filter(k => k !== sourceColKey);
        const targetIdx = newOrder.indexOf(targetColKey);
        if (targetIdx !== -1) {
          newOrder.splice(targetIdx, 0, sourceColKey);
        } else {
          newOrder.push(sourceColKey);
        }
        return newOrder;
      });
    }
    setDraggingCol(null);
  };

  const handleDragEnd = () => {
    setDraggingCol(null);
  };

  // Drag and Drop Column Customization list Handlers
  const handleCustomizeDragStart = (e: React.DragEvent, colKey: string) => {
    setDraggingCustomizeCol(colKey);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-nova-customize-column', colKey);
    e.dataTransfer.setData('text/plain', colKey);
  };

  const handleCustomizeDragOver = (e: React.DragEvent, colKey: string) => {
    if (draggingCustomizeCol && draggingCustomizeCol !== colKey) {
      e.preventDefault();
    }
  };

  const handleCustomizeDrop = (e: React.DragEvent, targetColKey: string) => {
    e.preventDefault();
    const sourceColKey = e.dataTransfer.getData('application/x-nova-customize-column') || e.dataTransfer.getData('text/plain') || draggingCustomizeCol;
    if (sourceColKey && sourceColKey !== targetColKey) {
      setColOrder(prev => {
        const newOrder = prev.filter(k => k !== sourceColKey);
        const targetIdx = newOrder.indexOf(targetColKey);
        if (targetIdx !== -1) {
          newOrder.splice(targetIdx, 0, sourceColKey);
        } else {
          newOrder.push(sourceColKey);
        }
        return newOrder;
      });
    }
    setDraggingCustomizeCol(null);
  };

  const handleCustomizeDragEnd = () => {
    setDraggingCustomizeCol(null);
  };

  // Checkbox Multi-Selection Handlers
  const handleToggleCheckAll = () => {
    const allFilteredIds = sortedTasks.map(t => t.id);
    const isAllChecked = allFilteredIds.length > 0 && allFilteredIds.every(id => checkedTaskIds.has(id));
    
    setCheckedTaskIds(prev => {
      const next = new Set(prev);
      if (isAllChecked) {
        allFilteredIds.forEach(id => next.delete(id));
      } else {
        allFilteredIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const handleToggleCheckTask = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCheckedTaskIds(prev => {
      const next = new Set(prev);
      if (e.shiftKey && lastCheckedId) {
        const allFilteredIds = sortedTasks.map(t => t.id);
        const currentIndex = allFilteredIds.indexOf(id);
        const lastIndex = allFilteredIds.indexOf(lastCheckedId);
        
        if (currentIndex !== -1 && lastIndex !== -1) {
          const start = Math.min(currentIndex, lastIndex);
          const end = Math.max(currentIndex, lastIndex);
          const rangeIds = allFilteredIds.slice(start, end + 1);
          
          const shouldCheck = !prev.has(id);
          rangeIds.forEach(rangeId => {
            if (shouldCheck) {
              next.add(rangeId);
            } else {
              next.delete(rangeId);
            }
          });
        }
      } else {
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
    setLastCheckedId(id);
  };

  // Batch Multi-Selection Actions
  const handleBatchResume = () => {
    checkedTaskIds.forEach(id => {
      const task = tasks.find(t => t.id === id);
      if (task && (task.status === 'paused' || task.status === 'error')) {
        resumeTask(id);
      }
    });
    setCheckedTaskIds(new Set());
  };

  const handleBatchPause = () => {
    checkedTaskIds.forEach(id => {
      const task = tasks.find(t => t.id === id);
      if (task && task.status === 'downloading') {
        pauseTask(id);
      }
    });
    setCheckedTaskIds(new Set());
  };

  const handleBatchDelete = () => {
    if (confirm(`Are you sure you want to delete ${checkedTaskIds.size} files from the download list?`)) {
      checkedTaskIds.forEach(id => {
        deleteTask(id, false);
      });
      setCheckedTaskIds(new Set());
    }
  };

  const getSortField = (colKey: string) => {
    switch (colKey) {
      case 'size': return 'sizeBytes';
      case 'date': return 'dateAdded';
      default: return colKey as any;
    }
  };

  const columnLabels: { [key: string]: string } = {
    name: 'Filename',
    size: 'Size',
    progress: 'Progress',
    speed: 'Speed',
    timeLeft: 'Time Left',
    date: 'Date Added',
    status: 'Status',
    retries: 'Retries',
    connections: 'Threads',
    crc32: 'CRC32',
    priority: 'Priority',
    completedDate: 'Completed',
    sourceUrl: 'Source URL',
    smartCategory: 'Smart Category'
  };

  // Filter tasks based on Workspace Category Sidebar & Search queries
  const filteredTasks = tasks.filter(task => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!task.name.toLowerCase().includes(q) && !task.url.toLowerCase().includes(q)) {
        return false;
      }
    }
    if (workspaceView === 'all') return true;
    if (workspaceView === 'unfinished') return task.status !== 'completed';
    if (workspaceView === 'finished') return task.status === 'completed';
    if (workspaceView === 'queued') return task.status === 'queued';
    return task.fileType === workspaceView;
  });

  // Sort tasks
  const sortedTasks = [...filteredTasks].sort((a, b) => {
    let valA: any = a[sortBy as keyof DownloadItem];
    let valB: any = b[sortBy as keyof DownloadItem];

    // Custom sorting overrides for derived/complex properties
    if (sortBy === 'progress') {
      const progA = a.sizeBytes > 0 ? (a.downloadedBytes / a.sizeBytes) : 0;
      const progB = b.sizeBytes > 0 ? (b.downloadedBytes / b.sizeBytes) : 0;
      return sortOrder === 'asc' ? progA - progB : progB - progA;
    }
    if (sortBy === 'speed') {
      const speedA = a.speedBytesPerSec || 0;
      const speedB = b.speedBytesPerSec || 0;
      return sortOrder === 'asc' ? speedA - speedB : speedB - speedA;
    }
    if (sortBy === 'timeLeft') {
      const tlA = a.timeLeftSeconds || 0;
      const tlB = b.timeLeftSeconds || 0;
      return sortOrder === 'asc' ? tlA - tlB : tlB - tlA;
    }
    if (sortBy === 'retries') {
      const rA = a.status === 'error' ? 3 : 0;
      const rB = b.status === 'error' ? 3 : 0;
      return sortOrder === 'asc' ? rA - rB : rB - rA;
    }
    if (sortBy === 'crc32') {
      const cA = a.status === 'completed' ? 1 : 0;
      const cB = b.status === 'completed' ? 1 : 0;
      return sortOrder === 'asc' ? cA - cB : cB - cA;
    }
    if (sortBy === 'priority') {
      const pA = a.queueId === 'fast' ? 3 : a.queueId === 'night' ? 1 : 2;
      const pB = b.queueId === 'fast' ? 3 : b.queueId === 'night' ? 1 : 2;
      return sortOrder === 'asc' ? pA - pB : pB - pA;
    }
    if (sortBy === 'completedDate') {
      const dA = a.status === 'completed' ? a.dateAdded : '';
      const dB = b.status === 'completed' ? b.dateAdded : '';
      return sortOrder === 'asc' ? dA.localeCompare(dB) : dB.localeCompare(dA);
    }
    if (sortBy === 'smartCategory') {
      const catA = a.fileType || '';
      const catB = b.fileType || '';
      return sortOrder === 'asc' ? catA.localeCompare(catB) : catB.localeCompare(catA);
    }

    if (typeof valA === 'string') {
      return sortOrder === 'asc' 
        ? valA.localeCompare(valB) 
        : valB.localeCompare(valA);
    } else if (typeof valA === 'number') {
      return sortOrder === 'asc' 
        ? valA - valB 
        : valB - valA;
    } else {
      return 0;
    }
  });

  const handleSort = (column: 'name' | 'sizeBytes' | 'dateAdded' | 'status' | 'progress' | 'speed' | 'timeLeft' | 'retries' | 'connections' | 'crc32' | 'priority' | 'completedDate' | 'sourceUrl' | 'smartCategory') => {
    if (sortBy === column) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
  };

  const renderSortIcon = (column: 'name' | 'sizeBytes' | 'dateAdded' | 'status' | 'progress' | 'speed' | 'timeLeft' | 'retries' | 'connections' | 'crc32' | 'priority' | 'completedDate' | 'sourceUrl' | 'smartCategory') => {
    const isActive = sortBy === column;
    const isAsc = isActive && sortOrder === 'asc';
    const isDesc = isActive && sortOrder === 'desc';

    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-3 h-3 shrink-0 select-none ml-1 transition-all duration-150"
      >
        {/* Left Arrow (Upwards) */}
        <g 
          className={`transition-all duration-150 ${isAsc ? "text-white opacity-100" : "text-slate-500 opacity-35"}`}
          strokeWidth={isAsc ? 2.5 : 1.5}
        >
          <path d="m3 8 4-4 4 4" />
          <path d="M7 4v16" />
        </g>
        
        {/* Right Arrow (Downwards) */}
        <g 
          className={`transition-all duration-150 ${isDesc ? "text-white opacity-100" : "text-slate-500 opacity-35"}`}
          strokeWidth={isDesc ? 2.5 : 1.5}
        >
          <path d="m21 16-4 4-4-4" />
          <path d="M17 20V4" />
        </g>
      </svg>
    );
  };

  const handleRowDoubleClick = (task: DownloadItem) => {
    setSelectedTaskId(task.id);
    if (task.status === 'downloading' || task.status === 'paused' || task.status === 'error') {
      openDialog('activeProgress', task);
    } else {
      openDialog('taskProperties', task);
    }
  };

  const getFileTypeIcon = (type: FileType, customSize?: string) => {
    const size = customSize || "w-4 h-4";
    switch (type) {
      case 'compressed':
        return <Sliders className={`${size} text-amber-500 shrink-0`} />;
      case 'program':
        return <Cpu className={`${size} text-emerald-500 shrink-0`} />;
      case 'video':
        return <Film className={`${size} text-sky-500 shrink-0`} />;
      case 'audio':
        return <Music className={`${size} text-violet-500 shrink-0`} />;
      case 'document':
        return <FileText className={`${size} text-red-500 shrink-0`} />;
      default:
        return <HelpCircle className={`${size} text-slate-400 shrink-0`} />;
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let temp = bytes;
    while (temp >= k && i < sizes.length - 1) {
      temp /= k;
      i++;
    }
    let formattedVal = parseFloat(temp.toFixed(1));
    if (formattedVal >= k && i < sizes.length - 1) {
      formattedVal = parseFloat((formattedVal / k).toFixed(1));
      i++;
    }
    return formattedVal + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec <= 0) return '--';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let i = 0;
    let temp = bytesPerSec;
    while (temp >= k && i < sizes.length - 1) {
      temp /= k;
      i++;
    }
    let formattedVal = parseFloat(temp.toFixed(1));
    if (formattedVal >= k && i < sizes.length - 1) {
      formattedVal = parseFloat((formattedVal / k).toFixed(1));
      i++;
    }
    return formattedVal + ' ' + sizes[i];
  };

  const formatTimeLeft = (sec: number): React.ReactNode => {
    if (sec <= 0) return '--';
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${min}m ${rem}s`;
  };

  const visibleColsCount = Object.values(visibleCols).filter(Boolean).length + 2;

  const allFilteredIds = sortedTasks.map(t => t.id);
  const isAllChecked = allFilteredIds.length > 0 && allFilteredIds.every(id => checkedTaskIds.has(id));
  const isSomeChecked = allFilteredIds.length > 0 && !isAllChecked && allFilteredIds.some(id => checkedTaskIds.has(id));

  return (
    <div className="flex-1 bg-[var(--bg-app)] overflow-auto select-none relative">
      
      {/* High Density Table */}
      <table className="hidden md:table w-full border-collapse text-ui font-medium min-w-[800px] table-fixed">
        <colgroup>
          <col style={{ width: '32px', minWidth: '32px', maxWidth: '32px' }} />
          {colOrder.map(colKey => {
            if (!visibleCols[colKey]) return null;
            return <col key={colKey} style={{ width: `${colWidths[colKey] || 100}px` }} />;
          })}
          <col style={{ width: '48px', minWidth: '48px', maxWidth: '48px' }} />
        </colgroup>
        <thead>
          <tr className="desktop-table-header sticky top-0 z-10 text-xs text-[var(--text-secondary)] border-b border-[var(--border-color)] whitespace-nowrap">
            {/* Selection & Icon Column Combined (Sticky Left in LTR) */}
            <th className="group/header px-1.5 py-2 text-center sticky ltr:left-0 rtl:right-0 z-20 bg-[var(--bg-app)]/80 backdrop-blur-md ltr:border-r rtl:border-l border-[var(--border-color)]" style={{ width: '32px', minWidth: '32px', maxWidth: '32px' }}>
              <div className="flex items-center justify-center min-h-[1.5rem]">
                {/* Master Checkbox: visible if checkedTaskIds.size > 0 OR on group-hover/header */}
                <div className={`transition-all duration-100 ${checkedTaskIds.size > 0 ? 'block' : 'hidden group-hover/header:block'}`}>
                  <input 
                    type="checkbox" 
                    checked={isAllChecked}
                    ref={el => {
                      if (el) el.indeterminate = isSomeChecked;
                    }}
                    onChange={handleToggleCheckAll}
                    className="rounded-none border-[var(--border-color)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer h-3.5 w-3.5"
                  />
                </div>
                {/* Icon: hidden if checkedTaskIds.size > 0 OR on group-hover/header */}
                <div className={`transition-all duration-100 ${checkedTaskIds.size > 0 ? 'hidden' : 'block group-hover/header:hidden'}`}>
                  <ListPlus className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                </div>
              </div>
            </th>

            {colOrder.map(colKey => {
              if (!visibleCols[colKey]) return null;

              const sortField = getSortField(colKey);
              let arabicLabel = '';
              switch (colKey) {
                case 'name': arabicLabel = t('col_name'); break;
                case 'size': arabicLabel = t('col_size'); break;
                case 'progress': arabicLabel = t('col_progress'); break;
                case 'speed': arabicLabel = t('col_speed'); break;
                case 'timeLeft': arabicLabel = t('col_time_left'); break;
                case 'date': arabicLabel = t('col_date_added'); break;
                case 'status': arabicLabel = t('col_status'); break;
                case 'retries': arabicLabel = t('col_retries') || 'Retries'; break;
                case 'connections': arabicLabel = t('col_threads'); break;
                case 'crc32': arabicLabel = 'CRC32'; break;
                case 'priority': arabicLabel = t('col_priority'); break;
                case 'completedDate': arabicLabel = t('col_date_completed') || 'Completed Date'; break;
                case 'sourceUrl': arabicLabel = t('prop_url') || 'Source URL'; break;
                case 'smartCategory': arabicLabel = t('prop_type') || 'Smart Category'; break;
                default: arabicLabel = colKey;
              }

              return (
                <th 
                  key={colKey}
                  draggable="true"
                  onDragStart={(e) => handleDragStart(e, colKey)}
                  onDragOver={(e) => handleDragOver(e, colKey)}
                  onDrop={(e) => handleDrop(e, colKey)}
                  onDragEnd={handleDragEnd}
                  onClick={() => handleSort(sortField)}
                  className={`px-3 py-2 cursor-grab active:cursor-grabbing hover:bg-[var(--bg-hover)] select-none relative font-bold border-r border-[var(--border-color)]/20 transition-all text-[var(--text-secondary)] ${getColAlign(colKey)} ${
                    draggingCol === colKey ? 'opacity-35 bg-[var(--bg-hover)] border-dashed border-[var(--accent-primary)]' : ''
                  }`} 
                  style={{ width: colWidths[colKey] || 100 }}
                >
                  <span className="flex items-center justify-between w-full gap-2">
                    <span>{arabicLabel}</span>
                    {renderSortIcon(sortField)}
                  </span>
                  <div 
                    onMouseDown={(e) => startResize(colKey, e)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[var(--accent-primary)] bg-transparent z-20"
                  />
                </th>
              );
            })}

            {/* Config gear header column (Sticky Right in LTR) */}
            <th className="px-2 py-1 text-center sticky ltr:right-0 rtl:left-0 z-20 bg-[var(--bg-app)]/80 backdrop-blur-md ltr:border-l rtl:border-r border-[var(--border-color)]" style={{ width: '48px', minWidth: '48px', maxWidth: '48px' }}>
              <button 
                onClick={(e) => { e.stopPropagation(); setShowColConfig(!showColConfig); }}
                className="p-1 hover:bg-[var(--bg-hover)] rounded-none text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all cursor-pointer inline-flex items-center justify-center"
                title="Customize columns"
              >
                <Sliders className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedTasks.length === 0 ? (
            <tr>
              <td colSpan={visibleColsCount} className="px-4 py-24 text-center text-[var(--text-muted)]">
                {t('no_downloads')}
              </td>
            </tr>
          ) : (
            sortedTasks.map(task => {
              const progressPercent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;
              const isSelected = selectedTaskId === task.id;
              const isChecked = checkedTaskIds.has(task.id);
              
              return (
                <tr 
                  key={task.id}
                  onDoubleClick={() => handleRowDoubleClick(task)}
                  onMouseDown={(e) => startRowPress(task.id, e)}
                  onMouseUp={(e) => endRowPress(task.id, e)}
                  onMouseLeave={cancelRowPress}
                  onTouchStart={(e) => startRowPress(task.id, e)}
                  onTouchEnd={(e) => endRowPress(task.id, e)}
                  onTouchMove={cancelRowPress}
                  className={`desktop-table-row border-b border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] whitespace-nowrap cursor-pointer transition-colors select-none ${
                    isSelected ? 'selected bg-[var(--bg-hover)]' : ''
                  } ${isChecked ? 'bg-[var(--accent-primary)]/5 border-r-2 border-r-[var(--accent-primary)]' : ''}`}
                >
                  {/* Selection & Icon Combined Cell (Sticky Left, width 24) */}
                  <td className="px-1.5 py-1 text-center sticky ltr:left-0 rtl:right-0 z-10 bg-[var(--bg-app)]/90 backdrop-blur-md ltr:border-r rtl:border-l border-[var(--border-color)]" style={{ width: '32px', minWidth: '32px', maxWidth: '32px' }}>
                    <div className="flex items-center justify-center min-h-[1.5rem]">
                      <TaskCheckboxAndIcon 
                        isChecked={isChecked}
                        fileType={task.fileType}
                        taskId={task.id}
                        handleToggleCheckTask={handleToggleCheckTask}
                        getFileTypeIcon={getFileTypeIcon}
                        hasSelection={checkedTaskIds.size > 0}
                      />
                    </div>
                  </td>

                  {colOrder.map(colKey => {
                    if (!visibleCols[colKey]) return null;
                    const width = colWidths[colKey] || 100;

                    switch (colKey) {
                      case 'name':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-sans truncate text-left" style={{ width }}>
                            <span className="truncate text-[11px] font-semibold font-mono block text-left" style={{ direction: 'ltr' }} title={task.name}>
                              {task.name}
                            </span>
                          </td>
                        );
                      case 'size':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)] truncate text-start" style={{ width }}>
                            {formatBytes(task.sizeBytes)}
                          </td>
                        );
                      case 'progress':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-start" style={{ width }}>
                            <div className="flex items-center gap-1.5">
                              <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden border border-[var(--border-color)]">
                                <div 
                                  className={`h-full bg-[var(--accent-primary)] rounded-full transition-all duration-300 ${task.status === 'downloading' ? 'accent-glow relative overflow-hidden' : ''}`}
                                  style={{ width: `${progressPercent}%` }}
                                >
                                  {task.status === 'downloading' && (
                                    <div className="absolute inset-0 bg-white/20 animate-pulse" />
                                  )}
                                </div>
                              </div>
                              <span className="text-[9px] text-[var(--text-secondary)] font-bold">{progressPercent}%</span>
                            </div>
                          </td>
                        );
                      case 'speed':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-emerald-500 font-bold truncate text-start" style={{ width }}>
                            {formatSpeed(task.speedBytesPerSec)}
                          </td>
                        );
                      case 'timeLeft':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-blue-400 truncate" style={{ width, textAlign: isRtl ? 'right' : 'left' }}>
                            {formatTimeLeft(task.timeLeftSeconds)}
                          </td>
                        );
                      case 'date':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)] truncate" style={{ width, direction: 'ltr', textAlign: isRtl ? 'right' : 'left' }}>
                            {task.dateAdded}
                          </td>
                        );
                      case 'status':
                        return (
                          <td key={colKey} className="px-2 py-0.5 truncate text-start" style={{ width }}>
                            <StatusPill status={task.status} />
                          </td>
                        );
                      case 'retries':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)] truncate text-start" style={{ width }}>
                            {task.status === 'error' ? '3' : '0'}
                          </td>
                        );
                      case 'connections':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)] truncate text-start" style={{ width }}>
                            {task.connections === 0 ? `Auto (${task.segments?.length || 8})` : task.connections}
                          </td>
                        );
                      case 'crc32':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-indigo-400 font-semibold truncate text-start" style={{ width }}>
                            {task.status === 'completed' ? 'E89FA21B' : '--'}
                          </td>
                        );
                      case 'priority':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-sans text-[11px] truncate text-start" style={{ width }}>
                            <span className={`px-2 py-0.5 rounded-md text-[9px] font-bold ${
                              task.queueId === 'fast' ? 'bg-red-500/10 text-red-500 border border-red-500/20' :
                              task.queueId === 'night' ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20' :
                              'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                            }`}>
                              {task.queueId === 'fast' ? 'High' : task.queueId === 'night' ? 'Low' : 'Normal'}
                            </span>
                          </td>
                        );
                      case 'completedDate':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)] truncate" style={{ width, direction: 'ltr', textAlign: isRtl ? 'right' : 'left' }}>
                            {task.status === 'completed' ? task.dateAdded : '--'}
                          </td>
                        );
                      case 'sourceUrl':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)] truncate text-left" style={{ width, direction: 'ltr' }} title={task.url}>
                            {task.url}
                          </td>
                        );
                      case 'smartCategory':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-sans text-[11px] truncate text-start" style={{ width }}>
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-[var(--accent-light)] text-[var(--accent-primary)]">
                              {getFileTypeIcon(task.fileType, "w-3 h-3")}
                              <span>
                                {task.fileType === 'program' ? 'Programs' :
                                 task.fileType === 'compressed' ? 'Archives' :
                                 task.fileType === 'video' ? 'Video' :
                                 task.fileType === 'audio' ? 'Audio' :
                                 task.fileType === 'document' ? 'Documents' : 'Other'}
                              </span>
                            </span>
                          </td>
                        );
                      default:
                        return null;
                    }
                  })}

                  {/* Settings columns stub (Sticky Right in LTR) */}
                  <td className="px-2 py-1 text-center bg-[var(--bg-app)]/90 backdrop-blur-md sticky ltr:right-0 rtl:left-0 z-10 ltr:border-l rtl:border-r border-[var(--border-color)]" style={{ width: '48px', minWidth: '48px', maxWidth: '48px' }}>
                    {/* Empty cell to align with column customize button */}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {/* Mobile Card List View */}
      <div className="md:hidden p-3 space-y-3">
        {sortedTasks.length === 0 ? (
          <div className="py-12 text-center text-[var(--text-muted)] text-xs">
            {t('no_downloads')}
          </div>
        ) : (
          sortedTasks.map(task => {
            const progressPercent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;
            const isSelected = selectedTaskId === task.id;
            const isChecked = checkedTaskIds.has(task.id);

            return (
              <div 
                key={task.id}
                onMouseDown={(e) => startRowPress(task.id, e)}
                onMouseUp={(e) => endRowPress(task.id, e)}
                onMouseLeave={cancelRowPress}
                onTouchStart={(e) => startRowPress(task.id, e)}
                onTouchEnd={(e) => endRowPress(task.id, e)}
                onTouchMove={cancelRowPress}
                className={`p-3 rounded-lg border transition-all cursor-pointer select-none ${
                  isSelected 
                    ? 'bg-[var(--bg-selected)] border-[var(--accent-primary)] shadow-sm' 
                    : 'bg-[var(--bg-sidebar)] border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
                } ${isChecked ? 'bg-[var(--accent-primary)]/5 border-[var(--accent-primary)]' : ''}`}
              >
                {/* Header: icon, title, and status */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <TaskCheckboxAndIcon 
                      isChecked={isChecked}
                      fileType={task.fileType}
                      taskId={task.id}
                      handleToggleCheckTask={handleToggleCheckTask}
                      getFileTypeIcon={getFileTypeIcon}
                      hasSelection={checkedTaskIds.size > 0}
                    />
                    <span className="font-bold text-xs truncate max-w-[180px] text-[var(--text-primary)] font-mono text-left" style={{ direction: 'ltr' }}>
                      {task.name}
                    </span>
                  </div>
                  <StatusPill status={task.status} />
                </div>

                {/* Progress bar */}
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden border border-[var(--border-color)]">
                    <div 
                      className={`h-full bg-[var(--accent-primary)] rounded-full transition-all duration-300 ${task.status === 'downloading' ? 'accent-glow relative overflow-hidden' : ''}`}
                      style={{ width: `${progressPercent}%` }}
                    >
                      {task.status === 'downloading' && (
                        <div className="absolute inset-0 bg-white/20 animate-pulse" />
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] text-[var(--text-secondary)] font-mono font-bold">{progressPercent}%</span>
                </div>

                {/* Stats row */}
                <div className="mt-2.5 flex flex-wrap justify-between text-[10px] text-[var(--text-secondary)] font-mono">
                  <span>Size: {formatBytes(task.sizeBytes)}</span>
                  {task.status === 'downloading' && (
                    <span className="text-emerald-500 font-bold">Speed: {formatSpeed(task.speedBytesPerSec)}</span>
                  )}
                  {task.status === 'downloading' && (
                    <span className="text-blue-400">Left: {formatTimeLeft(task.timeLeftSeconds)}</span>
                  )}
                </div>

                {/* Mobile actions footer */}
                <div className="mt-3 pt-2.5 border-t border-[var(--border-color)] flex justify-end items-center gap-1.5">
                  {task.status === 'downloading' ? (
                    <button 
                      onClick={(e) => { e.stopPropagation(); pauseTask(task.id); }}
                      className="px-2 py-1 text-[10px] font-semibold bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded hover:bg-amber-500/20 transition-all cursor-pointer"
                    >
                      Pause
                    </button>
                  ) : task.status === 'paused' || task.status === 'error' ? (
                    <button 
                      onClick={(e) => { e.stopPropagation(); resumeTask(task.id); }}
                      className="px-2 py-1 text-[10px] font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded hover:bg-emerald-500/20 transition-all cursor-pointer"
                    >
                      Resume
                    </button>
                  ) : null}
                  <button 
                    onClick={(e) => { e.stopPropagation(); openDialog('taskProperties', task); }}
                    className="px-2 py-1 text-[10px] font-semibold bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)] transition-all cursor-pointer"
                  >
                    Properties
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); openDialog('confirmDelete', task); }}
                    className="px-2 py-1 text-[10px] font-semibold bg-red-500/10 border border-red-500/20 text-red-500 rounded hover:bg-red-500/20 transition-all cursor-pointer"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* COLUMN CONFIG DROPDOWN PANEL */}
      {showColConfig && (
        <div 
          ref={colConfigRef}
          className="absolute left-3 top-10 z-[100] w-64 p-3 bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] rounded-lg shadow-xl space-y-2 animate-in fade-in duration-100"
        >
          <div className="border-b border-[var(--border-color)] pb-1.5 mb-1">
            <h4 className="text-xs font-bold text-[var(--accent-primary)]">Customize & Reorder Columns</h4>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Drag columns to reorder or toggle visibility</p>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {colOrder.map(colKey => {
              const label = columnLabels[colKey] || colKey;
              const isDragging = draggingCustomizeCol === colKey;

              return (
                <div 
                  key={colKey}
                  draggable="true"
                  onDragStart={(e) => handleCustomizeDragStart(e, colKey)}
                  onDragOver={(e) => handleCustomizeDragOver(e, colKey)}
                  onDrop={(e) => handleCustomizeDrop(e, colKey)}
                  onDragEnd={handleCustomizeDragEnd}
                  className={`flex items-center gap-2 p-1.5 rounded text-[11px] font-semibold border transition-all ${
                    isDragging 
                      ? 'opacity-40 border-dashed border-[var(--accent-primary)] bg-[var(--bg-hover)]' 
                      : 'border-transparent bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)]'
                  } ${
                    colKey === 'name' 
                      ? 'cursor-default' 
                      : 'cursor-grab active:cursor-grabbing'
                  }`}
                >
                  <input 
                    type="checkbox" 
                    checked={visibleCols[colKey] || false} 
                    disabled={colKey === 'name'} 
                    onChange={() => colKey !== 'name' && setVisibleCols(prev => ({ ...prev, [colKey]: !prev[colKey] }))}
                    className="rounded border-[var(--border-color)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer disabled:opacity-40"
                  />
                  
                  {/* Grip Icon */}
                  {colKey !== 'name' && (
                    <GripVertical className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                  )}
                  
                  <span className="flex-1 truncate">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
};
