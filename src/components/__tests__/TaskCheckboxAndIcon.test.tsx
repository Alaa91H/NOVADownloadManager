import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TaskCheckboxAndIcon from '../primitives/TaskCheckboxAndIcon';

const defaultProps = {
  isChecked: false,
  fileType: 'compressed' as const,
  taskId: 'task-1',
  handleToggleCheckTask: vi.fn(),
  hasSelection: false,
};

describe('TaskCheckboxAndIcon', () => {
  it('renders icon when not checked and no selection', () => {
    const { container } = render(<TaskCheckboxAndIcon {...defaultProps} />);
    const outerDiv = container.querySelector('.group');
    expect(outerDiv).toBeInTheDocument();
  });

  it('shows checkbox when isChecked is true', () => {
    render(<TaskCheckboxAndIcon {...defaultProps} isChecked />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();
  });

  it('shows checkbox when hasSelection is true', () => {
    render(<TaskCheckboxAndIcon {...defaultProps} hasSelection />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it('does not show checkbox when not checked and no selection', () => {
    render(<TaskCheckboxAndIcon {...defaultProps} />);
    const checkbox = screen.queryByRole('checkbox');
    expect(checkbox?.closest('div')?.className).toContain('hidden');
  });

  it('renders for video file type', () => {
    const { container } = render(<TaskCheckboxAndIcon {...defaultProps} fileType="video" />);
    const outerDiv = container.querySelector('.group');
    expect(outerDiv).toBeInTheDocument();
  });

  it('renders for audio file type', () => {
    const { container } = render(<TaskCheckboxAndIcon {...defaultProps} fileType="audio" />);
    const outerDiv = container.querySelector('.group');
    expect(outerDiv).toBeInTheDocument();
  });
});
