/* src/dialogs/Modal.tsx */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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

      // App title bar height (px) — keeps dialogs below the drag region.
      const APP_TITLEBAR = 32;
      // Status bar at the bottom (approx).
      const APP_STATUSBAR = 28;
      // Side margin so dialog never bleeds out of the frame.
      const MARGIN = 8;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dw = dialogSizeRef.current.w || 540;
      const dh = dialogSizeRef.current.h || 400;

      // Usable area inside the app frame (excluding title bar & status bar).
      const usableH = vh - APP_TITLEBAR - APP_STATUSBAR;
      const usableW = vw;

      // Max translation from center (dialogs start centered at 0,0).
      // Positive X = right, positive Y = down.
      const halfDW = dw / 2;
      const halfDH = dh / 2;

      // Horizontal: dialog must stay fully inside left/right edges with margin.
      const maxX = Math.max(0, usableW / 2 - halfDW - MARGIN);

      // Vertical: center of overlay sits at (APP_TITLEBAR + usableH/2).
      // We need the dialog top edge >= APP_TITLEBAR + MARGIN
      //   ? center.y + offsetY - halfDH >= APP_TITLEBAR + MARGIN
      //   ? offsetY >= APP_TITLEBAR + MARGIN + halfDH - (APP_TITLEBAR + usableH/2)
      //   ? offsetY >= halfDH - usableH/2 + MARGIN
      const minY = halfDH - usableH / 2 + MARGIN;
      // Dialog bottom edge <= vh - APP_STATUSBAR - MARGIN
      const maxY = usableH / 2 - halfDH - MARGIN;

      const clampedX = Math.max(-maxX, Math.min(newX, maxX));
      const clampedY = Math.max(minY, Math.min(newY, maxY));
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
    sm: 'max-w-xs w-11/12 md:max-w-[340px]',
    md: 'max-w-md w-11/12 md:max-w-[440px]',
    lg: 'max-w-lg w-11/12 md:max-w-[540px]',
    xl: 'max-w-4xl w-11/12 md:max-w-[760px]',
    full: 'max-w-full h-full',
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
      role={role}
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        id={id}
        ref={modalRef}
        tabIndex={-1}
        style={{
          transform: `translate(${String(position.x)}px, ${String(position.y)}px)`,
          transition: dragging ? 'none' : 'transform 0.05s ease-out',
        }}
        className={`bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] rounded-lg border-2 border-[var(--border-color)] shadow-2xl flex flex-col focus:outline-none overflow-hidden modal-content pointer-events-auto max-h-full ${sizeStyles[size]}`}
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
              id="modal-title"
              className="text-[11px] font-bold text-[var(--text-primary)] font-sans tracking-wide truncate"
              style={{ direction: 'ltr' }}
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
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Modal content area */}
        <div className="flex-1 overflow-y-auto p-3 bg-[var(--bg-surface-elevated)]">{children}</div>
      </div>
    </div>
  );
};
