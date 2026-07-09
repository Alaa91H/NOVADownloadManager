import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        time_picker_hour: 'Hour',
        time_picker_minute: 'Minute',
        time_picker_period: 'Period',
      };
      return map[k] || k;
    },
  }),
}));

import { TimePicker } from '../primitives/TimePicker';

describe('TimePicker', () => {
  it('renders label', () => {
    render(<TimePicker label="Start Time" value="08:30" onChange={vi.fn()} />);
    expect(screen.getByText('Start Time')).toBeInTheDocument();
  });

  it('renders hour, minute, and AM/PM controls', () => {
    render(<TimePicker label="Time" value="14:30" onChange={vi.fn()} />);
    expect(screen.getByText('Hour')).toBeInTheDocument();
    expect(screen.getByText('Minute')).toBeInTheDocument();
    expect(screen.getByText('Period')).toBeInTheDocument();
  });

  it('displays the time in 12-hour format', () => {
    render(<TimePicker label="Time" value="14:30" onChange={vi.fn()} />);
    const display = screen.getByText((content) => content.includes('02') && content.includes('30'));
    expect(display).toBeInTheDocument();
    const pmButtons = screen.getAllByText('PM');
    expect(pmButtons.length).toBeGreaterThanOrEqual(1);
    const pmBtn = pmButtons.find((b) => b.tagName === 'BUTTON');
    expect(pmBtn).toBeInTheDocument();
  });

  it('displays AM time correctly', () => {
    render(<TimePicker label="Time" value="08:15" onChange={vi.fn()} />);
    const display = screen.getByText((content) => content.includes('08') && content.includes('15'));
    expect(display).toBeInTheDocument();
    const amButtons = screen.getAllByText('AM');
    const amBtn = amButtons.find((b) => b.tagName === 'BUTTON');
    expect(amBtn).toBeInTheDocument();
  });

  it('handles midnight correctly', () => {
    render(<TimePicker label="Time" value="00:00" onChange={vi.fn()} />);
    const display = screen.getByText((content) => content.includes('12') && content.includes('00'));
    expect(display).toBeInTheDocument();
    const amButtons = screen.getAllByText('AM');
    const amBtn = amButtons.find((b) => b.tagName === 'BUTTON');
    expect(amBtn).toBeInTheDocument();
  });

  it('handles noon correctly', () => {
    render(<TimePicker label="Time" value="12:00" onChange={vi.fn()} />);
    const display = screen.getByText((content) => content.includes('12') && content.includes('00'));
    expect(display).toBeInTheDocument();
    const pmButtons = screen.getAllByText('PM');
    const pmBtn = pmButtons.find((b) => b.tagName === 'BUTTON');
    expect(pmBtn).toBeInTheDocument();
  });

  it('calls onChange when hour changes', () => {
    const onChange = vi.fn();
    render(<TimePicker label="Time" value="08:30" onChange={onChange} />);
    const hourSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(hourSelect, { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledWith('10:30');
  });

  it('calls onChange when minute changes', () => {
    const onChange = vi.fn();
    render(<TimePicker label="Time" value="08:30" onChange={onChange} />);
    const minuteSelect = screen.getAllByRole('combobox')[1];
    fireEvent.change(minuteSelect, { target: { value: '15' } });
    expect(onChange).toHaveBeenCalledWith('08:15');
  });

  it('calls onChange when toggling AM/PM', () => {
    const onChange = vi.fn();
    render(<TimePicker label="Time" value="08:30" onChange={onChange} />);
    const pmButtons = screen.getAllByText('PM');
    const pmBtn = pmButtons.find((b) => b.tagName === 'BUTTON');
    expect(pmBtn).toBeDefined();
    if (!pmBtn) return;
    fireEvent.click(pmBtn);
    expect(onChange).toHaveBeenCalledWith('20:30');
  });

  it('calls onChange when toggling from PM to AM', () => {
    const onChange = vi.fn();
    render(<TimePicker label="Time" value="14:30" onChange={onChange} />);
    const amButtons = screen.getAllByText('AM');
    const amBtn = amButtons.find((b) => b.tagName === 'BUTTON');
    expect(amBtn).toBeDefined();
    if (!amBtn) return;
    fireEvent.click(amBtn);
    expect(onChange).toHaveBeenCalledWith('02:30');
  });

  it('renders 12 hour options', () => {
    render(<TimePicker label="Time" value="08:00" onChange={vi.fn()} />);
    const hourSelect = screen.getAllByRole('combobox')[0];
    const options = hourSelect.querySelectorAll('option');
    expect(options).toHaveLength(12);
    expect(options[0].textContent).toBe('1');
    expect(options[11].textContent).toBe('12');
  });

  it('renders 60 minute options', () => {
    render(<TimePicker label="Time" value="08:00" onChange={vi.fn()} />);
    const minuteSelect = screen.getAllByRole('combobox')[1];
    const options = minuteSelect.querySelectorAll('option');
    expect(options).toHaveLength(60);
  });

  it('highlights AM when ampm is AM', () => {
    render(<TimePicker label="Time" value="08:00" onChange={vi.fn()} />);
    const amButtons = screen.getAllByText('AM');
    const amBtn = amButtons.find((b) => b.tagName === 'BUTTON');
    expect(amBtn).toBeDefined();
    if (!amBtn) return;
    expect(amBtn.className).toContain('text-white');
  });

  it('highlights PM when ampm is PM', () => {
    render(<TimePicker label="Time" value="14:00" onChange={vi.fn()} />);
    const pmButtons = screen.getAllByText('PM');
    const pmBtn = pmButtons.find((b) => b.tagName === 'BUTTON');
    expect(pmBtn).toBeDefined();
    if (!pmBtn) return;
    expect(pmBtn.className).toContain('text-white');
  });
});
