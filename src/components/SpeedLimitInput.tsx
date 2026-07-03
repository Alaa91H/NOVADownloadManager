/* src/components/SpeedLimitInput.tsx */
import React, { useState, useEffect } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface SpeedLimitInputProps {
  maxSpeedKbs: number;
  onChange: (value: number) => void;
  compact?: boolean;
}

export const SpeedLimitInput: React.FC<SpeedLimitInputProps> = ({ maxSpeedKbs, onChange, compact = false }) => {
  // Determine initial display unit and value
  const isMbInitial = maxSpeedKbs >= 1024 && maxSpeedKbs % 1024 === 0;
  const [unit, setUnit] = useState<'KB' | 'MB'>(isMbInitial ? 'MB' : 'KB');
  const [inputValue, setInputValue] = useState<string>(
    isMbInitial ? String(maxSpeedKbs / 1024) : String(maxSpeedKbs)
  );

  // Sync state if prop changes from outside (e.g. from state store)
  useEffect(() => {
    const isMb = maxSpeedKbs >= 1024 && maxSpeedKbs % 1024 === 0;
    setUnit(isMb ? 'MB' : 'KB');
    setInputValue(isMb ? String(maxSpeedKbs / 1024) : String(maxSpeedKbs));
  }, [maxSpeedKbs]);

  const handleValueChange = (numericVal: number, currentUnit: 'KB' | 'MB') => {
    let finalKbs = numericVal;
    if (currentUnit === 'MB') {
      finalKbs = numericVal * 1024;
    }
    // Set a reasonable minimum
    if (finalKbs < 10) finalKbs = 10;
    onChange(finalKbs);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawStr = e.target.value;
    // Allow typing numbers or decimals (especially for MB like 1.5)
    setInputValue(rawStr);
    const parsed = parseFloat(rawStr);
    if (!isNaN(parsed) && parsed >= 0) {
      handleValueChange(parsed, unit);
    }
  };

  const increment = () => {
    const current = parseFloat(inputValue) || 0;
    // KB increments by 100, MB by 1
    const step = unit === 'KB' ? 100 : 1;
    const newVal = current + step;
    setInputValue(String(newVal));
    handleValueChange(newVal, unit);
  };

  const decrement = () => {
    const current = parseFloat(inputValue) || 0;
    const step = unit === 'KB' ? 100 : 1;
    const newVal = Math.max(unit === 'KB' ? 10 : 1, current - step);
    setInputValue(String(newVal));
    handleValueChange(newVal, unit);
  };

  const toggleUnit = (newUnit: 'KB' | 'MB') => {
    if (newUnit === unit) return;
    
    const currentVal = parseFloat(inputValue) || 0;
    let newVal = currentVal;
    
    if (newUnit === 'MB') {
      // Convert KB to MB
      newVal = Math.round((currentVal / 1024) * 10) / 10;
      if (newVal < 1) newVal = 1;
    } else {
      // Convert MB to KB
      newVal = Math.round(currentVal * 1024);
    }
    
    setUnit(newUnit);
    setInputValue(String(newVal));
    handleValueChange(newVal, newUnit);
  };

  return (
    <div className={`flex items-center gap-1 ${compact ? 'text-[10px]' : 'text-xs'}`} style={{ direction: 'ltr' }}>
      {/* Input container with up/down arrows */}
      <div className={`relative flex items-center bg-[var(--bg-input)] border border-[var(--border-color)] rounded overflow-hidden transition-all focus-within:border-[var(--accent-primary)] focus-within:ring-1 focus-within:ring-[var(--accent-primary)] ${compact ? 'h-6.5 w-[56px]' : 'h-8.5 w-[85px]'}`}>
        <input
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          className={`w-full h-full bg-transparent border-none outline-none text-center font-mono text-[var(--text-primary)] pr-4.5 font-bold ${compact ? 'text-[10px]' : 'text-xs'}`}
          style={{ direction: 'ltr' }}
        />
        {/* Incrementor arrows stack on the right side of the input */}
        <div className="absolute right-0 top-0 bottom-0 flex flex-col border-l border-[var(--border-color)] w-4 bg-[var(--bg-hover)]/30">
          <button 
            type="button"
            onClick={increment}
            className="flex-1 flex items-center justify-center hover:bg-[var(--border-color-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronUp className={`${compact ? 'w-2.5 h-2.5' : 'w-3 h-3'}`} />
          </button>
          <button 
            type="button"
            onClick={decrement}
            className="flex-1 flex items-center justify-center hover:bg-[var(--border-color-hover)] border-t border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronDown className={`${compact ? 'w-2.5 h-2.5' : 'w-3 h-3'}`} />
          </button>
        </div>
      </div>

      {/* KB / MB Selector Tabs */}
      <div className={`flex border border-[var(--border-color)] rounded overflow-hidden bg-[var(--bg-input)] ${compact ? 'h-6.5' : 'h-8.5'}`}>
        <button
          type="button"
          onClick={() => toggleUnit('KB')}
          className={`px-1.5 flex items-center justify-center font-mono font-bold transition-colors ${
            unit === 'KB' 
              ? 'bg-[var(--accent-primary)] text-white' 
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          } ${compact ? 'text-[8.5px]' : 'text-[10px]'}`}
        >
          KB
        </button>
        <button
          type="button"
          onClick={() => toggleUnit('MB')}
          className={`px-1.5 flex items-center justify-center font-mono font-bold border-l border-[var(--border-color)] transition-colors ${
            unit === 'MB' 
              ? 'bg-[var(--accent-primary)] text-white' 
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          } ${compact ? 'text-[8.5px]' : 'text-[10px]'}`}
        >
          MB
        </button>
      </div>
    </div>
  );
};
