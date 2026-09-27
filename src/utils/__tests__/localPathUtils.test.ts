import { describe, expect, it } from 'vitest';
import { joinLocalPath, parentLocalPath } from '../localPathUtils';

describe('localPathUtils', () => {
  it('joins Windows folders with backslashes', () => {
    expect(joinLocalPath('C:\\Users\\NOVA\\Downloads', 'archive.zip')).toBe('C:\\Users\\NOVA\\Downloads\\archive.zip');
    expect(parentLocalPath('C:\\Users\\NOVA\\Downloads\\archive.zip')).toBe('C:\\Users\\NOVA\\Downloads');
  });

  it('joins Unix folders with forward slashes', () => {
    expect(joinLocalPath('/home/nova/Downloads', 'archive.zip')).toBe('/home/nova/Downloads/archive.zip');
    expect(parentLocalPath('/home/nova/Downloads/archive.zip')).toBe('/home/nova/Downloads');
  });

  it('handles trailing separators and paths without a parent', () => {
    expect(joinLocalPath('/home/nova/Downloads/', 'archive.zip')).toBe('/home/nova/Downloads/archive.zip');
    expect(parentLocalPath('archive.zip')).toBeUndefined();
  });
});
