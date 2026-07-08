import { readFile } from 'node:fs/promises';
import { assert } from './checks-common.js';

async function read(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

const [limits, http, native, retryWorker, outboxStore, idempotency, diagnostics] = await Promise.all([
  read('src/contracts/limits.ts'),
  read('src/transport/http-transport.ts'),
  read('src/transport/native-transport.ts'),
  read('src/outbox/retry-worker.ts'),
  read('src/outbox/outbox-store.ts'),
  read('src/outbox/idempotency.ts'),
  read('src/background/message-router.ts'),
]);

for (const constant of ['MAX_HTTP_REQUEST_PAYLOAD_BYTES', 'MAX_HTTP_RESPONSE_BYTES', 'MAX_NATIVE_MESSAGE_BYTES', 'IDEMPOTENCY_SCHEMA_VERSION']) {
  assert(limits.includes(`export const ${constant}`), `Missing ${constant} in limits.ts.`);
}

assert(http.includes('encodeJsonPayloadWithBudget'), 'HttpTransport must budget HTTP request payloads before fetch.');
assert(http.includes('readJsonResponseWithBudget'), 'HttpTransport must read HTTP responses through a bounded reader.');
assert(!http.includes('response.json()'), 'HttpTransport must not use unbounded response.json().');
assert(!http.includes('JSON.stringify(payload ?? {})'), 'HttpTransport must not stringify payloads without a byte budget.');
assert(native.includes('assertNativeMessageBudget(request'), 'NativeTransport must budget native request envelopes.');
assert(native.includes('assertNativeMessageBudget(raw'), 'NativeTransport must budget native response envelopes.');
assert(outboxStore.includes('claimDue(owner'), 'OutboxStore must lease due jobs before retry send.');
assert(retryWorker.includes('claimDue(this.owner)'), 'OutboxRetryWorker must use leased claims instead of raw pending jobs.');
assert(idempotency.includes('adm-extension-idempotency-v'), 'Idempotency keys must be versioned.');
assert(idempotency.includes('canonicalCandidate'), 'Idempotency keys must use canonical candidate fingerprints.');
assert(diagnostics.includes('transportBudgets'), 'Diagnostics must expose active transport budgets.');
assert(diagnostics.includes('schemaVersion: IDEMPOTENCY_SCHEMA_VERSION'), 'Diagnostics must expose idempotency schema version.');

console.log('Transport budget and idempotency policy passed.');
