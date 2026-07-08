fn main() {
    let libcurl_version = std::env::var("NOVA_EXPECT_LIBCURL_VERSION").unwrap_or_else(|_| "unmanaged".to_string());
    let libcurl_tag = std::env::var("NOVA_EXPECT_LIBCURL_TAG").unwrap_or_else(|_| "unmanaged".to_string());
    let libcurl_sha256 = std::env::var("NOVA_EXPECT_LIBCURL_SHA256").unwrap_or_else(|_| "unmanaged".to_string());
    let libcurl_prefix = std::env::var("NOVA_LIBCURL_PREFIX").unwrap_or_else(|_| "unmanaged".to_string());
    let libcurl_link_mode = std::env::var("NOVA_LIBCURL_LINK_MODE").unwrap_or_else(|_| "system-or-vendored-fallback".to_string());
    let libcurl_protocols = std::env::var("NOVA_EXPECT_LIBCURL_PROTOCOLS").unwrap_or_else(|_| "unmanaged".to_string());
    let libcurl_features = std::env::var("NOVA_EXPECT_LIBCURL_FEATURES").unwrap_or_else(|_| "unmanaged".to_string());
    let libcurl_feature_profile = std::env::var("NOVA_LIBCURL_FEATURE_PROFILE").unwrap_or_else(|_| "maximum-stable".to_string());

    println!("cargo:rerun-if-env-changed=NOVA_EXPECT_LIBCURL_VERSION");
    println!("cargo:rerun-if-env-changed=NOVA_EXPECT_LIBCURL_TAG");
    println!("cargo:rerun-if-env-changed=NOVA_EXPECT_LIBCURL_SHA256");
    println!("cargo:rerun-if-env-changed=NOVA_LIBCURL_PREFIX");
    println!("cargo:rerun-if-env-changed=NOVA_LIBCURL_LINK_MODE");
    println!("cargo:rerun-if-env-changed=NOVA_EXPECT_LIBCURL_PROTOCOLS");
    println!("cargo:rerun-if-env-changed=NOVA_EXPECT_LIBCURL_FEATURES");
    println!("cargo:rerun-if-env-changed=NOVA_LIBCURL_FEATURE_PROFILE");
    println!("cargo:rustc-env=NOVA_BUILD_LIBCURL_VERSION={}", libcurl_version);
    println!("cargo:rustc-env=NOVA_BUILD_LIBCURL_TAG={}", libcurl_tag);
    println!("cargo:rustc-env=NOVA_BUILD_LIBCURL_SHA256={}", libcurl_sha256);
    println!("cargo:rustc-env=NOVA_BUILD_LIBCURL_PREFIX={}", libcurl_prefix);
    println!("cargo:rustc-env=NOVA_BUILD_LIBCURL_LINK_MODE={}", libcurl_link_mode);
    println!("cargo:rustc-env=NOVA_BUILD_LIBCURL_PROTOCOLS={}", libcurl_protocols);
    println!("cargo:rustc-env=NOVA_BUILD_LIBCURL_FEATURES={}", libcurl_features);
    println!("cargo:rustc-env=NOVA_BUILD_LIBCURL_FEATURE_PROFILE={}", libcurl_feature_profile);

    tauri_build::build()
}
