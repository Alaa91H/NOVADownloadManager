import React, { useEffect, useRef } from 'react';

export interface ContextMenuOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
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

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

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
      >
        {options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => {
              opt.onClick();
              onClose();
            }}
            className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors cursor-pointer ${
              opt.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {opt.icon && <span className="w-4 h-4 shrink-0 flex items-center justify-center">{opt.icon}</span>}
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
    </>
  );
};
