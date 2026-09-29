import fs from 'node:fs';
import process from 'node:process';

const root = process.cwd();
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const contract = JSON.parse(read('docs/contracts/runtime-capabilities.json'));
const rustModel = read('crates/nova-core-model/src/lib.rs');
const engineCapabilities = read('src-tauri/src/daemon/engine_capabilities.rs');
const engineRoutes = read('src-tauri/src/daemon/routes/engine.rs');
const extensionSchema = read('browser-extension/src/contracts/capabilities.schema.ts');

const errors = [];
const expectedStates = contract.taskLifecycle.states;
if (!Number.isInteger(contract.contractVersion) || contract.contractVersion < 1) {
  errors.push('contractVersion must be a positive integer');
}
if (!Number.isInteger(contract.capabilityRegistryVersion) || contract.capabilityRegistryVersion < 1) {
  errors.push('capabilityRegistryVersion must be a positive integer');
}
if (new Set(expectedStates).size !== expectedStates.length) {
  errors.push('task lifecycle states must be unique');
}
for (const terminal of contract.taskLifecycle.terminalStates) {
  if (!expectedStates.includes(terminal)) errors.push(`terminal state ${terminal} is not a lifecycle state`);
}
for (const [name, fixture] of Object.entries(contract.fixtures ?? {})) {
  if (fixture.contractVersion !== contract.contractVersion) {
    errors.push(`fixture ${name} uses contractVersion ${fixture.contractVersion}`);
  }
  if (fixture.capabilityRegistryVersion !== contract.capabilityRegistryVersion) {
    errors.push(`fixture ${name} uses capabilityRegistryVersion ${fixture.capabilityRegistryVersion}`);
  }
  if (JSON.stringify(fixture.taskLifecycle) !== JSON.stringify(contract.taskLifecycle)) {
    errors.push(`fixture ${name} lifecycle contract diverges from the canonical definition`);
  }
}

const requiredSourceFragments = [
  [rustModel, 'RUNTIME_CAPABILITIES_CONTRACT_VERSION: u32 = 1', 'Rust contract version'],
  [rustModel, 'CAPABILITY_REGISTRY_CONTRACT_VERSION: u32 = 1', 'Rust capability registry version'],
  [rustModel, 'TASK_LIFECYCLE_WIRE_STATES', 'Rust lifecycle state list'],
  [engineCapabilities, '"contractVersion": nova_core_model::RUNTIME_CAPABILITIES_CONTRACT_VERSION', 'daemon contract version'],
  [engineCapabilities, '"capabilityRegistryVersion": nova_core_model::CAPABILITY_REGISTRY_CONTRACT_VERSION', 'daemon capability registry version'],
  [engineCapabilities, '"cancelSemantics": "remove"', 'daemon cancel semantics'],
  [engineRoutes, '"taskLifecycle": status.get("taskLifecycle")', 'extension capability lifecycle propagation'],
  [extensionSchema, 'contractVersion: z.number().int().min(1)', 'extension contract version schema'],
  [extensionSchema, 'capabilityRegistryVersion: z.number().int().min(1)', 'extension capability registry version schema'],
  [extensionSchema, "cancelSemantics: z.literal('remove')", 'extension cancel semantics schema'],
  [extensionSchema, "unknownStatePolicy: z.literal('reject')", 'extension unknown-state policy'],
];

for (const [source, fragment, label] of requiredSourceFragments) {
  if (!source.includes(fragment)) errors.push(`${label} is missing`);
}
for (const state of expectedStates) {
  if (!rustModel.includes(`"${state}"`)) errors.push(`Rust lifecycle state missing: ${state}`);
  if (!extensionSchema.includes(`'${state}'`)) errors.push(`Extension lifecycle state missing: ${state}`);
}

if (errors.length) {
  console.error('Runtime contract check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Runtime contract v${contract.contractVersion} and capability registry v${contract.capabilityRegistryVersion} are consistent across Rust and TypeScript consumers.`);
