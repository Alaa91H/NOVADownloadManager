// Derives JSON Schema artifacts for the desktop bridge contract from the zod
// schemas that the extension actually enforces at runtime, so the published
// contracts/ files cannot drift from the code. Run with: pnpm contracts:generate
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { RuntimeMessageSchema } from '../src/contracts/messages.schema';
import { AdmEventSchema } from '../src/contracts/events.schema';
import { ExtensionSettingsResponseSchema } from '../src/contracts/adm.protocol.v4';

const BASE_ID = 'https://apexdownloadmanager.app/contracts';

const targets = [
  { schema: RuntimeMessageSchema, file: 'runtime-message.schema.json', title: 'NOVA Extension Runtime Message', id: 'runtime-message.schema.json' },
  { schema: AdmEventSchema, file: 'adm.events.schema.json', title: 'ADM Bridge Event', id: 'adm.events.schema.json' },
  { schema: ExtensionSettingsResponseSchema, file: 'extension-settings-response.schema.json', title: 'NOVA Extension Settings Response', id: 'extension-settings-response.schema.json' },
] as const;

for (const target of targets) {
  const jsonSchema = z.toJSONSchema(target.schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  const document = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${BASE_ID}/${target.id}`,
    title: target.title,
    ...jsonSchema,
  };
  const path = `contracts/${target.file}`;
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`Generated ${path}`);
}

console.log('Contract JSON Schemas generated from zod sources.');
