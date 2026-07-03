import fs from 'node:fs/promises';
import path from 'node:path';

for (const target of ['dist']) {
  await fs.rm(path.resolve(process.cwd(), target), { recursive: true, force: true });
}
