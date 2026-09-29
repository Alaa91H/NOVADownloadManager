# NOVA local AVIF codec patch

This directory vendors the `rff-codec-avif` 0.2.0 crate from the Remade FFmpeg
Rust project under its Apache-2.0 license. The original crates.io archive SHA-256
is `6a97214f22000219589e2eddb9ff4be74c7db1bd4e5446f9757a53dcba726e69`; its
upstream revision is recorded in `.cargo_vcs_info.json`.

NOVA builds this codec without ARM assembly because the published crate archive
omits headers included by its ARM64 assembly sources. Assembly remains enabled
for x86_64, while ARM uses the codec's portable Rust implementation. AV1
encoding threading remains enabled on non-WASM targets.
