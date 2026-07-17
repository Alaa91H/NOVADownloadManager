import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface ContextMenuOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  options: ContextMenuOption[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, options, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => {
          let next = prev + 1;
          while (next < options.length && options[next].disabled) next++;
          return next >= options.length ? prev : next;
        });
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => {
          let next = prev - 1;
          while (next >= 0 && options[next].disabled) next--;
          return next < 0 ? prev : next;
        });
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setActiveIndex((prev) => {
          const opt = options[prev];
          if (!opt.disabled) {
            opt.onClick();
            onClose();
          }
          return prev;
        });
      }
    },
    [onClose, options],
  );

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, handleKeyDown]);

  useEffect(() => {
    const item = menuRef.current?.querySelector('[data-active="true"]') as HTMLElement | null;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const menuWidth = 190;
  const menuHeight = options.length * 36 + 8;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let posX = x;
  let posY = y;

  if (posX + menuWidth > viewportW) {
    posX = viewportW - menuWidth - 8;
  }
  if (posY + menuHeight > viewportH) {
    posY = viewportH - menuHeight - 8;
  }

  return (
    <>
      <div className="fixed inset-0 z-[100] cursor-default" onClick={onClose} />
      <div
        ref={menuRef}
        style={{ position: 'fixed', left: posX, top: posY, minWidth: menuWidth }}
        className="z-[101] bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] rounded-lg shadow-2xl py-1 animate-in fade-in slide-in-from-top-1 duration-100 font-bold"
        role="menu"
        aria-orientation="vertical"
      >
        {options.map((opt, i) => (
          <button
            key={opt.id}
            data-active={i === activeIndex ? 'true' : 'false'}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={opt.disabled}
            onClick={() => {
              if (!opt.disabled) {
                opt.onClick();
                onClose();
              }
            }}
            onMouseEnter={() => {
              if (!opt.disabled) setActiveIndex(i);
            }}
            className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-inset ${
              opt.danger
                ? 'text-[var(--danger)] hover:bg-[var(--danger-bg)]'
                : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            } ${i === activeIndex ? 'bg-[var(--bg-hover)]' : ''} ${opt.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {opt.icon && <span className="w-4 h-4 shrink-0 flex items-center justify-center">{opt.icon}</span>}
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
    </>
  );
};
