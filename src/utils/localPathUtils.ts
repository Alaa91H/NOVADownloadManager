export function localPathSeparator(path: string): '/' | '\\' {
  return path.includes('\\') ? '\\' : '/';
}

export function joinLocalPath(folder: string, fileName: string): string {
  const normalizedFolder = folder.trim().replace(/[\\/]+$/, '');
  if (!normalizedFolder) return fileName;
  if (!fileName) return normalizedFolder;
  return `${normalizedFolder}${localPathSeparator(normalizedFolder)}${fileName}`;
}

export function parentLocalPath(path: string): string | undefined {
  const normalizedPath = path.trim().replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalizedPath.lastIndexOf('/'), normalizedPath.lastIndexOf('\\'));
  if (separatorIndex <= 0) return undefined;
  return normalizedPath.slice(0, separatorIndex);
}
