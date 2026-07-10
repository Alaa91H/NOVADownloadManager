/* src/dialogs/Modal.tsx */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { X } from 'lucide-react';
import { Logo } from '../components/Logo';
import { useAppStore } from '../state/appStore';
import { type DownloadItem } from '../types/desktop-ui.types';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  role?: 'dialog' | 'alertdialog';
  id?: string;
  preventLightDismiss?: boolean;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  role = 'dialog',
  id,
  preventLightDismiss = false,
}) => {
  const { dialog, minimizeActiveProgressToTaskbar, t } = useAppStore();
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const handleMinimizeToTaskbar = () => {
    if (id === 'active-progress-modal') {
      const task = dialog.payload as DownloadItem | null;
      if (task) {
        if (isTauri()) {
          void getCurrentWindow()
            .hide()
            .catch(() => {
              minimizeActiveProgressToTaskbar(task);
            });
          return;
        }
        minimizeActiveProgressToTaskbar(task);
      }
    }
  };

  // Dragging state — `dragging` drives rendering, `isDragging` is read inside
  // window-level mouse handlers without re-subscribing them.
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const [isMaximized, setIsMaximized] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);

  // Reset position and minimized state when modal opens or when maximized
  // toggled, adjusting during render instead of in an effect.
  const [prevReset, setPrevReset] = useState({ isOpen, isMaximized });
  if (prevReset.isOpen !== isOpen || prevReset.isMaximized !== isMaximized) {
    setPrevReset({ isOpen, isMaximized });
    if (isOpen) {
      setPosition({ x: 0, y: 0 });
      setIsMinimized(false);
    }
  }

  const handleCloseAttempt = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // Only left click
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('select') || target.closest('a')) {
      return;
    }

    isDragging.current = true;
    setDragging(true);
    dragStart.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    document.body.classList.add('select-none');
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const newX = e.clientX - dragStart.current.x;
      const newY = e.clientY - dragStart.current.y;
      setPosition({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        setDragging(false);
        document.body.classList.remove('select-none');
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Focus trap & escape key handler
  useEffect(() => {
    if (isOpen) {
      previousFocus.current = document.activeElement as HTMLElement;
      modalRef.current?.focus();

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          if (preventLightDismiss) return;
          handleCloseAttempt();
        }

        // Trap focus
        if (e.key === 'Tab' && modalRef.current) {
          const focusables = modalRef.current.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex="0"]',
          );
          if (focusables.length === 0) return;
          const first = focusables[0] as HTMLElement;
          const last = focusables[focusables.length - 1] as HTMLElement;

          if (e.shiftKey) {
            if (document.activeElement === first) {
              last.focus();
              e.preventDefault();
            }
          } else {
            if (document.activeElement === last) {
              first.focus();
              e.preventDefault();
            }
          }
        }
      };

      // Close when clicking outside the modal on the main interface
      const handleOutsideClick = (e: MouseEvent) => {
        if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
          if (preventLightDismiss) return;
          // Check if we are clicking on some modal launcher button or a toast to prevent immediate close conflicts
          const target = e.target as HTMLElement;
          if (target.closest('.toast-container') || target.closest('[data-dialog-trigger]')) {
            return;
          }
          handleCloseAttempt();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      // Delayed attachment to avoid capturing the trigger click that opens the modal
      const clickTimer = setTimeout(() => {
        document.addEventListener('mousedown', handleOutsideClick);
      }, 50);

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('mousedown', handleOutsideClick);
        clearTimeout(clickTimer);
        previousFocus.current?.focus();
      };
    }
  }, [isOpen, handleCloseAttempt, preventLightDismiss]);

  if (!isOpen) return null;

  const sizeStyles = {
    sm: 'max-w-xs w-11/12 md:max-w-[340px]',
    md: 'max-w-md w-11/12 md:max-w-[440px]',
    lg: 'max-w-lg w-11/12 md:max-w-[540px]',
    xl: 'max-w-4xl w-11/12 md:max-w-[760px]',
    full: 'max-w-full h-full',
  };

  return (
    <div
      id={id ? `${id}-overlay` : undefined}
      className="fixed inset-0 z-50 flex items-center justify-center p-2 overflow-y-auto pointer-events-none bg-transparent transition-all duration-300"
      role={role}
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        id={id}
        ref={modalRef}
        tabIndex={-1}
        style={{
          transform: isMinimized
            ? 'none'
            : isMaximized
              ? 'none'
              : `translate(${String(position.x)}px, ${String(position.y)}px)`,
          transition: dragging ? 'none' : 'transform 0.05s ease-out',
        }}
        className={`bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] rounded-md border border-[var(--border-color)] shadow-2xl flex flex-col focus:outline-none overflow-hidden transition-all duration-200 pointer-events-auto ${
          isMinimized
            ? 'fixed bottom-4 left-4 w-72 h-[30px] shadow-2xl border border-[var(--accent-primary)]/40 rounded-lg animate-bounce'
            : isMaximized
              ? 'fixed inset-3 w-[calc(100%-1.5rem)] h-[calc(100%-1.5rem)] max-w-none max-h-none rounded-md'
              : `max-h-[95vh] ${sizeStyles[size]}`
        }`}
      >
        {/* Desktop-Style Windows Title Bar */}
        <div
          onMouseDown={isMaximized || isMinimized ? undefined : handleMouseDown}
          onClick={
            isMinimized
              ? () => {
                  setIsMinimized(false);
                }
              : undefined
          }
          className={`flex items-center justify-between px-2 py-1 select-none bg-[var(--bg-surface-elevated)] border-b border-[var(--border-color)] ${
            isMinimized
              ? 'cursor-pointer hover:bg-[var(--bg-hover)]'
              : isMaximized
                ? 'cursor-default'
                : 'cursor-move active:cursor-grabbing'
          }`}
        >
          {/* Left Side: Logo and Title */}
          <div className="flex items-center gap-1.5 min-w-0">
            {id === 'active-progress-modal' ? (
              <svg
                className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ animation: 'spin 12s linear infinite' }}
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                <path d="M2 12h20" />
              </svg>
            ) : (
              <Logo size={14} className="shrink-0 filter drop-shadow-sm animate-pulse" />
            )}
            <h3
              id="modal-title"
              className="text-[10px] md:text-[11px] font-bold text-[var(--text-primary)] font-sans tracking-wide truncate select-all"
              style={{ direction: 'ltr' }}
            >
              {isMinimized ? `${t('modal_minimized_prefix')} ${title}` : title}
            </h3>
          </div>

          {/* Right Side: Windows-Style Window Controls (Ordered: Minimize, Maximize, Close) */}
          <div
            className="flex items-center gap-0.5"
            style={{ direction: 'ltr' }}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            {id === 'active-progress-modal' && (
              <button
                onClick={handleMinimizeToTaskbar}
                className="w-7 h-5 flex items-center justify-center hover:bg-slate-800 text-emerald-500 hover:text-emerald-400 transition-colors cursor-pointer shrink-0"
                title={t('modal_minimize_taskbar')}
              >
                <svg
                  className="w-3 h-3 animate-pulse"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            )}
            {/* Minimize Button */}
            <button
              onClick={() => {
                setIsMinimized(!isMinimized);
              }}
              className={`w-7 h-5 flex items-center justify-center hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer ${isMinimized ? 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20' : ''}`}
              title={isMinimized ? t('modal_restore') : t('win_minimize')}
            >
              <span className="block w-1.5 h-[1.2px] bg-current" />
            </button>
            {/* Maximize / Restore Button */}
            {!isMinimized && (
              <button
                onClick={() => {
                  setIsMaximized(!isMaximized);
                }}
                className="w-7 h-5 flex items-center justify-center hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                title={isMaximized ? t('modal_restore_size') : t('win_maximize')}
              >
                <span className="block w-1.5 h-1.5 border-[1.2px] border-current rounded-xs" />
              </button>
            )}
            {/* Close Button */}
            <button
              onClick={handleCloseAttempt}
              className="w-7 h-5 flex items-center justify-center hover:bg-red-600 text-slate-400 hover:text-white transition-colors cursor-pointer"
              title={t('btn_close')}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        </div>

        {/* Modal content area - hidden when minimized */}
        {!isMinimized && (
          <div className="flex-1 overflow-y-auto p-2.5 md:p-3 bg-[var(--bg-surface-elevated)]">{children}</div>
        )}
      </div>
    </div>
  );
};
