import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const manifestPath = resolve(root, 'desktop-native/parity/control-plane-parity.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const commandSource = readFileSync(resolve(root, manifest.source.commands), 'utf8');
const querySource = readFileSync(resolve(root, manifest.source.queries), 'utf8');
const eventSource = commandSource;

function requiredMatch(value, expression, label) {
  const match = value.match(expression);
  if (!match) throw new Error(`cannot locate ${label}`);
  return match[1];
}

const commandBlock = requiredMatch(
  commandSource,
  /pub const CONTROL_PLANE_CAPABILITIES:[\s\S]*?= &\[([\s\S]*?)\n\];/,
  'CONTROL_PLANE_CAPABILITIES',
);
const runtimeCommands = [...commandBlock.matchAll(/\bid:\s*"([^"]+)"[\s\S]*?status:\s*CapabilityStatus::(\w+)/g)]
  .map(([, id, status]) => ({ id, status }));
const queryBlock = requiredMatch(querySource, /"queryCapabilities":\s*\[([\s\S]*?)\n\s*\],/, 'queryCapabilities');
const runtimeQueries = [...queryBlock.matchAll(/\{\s*"id":\s*"([^"]+)"/g)].map(([, id]) => id);
const eventBlock = requiredMatch(eventSource, /pub const CONTROL_EVENT_TYPES:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\n\];/, 'CONTROL_EVENT_TYPES');
const runtimeEvents = [...eventBlock.matchAll(/"([a-z][a-z0-9_.]+)"/g)].map(([, eventType]) => eventType);
const commandIds = new Set(runtimeCommands.map(({ id }) => id));
const queryIds = new Set(runtimeQueries);
const eventTypes = new Set(runtimeEvents);

function checkExactKeys(label, declared, actual) {
  const declaredKeys = Object.keys(declared).sort();
  const actualKeys = [...actual].sort();
  const missing = actualKeys.filter((id) => !declaredKeys.includes(id));
  const stale = declaredKeys.filter((id) => !actualKeys.includes(id));
  if (missing.length || stale.length) {
    throw new Error(`${label} manifest drift; missing: ${missing.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'}`);
  }
}

checkExactKeys('command', manifest.capabilityLifecycle, runtimeCommands.map(({ id }) => id));
checkExactKeys('query', manifest.queryLifecycle, runtimeQueries);
checkExactKeys('event', manifest.eventLifecycle, runtimeEvents);

const clients = new Set([...Object.keys(manifest.clientCoverage), ...Object.keys(manifest.queryCoverage)]);
for (const [client, ids] of Object.entries(manifest.clientCoverage)) {
  for (const id of ids) if (!commandIds.has(id)) throw new Error(`${client} coverage references unknown command ${id}`);
}
for (const [client, ids] of Object.entries(manifest.queryCoverage)) {
  for (const id of ids) if (!queryIds.has(id)) throw new Error(`${client} coverage references unknown query ${id}`);
}
for (const [client, types] of Object.entries(manifest.eventCoverage)) {
  for (const type of types) if (!eventTypes.has(type)) throw new Error(`${client} coverage references unknown event ${type}`);
}
for (const [id, required] of Object.entries(manifest.requiredClientsByCommand ?? {})) {
  if (!commandIds.has(id)) throw new Error(`required-client override references unknown command ${id}`);
  for (const client of required) if (!clients.has(client)) throw new Error(`${id} requires unknown client ${client}`);
}
for (const [client, paths] of Object.entries(manifest.evidence)) {
  if (!clients.has(client)) throw new Error(`evidence provided for unknown client ${client}`);
  for (const path of paths) {
    if (!existsSync(resolve(root, path))) throw new Error(`missing ${client} adapter evidence: ${path}`);
  }
}

for (const command of runtimeCommands) {
  const lifecycle = manifest.capabilityLifecycle[command.id];
  if (!['inProgress', 'complete', 'unavailable', 'blocked'].includes(lifecycle)) {
    throw new Error(`invalid lifecycle state for ${command.id}: ${lifecycle}`);
  }
  if (command.status === 'Unavailable' && lifecycle !== 'unavailable') {
    throw new Error(`${command.id} is unavailable in the Runtime registry but not marked unavailable in parity`);
  }
  const required = manifest.requiredClientsByCommand?.[command.id]
    ?? (command.status === 'Unavailable' ? [] : manifest.requiredClients);
  const covered = new Set(Object.entries(manifest.clientCoverage)
    .filter(([, ids]) => ids.includes(command.id))
    .map(([client]) => client));
  const gaps = required.filter((client) => !covered.has(client));
  if (lifecycle === 'complete') {
    const evidence = manifest.completeEvidence?.[command.id];
    if (command.status !== 'Supported' || gaps.length || !evidence?.verifiedAtSha
      || !evidence?.coreTests || !evidence?.apiContractTests) {
      throw new Error(`${command.id} cannot be complete: runtime, client parity, verified SHA, or core/API test evidence is missing`);
    }
    for (const client of required) {
      const path = evidence.adapterTests?.[client];
      if (!path || !existsSync(resolve(root, path))) {
        throw new Error(`${command.id} cannot be complete: missing ${client} adapter test evidence`);
      }
    }
    for (const path of [evidence.coreTests, evidence.apiContractTests, ...Object.values(evidence.adapterTests ?? {})]) {
      if (!existsSync(resolve(root, path))) throw new Error(`${command.id} references missing completion evidence: ${path}`);
    }
  }
  if (gaps.length) console.log(`GAP command ${command.id}: ${gaps.join(', ')}`);
}

for (const id of runtimeQueries) {
  const lifecycle = manifest.queryLifecycle[id];
  if (!['inProgress', 'complete', 'blocked'].includes(lifecycle)) {
    throw new Error(`invalid query lifecycle state for ${id}: ${lifecycle}`);
  }
  const covered = new Set(Object.entries(manifest.queryCoverage)
    .filter(([, ids]) => ids.includes(id))
    .map(([client]) => client));
  const gaps = manifest.requiredClients.filter((client) => !covered.has(client));
  if (lifecycle === 'complete') {
    const evidence = manifest.completeQueryEvidence?.[id];
    if (gaps.length || !evidence?.verifiedAtSha || !evidence?.coreTests || !evidence?.apiContractTests) {
      throw new Error(`query ${id} cannot be complete: missing adapter parity or verified core/API test evidence`);
    }
    for (const client of manifest.requiredClients) {
      const path = evidence.adapterTests?.[client];
      if (!path || !existsSync(resolve(root, path))) {
        throw new Error(`query ${id} cannot be complete: missing ${client} adapter test evidence`);
      }
    }
  }
  if (gaps.length) console.log(`GAP query ${id}: ${gaps.join(', ')}`);
}

for (const type of runtimeEvents) {
  const lifecycle = manifest.eventLifecycle[type];
  if (!['inProgress', 'complete', 'blocked'].includes(lifecycle)) {
    throw new Error(`invalid event lifecycle state for ${type}: ${lifecycle}`);
  }
  const covered = new Set(Object.entries(manifest.eventCoverage)
    .filter(([, types]) => types.includes(type))
    .map(([client]) => client));
  const gaps = manifest.requiredClients.filter((client) => !covered.has(client));
  if (lifecycle === 'complete') {
    const evidence = manifest.completeEventEvidence?.[type];
    if (gaps.length || !evidence?.verifiedAtSha || !evidence?.coreTests || !evidence?.apiContractTests) {
      throw new Error(`event ${type} cannot be complete: missing client parity or verified core/API evidence`);
    }
    for (const client of manifest.requiredClients) {
      const path = evidence.adapterTests?.[client];
      if (!path || !existsSync(resolve(root, path))) {
        throw new Error(`event ${type} cannot be complete: missing ${client} adapter test evidence`);
      }
    }
    for (const path of [evidence.coreTests, evidence.apiContractTests, ...Object.values(evidence.adapterTests ?? {})]) {
      if (!existsSync(resolve(root, path))) throw new Error(`event ${type} references missing completion evidence: ${path}`);
    }
  }
  if (gaps.length) console.log(`GAP event ${type}: ${gaps.join(', ')}`);
}

console.log(`Control Plane parity inventory: ${runtimeCommands.length} commands, ${runtimeQueries.length} queries, ${runtimeEvents.length} event types; ${Object.values(manifest.capabilityLifecycle).filter((state) => state === 'complete').length} complete commands.`);
