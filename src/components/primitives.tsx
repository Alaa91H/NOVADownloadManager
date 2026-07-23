/* src/components/primitives.tsx */
import type { ReactNode } from 'react';
import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../store/selectors';
import type { DownloadStatus } from '../types/desktop-ui.types';

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

  const { title, disabled, ...rest } = props;
  const resolvedTitle = disabled && disabledTooltip ? disabledTooltip : title;

  return (
    <button
      className={`${baseStyle} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      title={resolvedTitle}
      aria-disabled={disabled ? true : undefined}
      {...rest}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}
      <span>{children}</span>
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
export const TextField: React.FC<TextFieldProps> = ({
  label,
  error,
  icon: Icon,
  onIconClick,
  id,
  className = '',
  ...props
}) => {
  return (
    <div className="flex flex-col gap-0.5 w-full text-ui">
      {label && (
        <label htmlFor={id} className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {Icon &&
          (onIconClick ? (
            <button
              type="button"
              onClick={onIconClick}
              className="absolute right-2.5 flex h-8 w-8 items-center justify-center text-[var(--text-muted)] focus:outline-none"
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          ) : (
            <Icon className="absolute right-2.5 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none" />
          ))}
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

// --- StatusPill ---
interface StatusPillProps {
  status: DownloadStatus;
  engineStatus?: string;
}

const ENGINE_STATUS_LABELS: Record<string, string> = {
  'resolving-url': 'Resolving URL...',
  starting: 'Starting...',
  'running-libcurl-multi': '',
  'resume-requested': 'Resuming...',
  'redownload-requested': 'Re-downloading...',
};

const StatusPillInner: React.FC<StatusPillProps> = ({ status, engineStatus }) => {
  const t = useI18n();
  const meta: Record<DownloadStatus, { bg: string; key: string }> = {
    downloading: {
      bg: 'bg-[var(--info-bg)] text-[var(--info)] border-[var(--info-border)]',
      key: 'status_downloading',
    },
    completed: {
      bg: 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success-border)]',
      key: 'status_completed',
    },
    paused: { bg: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]', key: 'status_paused' },
    // Transient states reuse the closest stable visual and label.
    pausing: {
      bg: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]',
      key: 'status_paused',
    },
    stopping: {
      bg: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]',
      key: 'status_paused',
    },
    queued: { bg: 'bg-[var(--bg-hover)] text-[var(--text-muted)] border-[var(--border-color)]', key: 'status_queued' },
    error: { bg: 'bg-[var(--danger-bg)] text-[var(--danger)] border-[var(--danger-border)]', key: 'status_error' },
  };
  const config = meta[status];
  const subtitle =
    status === 'downloading' && engineStatus ? ENGINE_STATUS_LABELS[engineStatus] ?? '' : '';

  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <span
        className={`inline-flex items-center px-2 py-0.5 text-[10px] md:text-xs font-medium rounded-md border ${config.bg}`}
      >
        {t(config.key)}
      </span>
      {subtitle ? (
        <span className="text-[9px] text-[var(--text-muted)] leading-none">{subtitle}</span>
      ) : null}
    </span>
  );
};

export const StatusPill = React.memo(StatusPillInner);
