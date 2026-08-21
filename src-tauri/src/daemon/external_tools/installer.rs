use super::health;
use super::types::{ExternalTool, InstallScope, ToolId, UpdateInfo};
use crate::daemon::external_tools::registry;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Cursor};
use std::path::{Component, Path};
use uuid::Uuid;

const GITHUB_API_USER_AGENT: &str = "NOVA-DownloadManager";
// yt-dlp upstream recommends its nightly channel for regular use because
// extractors such as YouTube change independently of monthly stable releases.
const YTDLP_RELEASE_REPOSITORY: &str = "yt-dlp/yt-dlp-nightly-builds";

pub fn check_latest_version(tool: &dyn ExternalTool, _http: &reqwest::Client) -> UpdateInfo {
    let os_pattern = match std::env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" | "darwin" => "macos",
        other => other,
    };
    let arch_pattern = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        other => other,
    };

    match tool.id() {
        ToolId::YtDlp => check_ytdlp_latest(os_pattern, arch_pattern),
        ToolId::Ffmpeg => check_ffmpeg_latest(os_pattern, arch_pattern),
    }
    .unwrap_or_else(|error| UpdateInfo {
        available: false,
        current_version: None,
        latest_version: None,
        download_url: None,
        expected_sha256: None,
        release_notes: Some(format!("Unable to check for updates safely: {error}")),
        published_at: None,
    })
}

fn github_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Failed to create GitHub client: {error}"))
}

fn latest_release(repo: &str) -> Result<serde_json::Value, String> {
    let response = github_client()?
        .get(format!(
            "https://api.github.com/repos/{repo}/releases/latest"
        ))
        .header("User-Agent", GITHUB_API_USER_AGENT)
        .send()
        .map_err(|error| format!("GitHub API request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("GitHub API returned an error: {error}"))?;
    response
        .json()
        .map_err(|error| format!("Failed to parse GitHub release metadata: {error}"))
}

fn asset_sha256(asset: &serde_json::Value) -> Option<String> {
    let digest = asset.get("digest").and_then(|value| value.as_str())?.trim();
    let hash = digest.strip_prefix("sha256:").unwrap_or(digest);
    if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(hash.to_ascii_lowercase())
    } else {
        None
    }
}

fn release_metadata(json: &serde_json::Value) -> (String, Option<String>) {
    let tag = json
        .get("tag_name")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let published_at = json
        .get("published_at")
        .and_then(|value| value.as_str())
        .map(str::to_owned);
    (tag, published_at)
}

fn selected_asset(
    json: &serde_json::Value,
    predicate: impl Fn(&str) -> bool,
) -> Option<&serde_json::Value> {
    json.get("assets")
        .and_then(|value| value.as_array())
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset
                    .get("name")
                    .and_then(|value| value.as_str())
                    .is_some_and(&predicate)
            })
        })
}

fn update_info_from_asset(
    latest_version: String,
    published_at: Option<String>,
    asset: Option<&serde_json::Value>,
    release_notes: String,
) -> UpdateInfo {
    let download_url = asset
        .and_then(|item| {
            item.get("browser_download_url")
                .and_then(|value| value.as_str())
        })
        .filter(|url| is_trusted_release_asset_url(url))
        .map(str::to_owned);
    let expected_sha256 = asset.and_then(asset_sha256);
    let checksum_available = expected_sha256.is_some();
    let available = download_url.is_some() && checksum_available;
    let release_notes = if available {
        format!("{release_notes} SHA-256 will be verified before installation.")
    } else {
        format!("{release_notes} Automatic installation is unavailable because no compatible asset with a published SHA-256 digest was found.")
    };

    UpdateInfo {
        available,
        current_version: None,
        latest_version: Some(latest_version),
        download_url,
        expected_sha256,
        release_notes: Some(release_notes),
        published_at,
    }
}

fn check_ffmpeg_latest(os: &str, arch: &str) -> Result<UpdateInfo, String> {
    let json = latest_release("BtbN/FFmpeg-Builds")?;
    let (latest_version, published_at) = release_metadata(&json);
    let asset = selected_asset(&json, |name| match (os, arch) {
        ("windows", "x86_64") => {
            name.contains("win64") && name.contains("ffmpeg") && name.ends_with(".zip")
        }
        ("linux", "x86_64") => {
            name.contains("linux64") && name.contains("ffmpeg") && name.ends_with(".tar.xz")
        }
        _ => false,
    });
    Ok(update_info_from_asset(
        latest_version,
        published_at,
        asset,
        "FFmpeg build from BtbN/FFmpeg-Builds.".to_owned(),
    ))
}

fn check_ytdlp_latest(os: &str, arch: &str) -> Result<UpdateInfo, String> {
    let json = latest_release(YTDLP_RELEASE_REPOSITORY)?;
    let (latest_version, published_at) = release_metadata(&json);
    let asset = selected_asset(&json, |name| match (os, arch) {
        ("windows", "x86_64") => name == "yt-dlp.exe",
        ("linux", "x86_64") => name == "yt-dlp_linux",
        ("linux", "aarch64") => name == "yt-dlp_linux_aarch64",
        ("macos", "x86_64" | "aarch64") => name == "yt-dlp_macos",
        _ => false,
    });
    let upstream_notes = json
        .get("body")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| "Official yt-dlp nightly build.".to_owned());
    Ok(update_info_from_asset(
        latest_version,
        published_at,
        asset,
        upstream_notes,
    ))
}

fn is_trusted_release_asset_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    matches!(
        parsed.host_str(),
        Some("github.com")
            | Some("objects.githubusercontent.com")
            | Some("release-assets.githubusercontent.com")
            | Some("github-releases.githubusercontent.com")
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn tool_executable_name(tool: &dyn ExternalTool) -> Result<&'static str, String> {
    tool.executable_names()
        .into_iter()
        .next()
        .ok_or_else(|| format!("{} does not declare an executable name", tool.name()))
}

fn archive_entry_matches(path: &Path, executable_name: &str) -> bool {
    let is_safe = path
        .components()
        .all(|component| matches!(component, Component::Normal(_)));
    is_safe
        && path.file_name().and_then(|name| name.to_str()) == Some(executable_name)
        && path
            .components()
            .any(|component| component.as_os_str() == "bin")
}

fn extract_zip_executable(
    bytes: &[u8],
    executable_name: &str,
    destination: &Path,
) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Invalid ZIP release asset: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read ZIP entry: {error}"))?;
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        if !archive_entry_matches(&path, executable_name) || entry.is_dir() {
            continue;
        }
        let mut output = File::create(destination)
            .map_err(|error| format!("Failed to create staged executable: {error}"))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract executable from ZIP: {error}"))?;
        return Ok(());
    }
    Err(format!(
        "Release archive does not contain bin/{executable_name}"
    ))
}

fn extract_tar_xz_executable(
    bytes: &[u8],
    executable_name: &str,
    destination: &Path,
) -> Result<(), String> {
    let decoder = xz2::read::XzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Invalid TAR.XZ release asset: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("Failed to read TAR entry: {error}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|error| format!("Failed to inspect TAR entry: {error}"))?;
        if !archive_entry_matches(&path, executable_name) {
            continue;
        }
        let mut output = File::create(destination)
            .map_err(|error| format!("Failed to create staged executable: {error}"))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract executable from TAR.XZ: {error}"))?;
        return Ok(());
    }
    Err(format!(
        "Release archive does not contain bin/{executable_name}"
    ))
}

fn materialize_executable(
    bytes: &[u8],
    download_url: &str,
    executable_name: &str,
    staged_path: &Path,
) -> Result<(), String> {
    let asset_path = download_url
        .split('?')
        .next()
        .unwrap_or(download_url)
        .to_ascii_lowercase();
    if asset_path.ends_with(".zip") {
        extract_zip_executable(bytes, executable_name, staged_path)
    } else if asset_path.ends_with(".tar.xz") {
        extract_tar_xz_executable(bytes, executable_name, staged_path)
    } else {
        fs::write(staged_path, bytes)
            .map_err(|error| format!("Failed to write staged executable: {error}"))
    }
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("Failed to set executable permissions: {error}"))
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn atomic_replace(staged_path: &Path, destination: &Path) -> Result<(), String> {
    let backup_path = destination.with_extension(format!("nova-backup-{}", Uuid::new_v4()));
    let had_existing = destination.exists();
    if had_existing {
        fs::rename(destination, &backup_path).map_err(|error| {
            format!("Failed to stage existing executable for replacement: {error}")
        })?;
    }
    if let Err(error) = fs::rename(staged_path, destination) {
        if had_existing {
            let _ = fs::rename(&backup_path, destination);
        }
        return Err(format!("Failed to atomically install executable: {error}"));
    }
    if had_existing {
        fs::remove_file(&backup_path).map_err(|error| {
            format!("Installed executable but could not remove backup: {error}")
        })?;
    }
    Ok(())
}

#[cfg(windows)]
fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn install_system_executable(staged_path: &Path, destination: &Path) -> Result<(), String> {
    use crate::daemon::utils::hide_command_window;
    use std::process::Command;

    let parent = destination
        .parent()
        .ok_or("System installation destination has no parent directory")?;
    let backup = destination.with_extension(format!("nova-backup-{}", Uuid::new_v4()));
    let script_path = staged_path.with_extension("nova-install.ps1");
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n$source = {}\n$destination = {}\n$parent = {}\n$backup = {}\nNew-Item -ItemType Directory -Force -Path $parent | Out-Null\n$hadExisting = Test-Path -LiteralPath $destination\nif ($hadExisting) {{ Move-Item -LiteralPath $destination -Destination $backup -Force }}\ntry {{ Move-Item -LiteralPath $source -Destination $destination -Force; if ($hadExisting) {{ Remove-Item -LiteralPath $backup -Force }} }} catch {{ if ($hadExisting -and (Test-Path -LiteralPath $backup)) {{ Move-Item -LiteralPath $backup -Destination $destination -Force }}; throw }}\n",
        powershell_single_quoted(&staged_path.display().to_string()),
        powershell_single_quoted(&destination.display().to_string()),
        powershell_single_quoted(&parent.display().to_string()),
        powershell_single_quoted(&backup.display().to_string()),
    );
    fs::write(&script_path, script)
        .map_err(|error| format!("Failed to create elevated installation script: {error}"))?;
    let launcher = format!(
        "$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',{}); if ($null -eq $p -or $p.ExitCode -ne 0) {{ exit 1 }}",
        powershell_single_quoted(&script_path.display().to_string()),
    );
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
    ]);
    command.arg(launcher);
    hide_command_window(&mut command);
    let result = command.status().map_err(|error| {
        format!("Failed to request administrator approval for system installation: {error}")
    });
    let _ = fs::remove_file(&script_path);
    match result {
        Ok(status) if status.success() && destination.is_file() => Ok(()),
        Ok(_) => Err("System installation was cancelled, denied, or did not create the requested executable.".to_owned()),
        Err(error) => Err(error),
    }
}

pub fn download_and_install(
    tool: &dyn ExternalTool,
    update_info: &UpdateInfo,
    install_dir: &Path,
    http: &reqwest::Client,
    data_dir: &str,
    scope: InstallScope,
) -> Result<String, String> {
    let download_url = update_info
        .download_url
        .as_deref()
        .ok_or("No download URL available")?;
    let expected_sha256 = update_info
        .expected_sha256
        .as_deref()
        .ok_or("Automatic installation requires a published SHA-256 digest")?;
    if !is_trusted_release_asset_url(download_url) {
        return Err("Refusing an external-tool download from an untrusted source".to_owned());
    }
    if !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) || expected_sha256.len() != 64
    {
        return Err("Release metadata contains an invalid SHA-256 digest".to_owned());
    }
    // System directories require elevation on Windows. Keep the downloaded
    // binary in a user-writable NOVA staging directory until its digest and
    // health are verified, then request an explicit UAC-approved final move.
    let staging_dir = match scope {
        InstallScope::User => install_dir.to_path_buf(),
        InstallScope::System => Path::new(data_dir)
            .join("external_tools")
            .join(".staging")
            .join(tool.id().as_str()),
    };
    fs::create_dir_all(&staging_dir)
        .map_err(|error| format!("Failed to create installation staging directory: {error}"))?;

    // Installation runs in a dedicated blocking worker. A blocking client
    // avoids nesting or dropping a Tokio runtime, so the same verified path is
    // safe in the daemon, test suite, and command-line contexts.
    let _ = http;
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| format!("Failed to create release download client: {error}"))?
        .get(download_url)
        .send()
        .map_err(|error| format!("Download request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Release download failed: {error}"))?;
    if !is_trusted_release_asset_url(response.url().as_str()) {
        return Err("Release download redirected to an untrusted source".to_owned());
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("Failed to read release download: {error}"))?;
    let checksum = sha256_hex(&bytes);
    if !checksum.eq_ignore_ascii_case(expected_sha256) {
        return Err(
            "Release SHA-256 verification failed; the downloaded asset was discarded".to_owned(),
        );
    }

    let executable_name = tool_executable_name(tool)?;
    let staged_path = staging_dir.join(format!(
        ".nova-install-{}-{executable_name}",
        Uuid::new_v4()
    ));
    let install_result = (|| {
        materialize_executable(&bytes, download_url, executable_name, &staged_path)?;
        mark_executable(&staged_path)?;
        let report = health::check_health(tool, &staged_path);
        if !report.executable_works || !report.status.is_available() {
            return Err(report.error_message.unwrap_or_else(|| {
                format!("{} did not pass post-install validation", tool.name())
            }));
        }
        let destination = install_dir.join(executable_name);
        match scope {
            InstallScope::User => atomic_replace(&staged_path, &destination)?,
            InstallScope::System => {
                #[cfg(windows)]
                install_system_executable(&staged_path, &destination)?;
                #[cfg(not(windows))]
                return Err("System-wide installation is supported on Windows only. Choose the current-user location.".to_owned());
            }
        }
        let path_str = destination.display().to_string();
        let version = report
            .version_detected
            .as_deref()
            .or(update_info.latest_version.as_deref());
        let mut registry = registry::load_registry(data_dir);
        registry::register_tool(
            &mut registry,
            tool.id().as_str(),
            &path_str,
            version,
            true,
            false,
            scope,
        );
        if let Some(entry) = registry.tools.get_mut(tool.id().as_str()) {
            entry.checksum_sha256 = Some(checksum.clone());
        }
        registry::save_registry(data_dir, &registry)?;
        Ok(path_str)
    })();
    if install_result.is_err() {
        let _ = fs::remove_file(&staged_path);
    }
    install_result
}

pub fn uninstall_tool(
    tool: &dyn ExternalTool,
    path: &Path,
    installed_by_app: bool,
    data_dir: &str,
) -> Result<(), String> {
    if !installed_by_app {
        return Err(format!(
            "{} was installed outside the application. The application cannot safely remove it automatically.",
            tool.name()
        ));
    }

    if path.exists() && path.is_file() {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to remove {}: {error}", path.display()))?;
    }

    let mut registry = registry::load_registry(data_dir);
    registry::unregister_tool(&mut registry, tool.id().as_str());
    registry::save_registry(data_dir, &registry)
}

#[cfg(test)]
mod tests {
    use super::{
        archive_entry_matches, asset_sha256, check_ytdlp_latest, download_and_install,
        is_trusted_release_asset_url, sha256_hex,
    };
    use crate::daemon::external_tools::health;
    use crate::daemon::external_tools::tools::yt_dlp::YtDlpTool;
    use crate::daemon::external_tools::types::InstallScope;
    use std::path::Path;

    #[test]
    fn accepts_only_well_formed_github_asset_digests() {
        let valid = serde_json::json!({"digest": format!("sha256:{}", "a".repeat(64))});
        assert_eq!(asset_sha256(&valid), Some("a".repeat(64)));
        assert!(asset_sha256(&serde_json::json!({"digest": "sha256:short"})).is_none());
    }

    #[test]
    fn verifies_digest_and_release_hosts() {
        assert_eq!(
            sha256_hex(b"nova"),
            "19e05df6b2e5fb94f3ee7eed2c02d340a1128a00231f5f6949641a143ab3b57a"
        );
        assert!(is_trusted_release_asset_url(
            "https://github.com/yt-dlp/yt-dlp/releases/download/v1/yt-dlp"
        ));
        assert!(!is_trusted_release_asset_url(
            "http://github.com/yt-dlp/yt-dlp/releases/download/v1/yt-dlp"
        ));
        assert!(!is_trusted_release_asset_url("https://example.test/tool"));
    }

    #[test]
    fn archive_selection_requires_a_safe_bin_executable() {
        assert!(archive_entry_matches(
            Path::new("ffmpeg/bin/ffmpeg"),
            "ffmpeg"
        ));
        assert!(!archive_entry_matches(Path::new("../bin/ffmpeg"), "ffmpeg"));
        assert!(!archive_entry_matches(
            Path::new("ffmpeg/readme.txt"),
            "ffmpeg"
        ));
    }

    #[test]
    #[ignore = "downloads the current official yt-dlp release and is run as a live acceptance check"]
    fn live_ytdlp_release_installs_verifies_and_executes() {
        if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "nova-live-ytdlp-install-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let install_dir = root.join("install");
        let data_dir = root.join("data");
        std::fs::create_dir_all(&data_dir).expect("create data directory");
        let update =
            check_ytdlp_latest("linux", "x86_64").expect("fetch official release metadata");
        assert!(
            update.available,
            "official yt-dlp binary must publish a SHA-256 digest"
        );
        let result = download_and_install(
            &YtDlpTool,
            &update,
            &install_dir,
            &reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(90))
                .build()
                .expect("create HTTP client"),
            &data_dir.display().to_string(),
            InstallScope::User,
        );
        let installed =
            result.expect("download, digest verification, health check, and atomic install");
        let report = health::check_health(&YtDlpTool, Path::new(&installed));
        assert!(
            report.executable_works && report.status.is_available(),
            "installed yt-dlp failed health check: {:?}",
            report.error_message
        );
        assert!(
            report.version_detected.is_some(),
            "installed yt-dlp must report a version"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
