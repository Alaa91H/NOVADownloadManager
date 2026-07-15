/* src/components/primitives.tsx */
import type { ReactNode } from 'react';
import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../store/selectors';
import type { DownloadStatus } from '../types/desktop-ui.types';

// --- Card primitive ---
interface CardProps {
  children: ReactNode;
  className?: string;
  id?: string;
  onClick?: () => void;
}
export const Card: React.FC<CardProps> = ({ children, className = '', id, onClick }) => {
  return (
    <div
      id={id}
      onClick={onClick}
      className={`acrylic-card density-p ${onClick ? 'cursor-pointer select-none active:scale-[0.99]' : ''} ${className}`}
    >
      {children}
    </div>
  );
};

// --- Button Primitives ---
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
  icon?: LucideIcon;
  size?: 'sm' | 'md' | 'lg';
  disabledTooltip?: string;
}
export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'secondary',
  icon: Icon,
  size = 'md',
  className = '',
  disabledTooltip,
  ...props
}) => {
  const baseStyle =
    'interactive-btn inline-flex items-center gap-2 font-medium justify-center transition-all disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-surface-elevated)]';

  const sizeStyles = {
    sm: 'px-2 py-0.5 text-[10px] md:text-[11px] rounded-md font-semibold',
    md: 'px-2.5 py-1 text-xs rounded-md font-semibold',
    lg: 'px-4 py-1.5 text-xs md:text-sm rounded-md font-bold',
  };

  const variantStyles = {
    primary:
      'bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white shadow-sm hover:shadow accent-glow border border-[var(--accent-border)]',
    secondary:
      'bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--border-color-hover)] border border-[var(--border-color)]',
    ghost: 'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
    outline: 'border border-[var(--accent-primary)] text-[var(--accent-primary)] hover:bg-[var(--accent-light)]',
    danger: 'bg-[var(--danger)] hover:bg-[var(--danger-hover)] text-white shadow-sm',
  };

  return (
    <button
      className={`${baseStyle} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      title={props.disabled && disabledTooltip ? disabledTooltip : props.title}
      aria-disabled={props.disabled ? true : undefined}
      {...props}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}
      <span>{children}</span>
    </button>
  );
};

// --- IconButton ---
interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'ghost';
  tooltip?: string;
}
export const IconButton: React.FC<IconButtonProps> = ({
  icon: Icon,
  size = 'md',
  variant = 'ghost',
  tooltip,
  className = '',
  ...props
}) => {
  const sizeStyles = {
    sm: 'p-0.5 rounded-sm',
    md: 'p-1 md:p-1.5 rounded-md',
    lg: 'p-2 rounded-lg',
  };

  const variantStyles = {
    primary:
      'bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)] border border-[var(--accent-border)] shadow-sm',
    secondary:
      'bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--border-color-hover)] border border-[var(--border-color)]',
    ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
  };

  return (
    <button
      title={tooltip}
      aria-label={tooltip}
      className={`interactive-btn flex items-center justify-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-surface-elevated)] ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      {...props}
    >
      <Icon className="w-3.5 h-3.5 md:w-4 md:h-4" />
    </button>
  );
};

// --- DialogButton (Specifically styled with responsive flex layouts) ---
export const DialogButton: React.FC<ButtonProps> = (props) => {
  return <Button className="min-w-[80px] shadow-sm" {...props} />;
};

// --- TextField ---
interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  icon?: LucideIcon;
  onIconClick?: () => void;
  id?: string;
}
export const TextField: React.FC<TextFieldProps> = ({ label, error, icon: Icon, onIconClick, id, className = '', ...props }) => {
  return (
    <div className="flex flex-col gap-0.5 w-full text-ui">
      {label && (
        <label htmlFor={id} className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {Icon && (
          onIconClick ? (
            <button
              type="button"
              onClick={onIconClick}
              className="absolute right-2.5 flex h-8 w-8 items-center justify-center text-[var(--text-muted)] focus:outline-none"
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          ) : (
            <Icon className="absolute right-2.5 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none" />
          )
        )}
        <input
          id={id}
          className={`w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-[11px] md:text-xs transition-all focus:border-[var(--accent-primary)] focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] focus-visible:outline-none ${Icon ? 'pr-10 pl-2.5' : 'px-2.5'} py-1 md:py-1.25 ${error ? 'border-[var(--danger)] focus:border-[var(--danger)]' : ''} ${className}`}
          {...props}
        />
      </div>
      {error && <span className="text-[var(--danger)] text-[9px] mt-0.5">{error}</span>}
    </div>
  );
};

// --- SelectField ---
interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Array<{ value: string | number; label: string }>;
  id?: string;
}
export const SelectField: React.FC<SelectFieldProps> = ({ label, options, id, className = '', ...props }) => {
  return (
    <div className="flex flex-col gap-0.5 w-full text-ui">
      {label && (
        <label htmlFor={id} className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">
          {label}
        </label>
      )}
      <select
        id={id}
        className={`w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-[11px] md:text-xs transition-all focus:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] px-2 py-1 md:py-1.25 cursor-pointer ${className}`}
        {...props}
      >
        {options.map((opt) => (
          <option
            key={opt.value}
            value={opt.value}
            className="bg-[var(--bg-surface-elevated)] text-[var(--text-primary)]"
          >
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
};

// --- Switch ---
interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  id?: string;
  disabled?: boolean;
}
export const Switch: React.FC<SwitchProps> = ({ checked, onChange, label, id, disabled = false }) => {
  return (
    <label
      id={id}
      className={`inline-flex items-center justify-between gap-2.5 ${disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'} select-none text-ui ${label ? 'w-full' : ''}`}
    >
      {label && <span className="text-[var(--text-secondary)] text-[11px] font-semibold">{label}</span>}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => {
          if (disabled) return;
          onChange(!checked);
        }}
        disabled={disabled}
        className={`relative w-8 h-4.5 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-surface-elevated)] ${checked ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-color-hover)]'}`}
      >
        <span
          className={`absolute top-0.5 bg-white w-3.5 h-3.5 rounded-full transition-transform duration-200 shadow-sm ${checked ? 'right-0.5 -translate-x-3.5' : 'right-0.5 translate-x-0'}`}
        />
      </button>
    </label>
  );
};

// --- Checkbox ---
interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
}
export const Checkbox: React.FC<CheckboxProps> = ({ label, checked, onChange, id, className = '', ...props }) => {
  return (
    <label id={id} className="inline-flex items-center gap-1.5 cursor-pointer select-none text-ui">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
        className={`w-3.5 h-3.5 rounded border-[var(--border-color)] text-[var(--accent-primary)] bg-[var(--bg-input)] focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-0 cursor-pointer ${className}`}
        {...props}
      />
      <span className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors text-[11px] font-semibold">
        {label}
      </span>
    </label>
  );
};

// --- FormRow ---
interface FormRowProps {
  label: string;
  children: ReactNode;
  id?: string;
}
export const FormRow: React.FC<FormRowProps> = ({ label, children, id }) => {
  return (
    <div id={id} className="flex flex-col gap-1.5 border-b border-[var(--border-color)]/50 py-2 density-py">
      <span className="text-[11px] md:text-xs font-bold text-[var(--text-secondary)] block w-full" dir="auto">
        {label}
      </span>
      <div className="w-full flex justify-start" dir="auto">
        {children}
      </div>
    </div>
  );
};

// --- Tabs ---
interface TabOption {
  id: string;
  label: string;
  icon?: LucideIcon;
}
interface TabsProps {
  options: TabOption[];
  activeId: string;
  onChange: (id: string) => void;
  id?: string;
}
export const Tabs: React.FC<TabsProps> = ({ options, activeId, onChange, id }) => {
  return (
    <div
      id={id}
      className="flex gap-1 bg-[var(--bg-hover)] p-1 rounded-lg border border-[var(--border-color)] overflow-x-auto"
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const isActive = opt.id === activeId;
        return (
          <button
            key={opt.id}
            onClick={() => {
              onChange(opt.id);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-surface-elevated)] ${
              isActive
                ? 'bg-[var(--bg-surface-elevated)] text-[var(--accent-primary)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
};

// --- SegmentedControl ---
export const SegmentedControl = Tabs;

// --- StatusPill ---
interface StatusPillProps {
  status: DownloadStatus;
}
const StatusPillInner: React.FC<StatusPillProps> = ({ status }) => {
  const t = useI18n();
  const meta: Record<DownloadStatus, { bg: string; key: string }> = {
    downloading: { bg: 'bg-[var(--info-bg)] text-[var(--info)] border-[var(--info-border)]', key: 'status_downloading' },
    completed: { bg: 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success-border)]', key: 'status_completed' },
    paused: { bg: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]', key: 'status_paused' },
    // Transient states reuse the closest stable visual and label.
    pausing: { bg: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]', key: 'status_paused' },
    stopping: { bg: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]', key: 'status_paused' },
    queued: { bg: 'bg-[var(--bg-hover)] text-[var(--text-muted)] border-[var(--border-color)]', key: 'status_queued' },
    error: { bg: 'bg-[var(--danger-bg)] text-[var(--danger)] border-[var(--danger-border)]', key: 'status_error' },
  };
  const config = meta[status];

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] md:text-xs font-medium rounded-md border ${config.bg}`}
    >
      {t(config.key)}
    </span>
  );
};

export const StatusPill = React.memo(StatusPillInner);

// --- ProgressBar ---
interface ProgressBarProps {
  progress: number;
  speedText?: string;
  showText?: boolean;
}
export const ProgressBar: React.FC<ProgressBarProps> = ({ progress, speedText, showText = true }) => {
  const boundedProgress = Math.max(0, Math.min(100, progress));
  return (
    <div className="w-full flex flex-col gap-1 text-ui">
      <div className="relative w-full h-2 md:h-2.5 bg-[var(--progress-track)] rounded-full overflow-hidden border border-[var(--border-color)]">
        <div
          className="absolute top-0 bottom-0 left-auto right-0 bg-[var(--accent-primary)] accent-glow rounded-full transition-all duration-300"
          style={{ width: `${String(boundedProgress)}%` }}
        />
      </div>
      {showText && (
        <div className="flex justify-between items-center text-[10px] text-[var(--text-muted)]">
          <span>{boundedProgress}%</span>
          {speedText && <span className="font-mono text-left">{speedText}</span>}
        </div>
      )}
    </div>
  );
};
