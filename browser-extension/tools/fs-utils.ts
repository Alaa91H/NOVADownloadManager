import { mkdir, readdir, rm, stat, copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureEmptyDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

export async function copyDir(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
      continue;
    }
    if (entry.isFile()) {
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }
  }
}

export async function findFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  await walk(root);
  return results.sort();
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function displayPath(path: string): string {
  return relative(process.cwd(), path) || basename(path);
}
