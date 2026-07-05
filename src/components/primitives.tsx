/* src/components/primitives.tsx */
import React, { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

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
      className={`acrylic-card glass-panel density-p ${onClick ? 'cursor-pointer select-none active:scale-[0.99]' : ''} ${className}`}
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
}
export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'secondary',
  icon: Icon,
  size = 'md',
  className = '',
  ...props
}) => {
  const baseStyle =
    'interactive-btn inline-flex items-center gap-2 font-medium justify-center transition-all disabled:opacity-50 disabled:pointer-events-none';

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
    danger: 'bg-red-600 hover:bg-red-700 text-white shadow-sm',
  };

  return (
    <button className={`${baseStyle} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`} {...props}>
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
      className={`interactive-btn flex items-center justify-center transition-all ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      {...props}
    >
      <Icon className="w-3.5 h-3.5 md:w-4 h-4" />
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
  id?: string;
}
export const TextField: React.FC<TextFieldProps> = ({ label, error, icon: Icon, id, className = '', ...props }) => {
  return (
    <div className="flex flex-col gap-0.5 w-full text-ui">
      {label && (
        <label htmlFor={id} className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {Icon && <Icon className="absolute right-2.5 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none" />}
        <input
          id={id}
          className={`w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-[11px] md:text-xs transition-all focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] focus:outline-none ${Icon ? 'pr-8 pl-2.5' : 'px-2.5'} py-1 md:py-1.25 ${error ? 'border-red-500 focus:border-red-500' : ''} ${className}`}
          {...props}
        />
      </div>
      {error && <span className="text-red-500 text-[9px] mt-0.5">{error}</span>}
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
        className={`w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-[11px] md:text-xs transition-all focus:border-[var(--accent-primary)] focus:outline-none px-2 py-1 md:py-1.25 cursor-pointer ${className}`}
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
}
export const Switch: React.FC<SwitchProps> = ({ checked, onChange, label, id }) => {
  return (
    <label
      id={id}
      className={`inline-flex items-center justify-between gap-2.5 cursor-pointer select-none text-ui ${label ? 'w-full' : ''}`}
    >
      {label && <span className="text-[var(--text-secondary)] text-[11px] font-semibold">{label}</span>}
      <div
        onClick={() => {
          onChange(!checked);
        }}
        className={`relative w-8 h-4.5 rounded-full transition-colors duration-200 ${checked ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-color-hover)]'}`}
      >
        <span
          className={`absolute top-0.5 right-0.5 bg-white w-3.5 h-3.5 rounded-full transition-transform duration-200 shadow-sm ${checked ? '-translate-x-3.5' : 'translate-x-0'}`}
        />
      </div>
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
        className={`w-3.5 h-3.5 rounded border-[var(--border-color)] text-[var(--accent-primary)] bg-[var(--bg-input)] focus:ring-[var(--accent-primary)] focus:ring-offset-0 cursor-pointer ${className}`}
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
            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-all cursor-pointer ${
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
  status: 'downloading' | 'completed' | 'paused' | 'queued' | 'error';
}
export const StatusPill: React.FC<StatusPillProps> = ({ status }) => {
  const meta = {
    downloading: { bg: 'bg-blue-500/10 text-blue-500 border-blue-500/20', text: 'Downloading' },
    completed: { bg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', text: 'Completed' },
    paused: { bg: 'bg-amber-500/10 text-amber-500 border-amber-500/20', text: 'Paused' },
    queued: { bg: 'bg-slate-500/10 text-slate-400 border-slate-500/20', text: 'Queued' },
    error: { bg: 'bg-rose-500/10 text-rose-500 border-rose-500/20', text: 'Error' },
  };
  const config = meta[status];

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] md:text-xs font-medium rounded-md border ${config.bg}`}
    >
      {config.text}
    </span>
  );
};

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
      <div className="relative w-full h-2 md:h-2.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden border border-[var(--border-color)]">
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
