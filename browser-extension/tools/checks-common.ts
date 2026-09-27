import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(root: string, predicate: (path: string) => boolean = () => true): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', '.wxt', '.output', 'dist', 'coverage', 'playwright-report', 'test-results'].includes(entry.name)) {
          await walk(full);
        }
      } else if (entry.isFile() && predicate(full)) {
        results.push(full);
      }
    }
  }
  await walk(root);
  return results.sort();
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function sha256(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export function rel(path: string): string {
  return relative(process.cwd(), path).replaceAll('\\', '/');
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
