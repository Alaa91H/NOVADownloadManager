import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ColumnConfigPanel from '../ColumnConfigPanel';
import { columnLabels } from '../../utils/taskTableUtils';

const defaultColOrder = ['name', 'size', 'progress', 'speed', 'timeLeft', 'date', 'status'];

function createDefaultProps(overrides: Record<string, unknown> = {}) {
  return {
    colOrder: defaultColOrder,
    visibleCols: { name: true, size: true, progress: true, speed: true, timeLeft: false, date: false, status: true },
    draggingCustomizeCol: null,
    setVisibleCols: vi.fn(),
    handleCustomizeDragStart: vi.fn(),
    handleCustomizeDragOver: vi.fn(),
    handleCustomizeDrop: vi.fn(),
    handleCustomizeDragEnd: vi.fn(),
    ...overrides,
  };
}

describe('ColumnConfigPanel', () => {
  it('renders all columns in order', () => {
    render(<ColumnConfigPanel {...createDefaultProps()} />);
    defaultColOrder.forEach((colKey) => {
      expect(screen.getByText(columnLabels[colKey])).toBeInTheDocument();
    });
  });

  it('renders heading and description', () => {
    render(<ColumnConfigPanel {...createDefaultProps()} />);
    expect(screen.getByText('Customize & Reorder Columns')).toBeInTheDocument();
    expect(screen.getByText('Drag columns to reorder or toggle visibility')).toBeInTheDocument();
  });

  it('shows checked state for visible columns', () => {
    render(<ColumnConfigPanel {...createDefaultProps()} />);
    const checkboxes = screen.getAllByRole('checkbox');
    const nameCheck = checkboxes.find((cb) => cb.closest('div')?.textContent?.includes('Filename'));
    expect(nameCheck).toBeChecked();
  });

  it('disables checkbox for name column', () => {
    const { container } = render(<ColumnConfigPanel {...createDefaultProps()} />);
    const divs = container.querySelectorAll('div');
    const nameDiv = Array.from(divs).find((d) => d.textContent === 'Filename');
    const checkbox = nameDiv?.closest('div')?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeDisabled();
  });

  it('calls setVisibleCols when toggling non-name column', () => {
    const setVisibleCols = vi.fn();
    render(<ColumnConfigPanel {...createDefaultProps({ setVisibleCols })} />);
    const checkboxes = screen.getAllByRole('checkbox');
    const sizeCheckbox = checkboxes.find((cb) => cb.closest('div')?.textContent?.includes('Size'));
    expect(sizeCheckbox).toBeDefined();
    if (sizeCheckbox) {
      fireEvent.click(sizeCheckbox);
      expect(setVisibleCols).toHaveBeenCalled();
    }
  });

  it('calls handleCustomizeDragStart on drag start', () => {
    const handleCustomizeDragStart = vi.fn();
    render(<ColumnConfigPanel {...createDefaultProps({ handleCustomizeDragStart })} />);
    const sizeDiv = screen.getByText('Size').closest('div[draggable]');
    expect(sizeDiv).toBeDefined();
    if (sizeDiv) {
      fireEvent.dragStart(sizeDiv);
      expect(handleCustomizeDragStart).toHaveBeenCalled();
    }
  });

  it('calls handleCustomizeDragOver on drag over', () => {
    const handleCustomizeDragOver = vi.fn();
    render(<ColumnConfigPanel {...createDefaultProps({ handleCustomizeDragOver })} />);
    const sizeDiv = screen.getByText('Size').closest('div[draggable]');
    expect(sizeDiv).toBeDefined();
    if (sizeDiv) {
      fireEvent.dragOver(sizeDiv);
      expect(handleCustomizeDragOver).toHaveBeenCalled();
    }
  });

  it('calls handleCustomizeDrop on drop', () => {
    const handleCustomizeDrop = vi.fn();
    render(<ColumnConfigPanel {...createDefaultProps({ handleCustomizeDrop })} />);
    const sizeDiv = screen.getByText('Size').closest('div[draggable]');
    expect(sizeDiv).toBeDefined();
    if (sizeDiv) {
      fireEvent.drop(sizeDiv);
      expect(handleCustomizeDrop).toHaveBeenCalled();
    }
  });

  it('calls handleCustomizeDragEnd on drag end', () => {
    const handleCustomizeDragEnd = vi.fn();
    render(<ColumnConfigPanel {...createDefaultProps({ handleCustomizeDragEnd })} />);
    const sizeDiv = screen.getByText('Size').closest('div[draggable]');
    expect(sizeDiv).toBeDefined();
    if (sizeDiv) {
      fireEvent.dragEnd(sizeDiv);
      expect(handleCustomizeDragEnd).toHaveBeenCalled();
    }
  });

  it('applies dragging style when column is being dragged', () => {
    const { container } = render(<ColumnConfigPanel {...createDefaultProps({ draggingCustomizeCol: 'size' })} />);
    const sizeDiv = screen.getByText('Size').closest('div[draggable]');
    expect(sizeDiv?.className).toContain('opacity-40');
  });

  it('does not render grip icon for name column', () => {
    const { container } = render(<ColumnConfigPanel {...createDefaultProps()} />);
    const nameDiv = screen.getByText('Filename').closest('div[draggable]');
    const gripInName = nameDiv?.querySelector('.lucide-grip-vertical');
    expect(gripInName).toBeNull();
  });

  it('renders grip icon for non-name columns', () => {
    const { container } = render(<ColumnConfigPanel {...createDefaultProps()} />);
    const sizeDiv = screen.getByText('Size').closest('div[draggable]');
    const gripInSize = sizeDiv?.querySelector('.lucide-grip-vertical');
    expect(gripInSize).toBeInTheDocument();
  });

  it('has cursor-grab for non-name columns', () => {
    render(<ColumnConfigPanel {...createDefaultProps()} />);
    const sizeDiv = screen.getByText('Size').closest('div[draggable]');
    expect(sizeDiv?.className).toContain('cursor-grab');
  });

  it('has cursor-default for name column', () => {
    render(<ColumnConfigPanel {...createDefaultProps()} />);
    const nameDiv = screen.getByText('Filename').closest('div[draggable]');
    expect(nameDiv?.className).toContain('cursor-default');
  });

  it('shows fallback label when column key not in columnLabels', () => {
    render(<ColumnConfigPanel {...createDefaultProps({ colOrder: ['unknown_col'] })} />);
    expect(screen.getByText('unknown_col')).toBeInTheDocument();
  });
});
