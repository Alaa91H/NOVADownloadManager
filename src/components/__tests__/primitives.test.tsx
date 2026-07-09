import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  Card,
  Button,
  IconButton,
  TextField,
  SelectField,
  Switch,
  Checkbox,
  FormRow,
  Tabs,
  StatusPill,
  ProgressBar,
} from '../primitives';
import { DownloadStatus } from '../../types/desktop-ui.types';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        status_downloading: 'Downloading',
        status_completed: 'Completed',
        status_paused: 'Paused',
        status_queued: 'Queued',
        status_error: 'Error',
      };
      return map[k] || k;
    },
  }),
}));

describe('Card', () => {
  it('renders children', () => {
    render(
      <Card>
        <div data-testid="child">Content</div>
      </Card>,
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Content');
  });

  it('applies custom className', () => {
    const { container } = render(
      <Card className="custom-class">
        <div>Content</div>
      </Card>,
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('renders with id', () => {
    render(
      <Card id="card-1">
        <div>Content</div>
      </Card>,
    );
    expect(document.getElementById('card-1')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(
      <Card onClick={onClick}>
        <div>Content</div>
      </Card>,
    );
    fireEvent.click(screen.getByText('Content'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click Me</Button>);
    expect(screen.getByText('Click Me')).toBeInTheDocument();
  });

  it('applies variant class', () => {
    const { container } = render(<Button variant="primary">Primary</Button>);
    expect(container.firstChild).toHaveClass('bg-[var(--accent-primary)]');
  });

  it('applies size class', () => {
    const { container } = render(<Button size="lg">Large</Button>);
    expect(container.firstChild).toHaveClass('px-4');
  });

  it('renders with icon', () => {
    const TestIcon = () => <svg data-testid="icon" />;
    const { container } = render(<Button icon={TestIcon as never}>With Icon</Button>);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('is disabled when disabled prop is set', () => {
    render(<Button disabled>Disabled</Button>);
    const button = screen.getByText('Disabled').closest('button') as HTMLElement;
    expect(button).toBeDisabled();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByText('Click'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies ghost variant', () => {
    const { container } = render(<Button variant="ghost">Ghost</Button>);
    expect(container.firstChild).toHaveClass('hover:bg-[var(--bg-hover)]');
  });

  it('applies danger variant', () => {
    const { container } = render(<Button variant="danger">Danger</Button>);
    expect(container.firstChild).toHaveClass('bg-red-600');
  });

  it('applies outline variant', () => {
    const { container } = render(<Button variant="outline">Outline</Button>);
    expect(container.firstChild).toHaveClass('border-[var(--accent-primary)]');
  });
});

describe('IconButton', () => {
  const TestIcon = (() => () => <svg />)() as React.ComponentType<{ size?: number; className?: string }>;

  it('renders icon', () => {
    const { container } = render(<IconButton icon={TestIcon as never} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders with tooltip', () => {
    render(<IconButton icon={TestIcon as never} tooltip="My Tooltip" />);
    expect(screen.getByTitle('My Tooltip')).toBeInTheDocument();
  });

  it('applies size classes', () => {
    const { container } = render(<IconButton icon={TestIcon as never} size="sm" />);
    expect(container.firstChild).toHaveClass('p-0.5');
  });

  it('applies variant classes', () => {
    const { container } = render(<IconButton icon={TestIcon as never} variant="primary" />);
    expect(container.firstChild).toHaveClass('bg-[var(--accent-primary)]');
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<IconButton icon={TestIcon as never} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('TextField', () => {
  it('renders input', () => {
    render(<TextField placeholder="Enter text" />);
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('renders label', () => {
    render(<TextField label="Username" id="username" />);
    expect(screen.getByText('Username')).toBeInTheDocument();
  });

  it('renders error message', () => {
    render(<TextField error="Required field" />);
    expect(screen.getByText('Required field')).toBeInTheDocument();
  });

  it('renders icon', () => {
    const TestIcon = () => <svg data-testid="input-icon" />;
    const { container } = render(<TextField icon={TestIcon as never} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('calls onChange when typing', () => {
    const onChange = vi.fn();
    render(<TextField onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new value' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('renders with value', () => {
    render(<TextField value="test value" readOnly />);
    expect(screen.getByDisplayValue('test value')).toBeInTheDocument();
  });

  it('applies error styling', () => {
    const { container } = render(<TextField error="Error" />);
    const input = container.querySelector('input');
    expect(input?.className).toContain('border-red-500');
  });

  it('forwards id to input element', () => {
    render(<TextField id="field-id" />);
    expect(document.getElementById('field-id')).toBeInTheDocument();
  });
});

describe('SelectField', () => {
  const options = [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' },
  ];

  it('renders select with options', () => {
    render(<SelectField options={options} />);
    expect(screen.getByText('Option A')).toBeInTheDocument();
    expect(screen.getByText('Option B')).toBeInTheDocument();
  });

  it('renders label', () => {
    render(<SelectField label="Choose" options={options} id="select-id" />);
    expect(screen.getByText('Choose')).toBeInTheDocument();
  });

  it('calls onChange when selecting', () => {
    const onChange = vi.fn();
    render(<SelectField options={options} onChange={onChange} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('renders with value selected', () => {
    render(<SelectField options={options} value="b" onChange={vi.fn()} />);
    const select = screen.getByRole<HTMLSelectElement>('combobox');
    expect(select.value).toBe('b');
  });

  it('forwards id to select element', () => {
    render(<SelectField options={options} id="select-id" />);
    expect(document.getElementById('select-id')).toBeInTheDocument();
  });
});

describe('Switch', () => {
  it('renders with label', () => {
    render(<Switch checked={false} onChange={vi.fn()} label="Enable Feature" id="switch-1" />);
    expect(screen.getByText('Enable Feature')).toBeInTheDocument();
  });

  it('calls onChange when clicked', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} />);
    const toggle = document.querySelector('.relative.w-8');
    expect(toggle).toBeInTheDocument();
    if (toggle) {
      fireEvent.click(toggle);
      expect(onChange).toHaveBeenCalledWith(true);
    }
  });

  it('shows checked state', () => {
    const { container } = render(<Switch checked={true} onChange={vi.fn()} />);
    const toggle = container.querySelector('.bg-\\[var\\(--accent-primary\\)\\]');
    expect(toggle).toBeInTheDocument();
  });

  it('shows unchecked state', () => {
    const { container } = render(<Switch checked={false} onChange={vi.fn()} />);
    const toggle = container.querySelector('.bg-\\[var\\(--border-color-hover\\)\\]');
    expect(toggle).toBeInTheDocument();
  });

  it('renders without label', () => {
    const { container } = render(<Switch checked={false} onChange={vi.fn()} />);
    const labels = container.querySelectorAll('span.text-\\[var\\(--text-secondary\\)\\]');
    expect(labels.length).toBe(0);
  });
});

describe('Checkbox', () => {
  it('renders with label', () => {
    render(<Checkbox checked={false} onChange={vi.fn()} label="Accept terms" id="cb-1" />);
    expect(screen.getByText('Accept terms')).toBeInTheDocument();
  });

  it('calls onChange when toggled', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Test" />);
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('renders checked state', () => {
    render(<Checkbox checked={true} onChange={vi.fn()} label="Checked" />);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('renders unchecked state', () => {
    render(<Checkbox checked={false} onChange={vi.fn()} label="Unchecked" />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});

describe('FormRow', () => {
  it('renders label and children', () => {
    render(
      <FormRow label="Settings">
        <input data-testid="child-input" />
      </FormRow>,
    );
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByTestId('child-input')).toBeInTheDocument();
  });

  it('renders with id', () => {
    render(
      <FormRow label="Test" id="form-row-1">
        <div>Content</div>
      </FormRow>,
    );
    expect(document.getElementById('form-row-1')).toBeInTheDocument();
  });

  it('renders multiple children', () => {
    render(
      <FormRow label="Multiple">
        <span data-testid="child-1">First</span>
        <span data-testid="child-2">Second</span>
      </FormRow>,
    );
    expect(screen.getByTestId('child-1')).toBeInTheDocument();
    expect(screen.getByTestId('child-2')).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  const options = [
    { id: 'general', label: 'General', icon: undefined },
    { id: 'advanced', label: 'Advanced' },
  ];

  it('renders all tabs', () => {
    render(<Tabs options={options} activeId="general" onChange={vi.fn()} />);
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
  });

  it('highlights active tab', () => {
    render(<Tabs options={options} activeId="advanced" onChange={vi.fn()} />);
    const advancedBtn = screen.getByText('Advanced');
    expect(advancedBtn.closest('button')?.className).toContain('bg-[var(--bg-surface-elevated)]');
  });

  it('does not highlight inactive tab', () => {
    render(<Tabs options={options} activeId="advanced" onChange={vi.fn()} />);
    const generalBtn = screen.getByText('General');
    expect(generalBtn.closest('button')?.className).not.toContain('bg-[var(--bg-surface-elevated)]');
  });

  it('calls onChange when tab clicked', () => {
    const onChange = vi.fn();
    render(<Tabs options={options} activeId="general" onChange={onChange} />);
    fireEvent.click(screen.getByText('Advanced'));
    expect(onChange).toHaveBeenCalledWith('advanced');
  });

  it('renders with id', () => {
    render(<Tabs options={options} activeId="general" onChange={vi.fn()} id="tabs-1" />);
    expect(document.getElementById('tabs-1')).toBeInTheDocument();
  });
});

describe('StatusPill', () => {
  const statuses: DownloadStatus[] = ['downloading', 'completed', 'paused', 'pausing', 'stopping', 'queued', 'error'];

  statuses.forEach((status) => {
    it(`renders status pill for ${status}`, () => {
      render(<StatusPill status={status} />);
      const map: Record<string, string> = {
        downloading: 'Downloading',
        completed: 'Completed',
        paused: 'Paused',
        pausing: 'Paused',
        stopping: 'Paused',
        queued: 'Queued',
        error: 'Error',
      };
      expect(screen.getByText(map[status])).toBeInTheDocument();
    });
  });

  it('applies correct border class', () => {
    const { container } = render(<StatusPill status="downloading" />);
    const pill = container.firstChild as HTMLElement;
    expect(pill.className).toContain('border-blue-500');
  });

  it('applies correct color for completed', () => {
    const { container } = render(<StatusPill status="completed" />);
    const pill = container.firstChild as HTMLElement;
    expect(pill.className).toContain('text-emerald-500');
  });

  it('applies correct color for error', () => {
    const { container } = render(<StatusPill status="error" />);
    const pill = container.firstChild as HTMLElement;
    expect(pill.className).toContain('text-rose-500');
  });

  it('applies correct color for queued', () => {
    const { container } = render(<StatusPill status="queued" />);
    const pill = container.firstChild as HTMLElement;
    expect(pill.className).toContain('text-slate-400');
  });
});

describe('ProgressBar', () => {
  it('renders progress percentage', () => {
    render(<ProgressBar progress={50} />);
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('renders speed text', () => {
    render(<ProgressBar progress={50} speedText="2.5 MB/s" />);
    expect(screen.getByText('2.5 MB/s')).toBeInTheDocument();
  });

  it('clamps progress to 0 minimum', () => {
    render(<ProgressBar progress={-10} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('clamps progress to 100 maximum', () => {
    render(<ProgressBar progress={150} />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders with 0 progress', () => {
    render(<ProgressBar progress={0} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('renders with 100 progress', () => {
    render(<ProgressBar progress={100} />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('hides text when showText is false', () => {
    render(<ProgressBar progress={50} showText={false} />);
    expect(screen.queryByText('50%')).not.toBeInTheDocument();
  });

  it('hides speed text when not provided', () => {
    render(<ProgressBar progress={50} />);
    expect(screen.queryByText('MB/s')).not.toBeInTheDocument();
  });
});
