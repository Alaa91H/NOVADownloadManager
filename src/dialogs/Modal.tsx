/* src/dialogs/Modal.tsx */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Logo } from '../components/Logo';
import { useI18n } from '../store/selectors';

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
  const t = useI18n();
  const generatedTitleId = useId();
  const titleId = id ? `${id}-title` : generatedTitleId;
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // Dragging state — `dragging` drives rendering, `isDragging` is read inside
  // window-level mouse handlers without re-subscribing them.
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dialogSizeRef = useRef({ w: 0, h: 0 });

  // Reset position when the modal opens.
  const [prevOpen, setPrevOpen] = useState(isOpen);
  if (prevOpen !== isOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      setPosition({ x: 0, y: 0 });
    }
  }

  const handleCloseAttempt = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('select') || target.closest('a')) {
      return;
    }

    // Capture dialog size for clamping
    if (modalRef.current) {
      const rect = modalRef.current.getBoundingClientRect();
      dialogSizeRef.current = { w: rect.width, h: rect.height };
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

      // The overlay starts below the app title bar and provides its own margin.
      // Keep a dragged dialog inside that live viewport rather than relying on a
      // fixed status-bar estimate that becomes wrong after window resizing.
      const APP_TITLEBAR = 32;
      const MARGIN = 8;
      const usableW = Math.max(0, window.innerWidth - MARGIN * 2);
      const usableH = Math.max(0, window.innerHeight - APP_TITLEBAR - MARGIN * 2);
      const halfDW = (dialogSizeRef.current.w || 540) / 2;
      const halfDH = (dialogSizeRef.current.h || 400) / 2;
      const maxX = Math.max(0, usableW / 2 - halfDW);
      const maxY = Math.max(0, usableH / 2 - halfDH);

      const clampedX = Math.max(-maxX, Math.min(newX, maxX));
      const clampedY = Math.max(-maxY, Math.min(newY, maxY));
      setPosition({ x: clampedX, y: clampedY });
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
          const focusables = Array.from(
            modalRef.current.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const activeElement = document.activeElement as HTMLElement | null;

          // The dialog receives focus when it opens. Explicitly route the
          // first Tab from that container so Shift+Tab cannot escape to the
          // browser chrome or an element behind the overlay.
          if (activeElement === modalRef.current || !modalRef.current.contains(activeElement)) {
            (e.shiftKey ? last : first).focus();
            e.preventDefault();
          } else if (e.shiftKey && activeElement === first) {
            last.focus();
            e.preventDefault();
          } else if (!e.shiftKey && activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      };

      // Close when clicking outside the modal on the main interface
      const handleOutsideClick = (e: MouseEvent) => {
        if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
          if (preventLightDismiss) return;
          const target = e.target as HTMLElement;
          if (target.closest('.toast-container') || target.closest('[data-dialog-trigger]')) {
            return;
          }
          handleCloseAttempt();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
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
    sm: 'w-full max-w-xs sm:max-w-[340px]',
    md: 'w-full max-w-md sm:max-w-[440px]',
    lg: 'w-full max-w-lg sm:max-w-[540px]',
    xl: 'w-full max-w-4xl sm:max-w-[760px]',
    full: 'w-full h-full max-w-none',
  };

  return (
    <div
      id={id ? `${id}-overlay` : undefined}
      className="fixed z-50 flex items-center justify-center overflow-hidden pointer-events-none bg-black/50 modal-overlay"
      style={{
        /* Sit exactly inside the app frame: below the 32px title bar on all sides */
        top: '32px',
        left: 0,
        right: 0,
        bottom: 0,
        padding: '8px',
      }}
    >
      <div
        id={id}
        ref={modalRef}
        tabIndex={-1}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          transform: `translate(${String(position.x)}px, ${String(position.y)}px)`,
          transition: dragging ? 'none' : 'transform 0.05s ease-out',
          maxHeight: 'calc(100dvh - 48px)',
        }}
        className={`bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] rounded-lg border-2 border-[var(--border-color)] shadow-2xl flex flex-col focus:outline-none overflow-hidden modal-content pointer-events-auto min-h-0 ${sizeStyles[size]}`}
      >
        {/* Desktop-Style Title Bar */}
        <div
          onMouseDown={handleMouseDown}
          className="flex items-center justify-between px-3 py-1.5 select-none bg-[var(--bg-sidebar)] border-b-2 border-[var(--border-color)] cursor-move active:cursor-grabbing shrink-0"
        >
          {/* Left Side: Icon and Title */}
          <div className="flex items-center gap-2 min-w-0">
            {id === 'active-progress-modal' ? (
              <svg
                className="w-3.5 h-3.5 text-[var(--success)] shrink-0"
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
              <Logo size={14} className="shrink-0" />
            )}
            <h3
              id={titleId}
              className="text-[11px] font-bold text-[var(--text-primary)] font-sans tracking-wide truncate"
              dir="auto"
            >
              {title}
            </h3>
          </div>

          {/* Right Side: Close button only */}
          <div
            className="flex items-center"
            style={{ direction: 'ltr' }}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <button
              onClick={handleCloseAttempt}
              className="w-7 h-6 flex items-center justify-center rounded hover:bg-[var(--danger)] text-[var(--text-secondary)] hover:text-white transition-colors cursor-pointer"
              title={t('btn_close')}
              aria-label={t('btn_close')}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Modal content area */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 bg-[var(--bg-surface-elevated)]">
          {children}
        </div>
      </div>
    </div>
  );
};
