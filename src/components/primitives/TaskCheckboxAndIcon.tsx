import React from 'react';
import { FileType } from '../../types/desktop-ui.types';
import { getFileTypeIcon } from '../../utils/taskTableUtils';

interface TaskCheckboxAndIconProps {
  isChecked: boolean;
  fileType: FileType;
  taskId: string;
  handleToggleCheckTask: (id: string, e: React.MouseEvent) => void;
  hasSelection: boolean;
}

const TaskCheckboxAndIcon: React.FC<TaskCheckboxAndIconProps> = ({
  isChecked,
  fileType,
  taskId,
  handleToggleCheckTask,
  hasSelection,
}) => {
  const showCheckbox = isChecked || hasSelection;
  return (
    <div
      className="group relative w-6 h-6 flex items-center justify-center cursor-pointer"
      onMouseDown={(e) => {
        e.stopPropagation();
      }}
      onMouseUp={(e) => {
        e.stopPropagation();
      }}
      onTouchStart={(e) => {
        e.stopPropagation();
      }}
      onTouchEnd={(e) => {
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        handleToggleCheckTask(taskId, e);
      }}
    >
      <div className={`transition-all duration-100 ${showCheckbox ? 'block' : 'hidden group-hover:block'}`}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => {}}
          className="rounded-none border-[var(--border-color)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer h-3.5 w-3.5 shrink-0"
        />
      </div>
      <div
        className={`w-6 h-6 bg-[var(--bg-hover)]/60 border border-[var(--border-color)]/30 rounded-none flex items-center justify-center text-xs shrink-0 shadow-sm transition-all duration-100 ${
          showCheckbox ? 'hidden' : 'block group-hover:hidden'
        }`}
      >
        {getFileTypeIcon(fileType, 'w-3.5 h-3.5')}
      </div>
    </div>
  );
};

export default TaskCheckboxAndIcon;
