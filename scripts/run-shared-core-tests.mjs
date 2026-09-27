import { spawnSync } from 'node:child_process';

const manifests = [
  'crates/nova-core-model/Cargo.toml',
  'crates/nova-download-core/Cargo.toml',
  'crates/nova-mobile-core/Cargo.toml',
  'crates/nova-mobile-ffi/Cargo.toml',
  'crates/nova-stream-core/Cargo.toml',
  'crates/nova-media-core/Cargo.toml',
  'crates/nova-media-processing-core/Cargo.toml',
  'crates/nova-torrent-core/Cargo.toml',
];

for (const manifest of manifests) {
  console.log(`\n=== cargo test --manifest-path ${manifest} ===`);
  const result = spawnSync('cargo', ['test', '--manifest-path', manifest], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('\nAll shared-core test suites passed.');
