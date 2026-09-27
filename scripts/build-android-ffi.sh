#!/usr/bin/env bash
# Builds the NOVA UniFFI bridge for one Android ABI. The generated shared
# library is intentionally local build output; generated Kotlin bindings and
# task commands are added only in the next bridge-contract milestone.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ndk_version="${ANDROID_NDK_VERSION:-28.2.13676358}"
android_sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/.local/android-sdk}}"
ndk_root="${ANDROID_NDK_HOME:-$android_sdk_root/ndk/$ndk_version}"
ndk_bin="$ndk_root/toolchains/llvm/prebuilt/linux-x86_64/bin"
abi="${1:-arm64-v8a}"

case "$abi" in
  arm64-v8a)
    rust_target="aarch64-linux-android"
    clang_target="aarch64-linux-android26-clang"
    ;;
  armeabi-v7a)
    rust_target="armv7-linux-androideabi"
    clang_target="armv7a-linux-androideabi26-clang"
    ;;
  x86_64)
    rust_target="x86_64-linux-android"
    clang_target="x86_64-linux-android26-clang"
    ;;
  *)
    echo "Unsupported ABI: $abi (use arm64-v8a, armeabi-v7a, or x86_64)" >&2
    exit 2
    ;;
esac

if [[ ! -x "$ndk_bin/$clang_target" ]]; then
  echo "NDK linker not found: $ndk_bin/$clang_target" >&2
  exit 1
fi

export PATH="$HOME/.cargo/bin:$PATH"
rustup target add "$rust_target"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo_root/.build/android-rust}"
target_env_key="${rust_target^^}"
target_env_key="${target_env_key//-/_}"
compiler_env_key="${rust_target//-/_}"
export "CARGO_TARGET_${target_env_key}_LINKER=$ndk_bin/$clang_target"
export "CC_${compiler_env_key}=$ndk_bin/$clang_target"
export "AR_${compiler_env_key}=$ndk_bin/llvm-ar"

cargo build \
  --manifest-path "$repo_root/crates/nova-mobile-ffi/Cargo.toml" \
  --release \
  --target "$rust_target"

source_library="$CARGO_TARGET_DIR/$rust_target/release/libnova_mobile_ffi.so"
output_dir="${NOVA_ANDROID_JNILIBS_DIR:-$repo_root/android/app/src/main/jniLibs}/$abi"
install -Dm755 "$source_library" "$output_dir/libnova_mobile_ffi.so"
printf 'Built %s -> %s\n' "$rust_target" "$output_dir/libnova_mobile_ffi.so"
