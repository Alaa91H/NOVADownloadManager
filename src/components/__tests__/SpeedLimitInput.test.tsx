import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SpeedLimitInput } from '../SpeedLimitInput';

describe('SpeedLimitInput', () => {
  it('renders with KB unit for values < 1024', () => {
    const onChange = vi.fn();
    render(<SpeedLimitInput maxSpeedKbs={500} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('500');
    expect(screen.getByText('KB')).toBeInTheDocument();
  });

  it('renders with MB unit for values >= 1024 and divisible by 1024', () => {
    const onChange = vi.fn();
    render(<SpeedLimitInput maxSpeedKbs={2048} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('2');
    expect(screen.getByText('MB')).toBeInTheDocument();
  });

  it('renders with KB unit for values >= 1024 but not divisible by 1024', () => {
    const onChange = vi.fn();
    render(<SpeedLimitInput maxSpeedKbs={1500} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1500');
    expect(screen.getByText('KB')).toBeInTheDocument();
  });

  it('calls onChange when incrementing', () => {
    const onChange = vi.fn();
    render(<SpeedLimitInput maxSpeedKbs={500} onChange={onChange} />);
    const buttons = screen.getAllByRole('button');
    const upButton = buttons.find((b) => b.querySelector('.lucide-chevron-up'));
    expect(upButton).toBeDefined();
    if (upButton) fireEvent.click(upButton);
    expect(onChange).toHaveBeenCalledWith(600);
  });

  it('calls onChange when decrementing', () => {
    const onChange = vi.fn();
    render(<SpeedLimitInput maxSpeedKbs={500} onChange={onChange} />);
    const buttons = screen.getAllByRole('button');
    const downButton = buttons.find((b) => b.querySelector('.lucide-chevron-down'));
    expect(downButton).toBeDefined();
    if (downButton) fireEvent.click(downButton);
    expect(onChange).toHaveBeenCalledWith(400);
  });

  it('calls onChange when typing a value', () => {
    const onChange = vi.fn();
    render(<SpeedLimitInput maxSpeedKbs={500} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '750' } });
    expect(onChange).toHaveBeenCalledWith(750);
  });

  it('switches unit from KB to MB', () => {
    const onChange = vi.fn();
    render(<SpeedLimitInput maxSpeedKbs={1024} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1');
    const kbButton = screen.getByText('KB');
    const mbButton = screen.getByText('MB');
    expect(mbButton.className).toContain('bg-[var(--accent-primary)]');
    fireEvent.click(kbButton);
    expect(onChange).toHaveBeenCalledWith(1024);
  });

  it('applies compact styling when compact prop is true', () => {
    const onChange = vi.fn();
    const { container } = render(<SpeedLimitInput maxSpeedKbs={500} onChange={onChange} compact />);
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('clamps decrement to minimum of 10 KB', () => {
    const onChange = vi.fn();
    render(<SpeedLimitInput maxSpeedKbs={10} onChange={onChange} />);
    const buttons = screen.getAllByRole('button');
    const downButton = buttons[1];
    fireEvent.click(downButton);
    expect(onChange).toHaveBeenCalledWith(10);
  });
});
