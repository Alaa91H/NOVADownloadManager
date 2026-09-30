import fs from 'node:fs';
import process from 'node:process';

const root = process.cwd();
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const contract = JSON.parse(read('docs/contracts/runtime-capabilities.json'));
const rustModel = read('crates/nova-core-model/src/lib.rs');
const capabilityRegistryModel = read('crates/nova-core-model/src/capability_registry.rs');
const engineCapabilities = read('src-tauri/src/daemon/engine_capabilities.rs');
const engineRoutes = read('src-tauri/src/daemon/routes/engine.rs');
const extensionSchema = read('browser-extension/src/contracts/capabilities.schema.ts');
const mobileFfi = read('crates/nova-mobile-ffi/src/lib.rs');
const androidNativeCore = read('android/app/src/main/java/com/nova/downloadmanager/core/NovaNativeCore.kt');
const desktopMediaPage = read('desktop-native/qml/pages/MediaDownloaderPage.qml');
const desktopBatchPage = read('desktop-native/qml/pages/BatchImportPage.qml');
const desktopApiHeader = read('desktop-native/src/api/NovaApiClient.h');
const desktopApiSource = read('desktop-native/src/api/NovaApiClient.cpp');

const errors = [];
const expectedStates = contract.taskLifecycle.states;
if (!Number.isInteger(contract.contractVersion) || contract.contractVersion < 1) {
  errors.push('contractVersion must be a positive integer');
}
if (!Number.isInteger(contract.capabilityRegistryVersion) || contract.capabilityRegistryVersion < 1) {
  errors.push('capabilityRegistryVersion must be a positive integer');
}
const registrySchema = contract.capabilityRegistrySchema;
const registryStatuses = ['supported', 'unavailable', 'experimental', 'platformRestricted'];
if (registrySchema?.properties?.schemaVersion?.const !== contract.capabilityRegistryVersion) {
  errors.push('capabilityRegistrySchema version must match capabilityRegistryVersion');
}
if (registrySchema?.properties?.sourceOfTruth?.const !== 'rust-runtime') {
  errors.push('capabilityRegistrySchema must declare rust-runtime as the source of truth');
}
const registryEntrySchema = registrySchema?.properties?.entries?.items;
for (const status of registryStatuses) {
  if (!registryEntrySchema?.properties?.status?.enum?.includes(status)
      || !registryEntrySchema?.properties?.clientAdapters?.additionalProperties?.enum?.includes(status)) {
    errors.push(`capabilityRegistrySchema is missing status ${status}`);
  }
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

const idsFrom = (source, patterns) => patterns
  .flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]))
  .sort();
const daemonCapabilityIds = idsFrom(
  read('src-tauri/src/daemon/capability_registry.rs'),
  [/\bentry\(\s*"([^"]+)"/g, /\bcommand_group\(\s*command_capabilities,\s*"([^"]+)"/g],
);
const mobileCapabilityIds = idsFrom(mobileFfi, [/\bmobile_capability_entry\(\s*"([^"]+)"/g]);
const duplicates = (values) => values.filter((value, index) => values.indexOf(value) !== index);
if (duplicates(daemonCapabilityIds).length) {
  errors.push(`daemon capability IDs must be unique: ${duplicates(daemonCapabilityIds).join(', ')}`);
}
if (duplicates(mobileCapabilityIds).length) {
  errors.push(`Android capability IDs must be unique: ${duplicates(mobileCapabilityIds).join(', ')}`);
}
if (JSON.stringify(daemonCapabilityIds) !== JSON.stringify(mobileCapabilityIds)) {
  const daemonOnly = daemonCapabilityIds.filter((id) => !mobileCapabilityIds.includes(id));
  const mobileOnly = mobileCapabilityIds.filter((id) => !daemonCapabilityIds.includes(id));
  errors.push(`Android capability IDs diverge from daemon; daemon-only=[${daemonOnly.join(', ')}], Android-only=[${mobileOnly.join(', ')}]`);
}

const requiredSourceFragments = [
  [rustModel, 'RUNTIME_CAPABILITIES_CONTRACT_VERSION: u32 = 1', 'Rust contract version'],
  [rustModel, 'CAPABILITY_REGISTRY_CONTRACT_VERSION: u32 = 2', 'Rust capability registry version'],
  [capabilityRegistryModel, 'pub struct CapabilityRegistry', 'shared capability registry model'],
  [JSON.stringify(registryEntrySchema?.required ?? []), '"clientAdapters"', 'registry client adapter field contract'],
  [extensionSchema, 'CapabilityRegistrySchema', 'extension capability registry schema'],
  [rustModel, 'TASK_LIFECYCLE_WIRE_STATES', 'Rust lifecycle state list'],
  [engineCapabilities, '"contractVersion": nova_core_model::RUNTIME_CAPABILITIES_CONTRACT_VERSION', 'daemon contract version'],
  [engineCapabilities, '"capabilityRegistryVersion": nova_core_model::CAPABILITY_REGISTRY_CONTRACT_VERSION', 'daemon capability registry version'],
  [engineCapabilities, '"capabilityRegistry": capability_registry', 'daemon unified registry output'],
  [engineCapabilities, '"cancelSemantics": "remove"', 'daemon cancel semantics'],
  [engineRoutes, '"taskLifecycle": status.get("taskLifecycle")', 'extension capability lifecycle propagation'],
  [engineRoutes, 'runtime_capability_supported(status, "download.direct")', 'extension direct capability registry consumption'],
  [engineRoutes, 'runtime_capability_supported(status, "torrent.file")', 'extension torrent capability registry consumption'],
  [engineRoutes, 'runtime_capability_supported(status, "media.hls")', 'extension streaming capability registry consumption'],
  [extensionSchema, 'contractVersion: z.number().int().min(1)', 'extension contract version schema'],
  [extensionSchema, 'capabilityRegistryVersion: z.number().int().min(1)', 'extension capability registry version schema'],
  [mobileFfi, '"capabilityRegistryVersion": nova_core_model::NATIVE_MEDIA_CODEC_REGISTRY_SCHEMA_VERSION', 'Android codec registry version'],
  [mobileFfi, 'BRIDGE_API_VERSION: u32 = 5', 'Android JNI bridge version'],
  [mobileFfi, 'fn mobile_runtime_capability_registry_json()', 'Android runtime capability registry source'],
  [mobileFfi, 'nativeRuntimeCapabilityRegistryJson', 'Android JNI capability registry export'],
  [androidNativeCore, 'capabilityRegistryVersion = root.optInt("capabilityRegistryVersion", 0)', 'Android capability registry version parsing'],
  [androidNativeCore, 'CLIENT_BRIDGE_API_VERSION = 5', 'Android client bridge version'],
  [androidNativeCore, 'fun runtimeCapabilityRegistry(): NativeCapabilityRegistry', 'Android capability registry parser'],
  [desktopApiHeader, 'Q_INVOKABLE bool runtimeCapabilitySupported', 'Qt runtime capability adapter declaration'],
  [desktopApiSource, 'QString NovaApiClient::runtimeCapabilityStatus', 'Qt runtime capability adapter implementation'],
  [desktopMediaPage, 'capabilitySupported("media.extraction")', 'Qt media extraction capability gate'],
  [desktopMediaPage, 'capabilitySupported("media.audioTranscode")', 'Qt audio transcode capability gate'],
  [desktopMediaPage, 'capabilitySupported("media.videoTranscode")', 'Qt video transcode capability gate'],
  [desktopMediaPage, 'capabilitySupported("media.nativeMux")', 'Qt native mux capability gate'],
  [desktopBatchPage, 'capabilitySupported("download.direct")', 'Qt direct download capability gate'],
  [desktopMediaPage, 'capabilities.nativeCodecRegistry', 'Qt media capability registry consumption'],
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
