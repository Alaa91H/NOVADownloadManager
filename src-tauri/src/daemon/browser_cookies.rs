use std::cmp::Reverse;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};

const FIREFOX_COOKIE_DB_MAX_BYTES: u64 = 128 * 1024 * 1024;

pub const NATIVE_BROWSER_COOKIE_SOURCES: &[&str] = &["firefox"];

pub fn validate_browser_cookie_source(spec: &str) -> Result<(), String> {
    let (browser, profile) = parse_browser_cookie_source(spec)?;
    if !browser.eq_ignore_ascii_case("firefox") {
        return Err(format!(
            "Native browser-cookie import currently supports Firefox only; '{browser}' is not migrated yet"
        ));
    }
    if let Some(profile) = profile {
        validate_profile_name(profile)?;
    }
    Ok(())
}

pub fn load_browser_cookie_header(spec: &str, target_url: &str) -> Result<String, String> {
    validate_browser_cookie_source(spec)?;
    let (_, profile) = parse_browser_cookie_source(spec)?;
    let database = discover_firefox_cookie_database(profile)?;
    load_firefox_cookie_header_from_database(&database, target_url)
}

fn parse_browser_cookie_source(spec: &str) -> Result<(&str, Option<&str>), String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("Browser cookie source is empty".to_owned());
    }
    let (browser, profile) = spec
        .split_once(':')
        .map_or((spec, None), |(browser, profile)| (browser, Some(profile)));
    let browser = browser.trim();
    if browser.is_empty() {
        return Err("Browser cookie source is missing a browser name".to_owned());
    }
    if browser.contains('+') || browser.contains(',') {
        return Err(
            "Native browser-cookie import accepts one browser source at a time".to_owned(),
        );
    }
    let profile = profile.map(str::trim).filter(|value| !value.is_empty());
    Ok((browser, profile))
}

fn validate_profile_name(profile: &str) -> Result<(), String> {
    if profile.len() > 160
        || profile == "."
        || profile == ".."
        || profile.contains('/')
        || profile.contains('\\')
        || profile.contains('\0')
    {
        return Err("Firefox profile must be a profile name, not an arbitrary path".to_owned());
    }
    Ok(())
}

fn discover_firefox_cookie_database(profile: Option<&str>) -> Result<PathBuf, String> {
    let roots = firefox_roots();
    if roots.is_empty() {
        return Err("Could not determine a Firefox profile root on this platform".to_owned());
    }

    let mut candidates = Vec::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        collect_firefox_profile_databases(&root, profile, &mut candidates);
    }

    if candidates.is_empty() {
        return Err(match profile {
            Some(profile) => format!("Firefox profile '{profile}' was not found"),
            None => "No Firefox cookies.sqlite database was found".to_owned(),
        });
    }

    candidates.sort_by_key(|candidate| {
        let profile_name = candidate
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let score = if profile_name.ends_with(".default-release")
            || profile_name == "default-release"
        {
            3_u8
        } else if profile_name.ends_with(".default") || profile_name == "default" {
            2
        } else {
            1
        };
        let modified = fs::metadata(candidate)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        Reverse((score, modified))
    });

    candidates
        .into_iter()
        .next()
        .ok_or_else(|| "No Firefox cookie database was found".to_owned())
}

fn collect_firefox_profile_databases(
    root: &Path,
    requested_profile: Option<&str>,
    output: &mut Vec<PathBuf>,
) {
    let mut profile_roots = vec![root.join("Profiles"), root.to_path_buf()];
    profile_roots.sort();
    profile_roots.dedup();

    for profiles_dir in profile_roots {
        let Ok(entries) = fs::read_dir(&profiles_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let profile_name = entry.file_name().to_string_lossy().into_owned();
            if let Some(requested) = requested_profile {
                let short_name = profile_name
                    .split_once('.')
                    .map_or(profile_name.as_str(), |(_, suffix)| suffix);
                if profile_name != requested && short_name != requested {
                    continue;
                }
            }
            let database = path.join("cookies.sqlite");
            if database.is_file() {
                output.push(database);
            }
        }
    }
}

fn firefox_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    #[cfg(target_os = "windows")]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(app_data).join("Mozilla").join("Firefox"));
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Firefox"),
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.push(home.join(".mozilla").join("firefox"));
        roots.push(
            home.join(".var")
                .join("app")
                .join("org.mozilla.firefox")
                .join(".mozilla")
                .join("firefox"),
        );
    }

    roots
}

fn load_firefox_cookie_header_from_database(
    database: &Path,
    target_url: &str,
) -> Result<String, String> {
    let metadata = fs::metadata(database).map_err(|error| {
        format!(
            "Could not inspect Firefox cookie database '{}': {error}",
            database.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "Firefox cookie database '{}' is not a regular file",
            database.display()
        ));
    }
    if metadata.len() > FIREFOX_COOKIE_DB_MAX_BYTES {
        return Err(format!(
            "Firefox cookie database '{}' exceeds the {} byte native limit",
            database.display(),
            FIREFOX_COOKIE_DB_MAX_BYTES
        ));
    }

    let target = reqwest::Url::parse(target_url)
        .map_err(|_| "Invalid media URL while importing Firefox cookies".to_owned())?;
    let host = target
        .host_str()
        .ok_or_else(|| "Media URL has no host for Firefox cookie matching".to_owned())?
        .to_ascii_lowercase();
    let path = if target.path().is_empty() {
        "/"
    } else {
        target.path()
    };
    let is_https = target.scheme().eq_ignore_ascii_case("https");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);

    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        format!(
            "Could not open Firefox cookie database '{}': {error}",
            database.display()
        )
    })?;

    let mut statement = connection
        .prepare(
            "SELECT host, path, isSecure, expiry, name, value \
             FROM moz_cookies WHERE name <> ''",
        )
        .map_err(|error| format!("Could not query Firefox cookies: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(FirefoxCookie {
                host: row.get(0)?,
                path: row.get(1)?,
                secure: row.get::<_, i64>(2)? != 0,
                expiry: row.get(3)?,
                name: row.get(4)?,
                value: row.get(5)?,
            })
        })
        .map_err(|error| format!("Could not read Firefox cookies: {error}"))?;

    let mut matching = Vec::new();
    for row in rows {
        let cookie = row.map_err(|error| format!("Could not decode Firefox cookie row: {error}"))?;
        if cookie.expiry > 0 && cookie.expiry <= now {
            continue;
        }
        if cookie.secure && !is_https {
            continue;
        }
        if !cookie_domain_matches(&host, &cookie.host) {
            continue;
        }
        if !cookie_path_matches(path, &cookie.path) {
            continue;
        }
        validate_cookie_pair(&cookie.name, &cookie.value)?;
        matching.push(cookie);
    }

    matching.sort_by_key(|cookie| Reverse(cookie.path.len()));
    if matching.is_empty() {
        return Err("Firefox contains no cookies applicable to the media URL".to_owned());
    }

    Ok(matching
        .into_iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; "))
}

#[derive(Debug)]
struct FirefoxCookie {
    host: String,
    path: String,
    secure: bool,
    expiry: i64,
    name: String,
    value: String,
}

fn validate_cookie_pair(name: &str, value: &str) -> Result<(), String> {
    if name.is_empty()
        || name
            .bytes()
            .any(|byte| byte <= b' ' || matches!(byte, b';' | b',' | b'='))
        || value
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | ';'))
    {
        return Err("Firefox cookie contains characters unsafe for a Cookie header".to_owned());
    }
    Ok(())
}

fn cookie_domain_matches(host: &str, cookie_domain: &str) -> bool {
    let domain = cookie_domain
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if domain.is_empty() {
        return false;
    }
    host == domain
        || host
            .strip_suffix(&domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn cookie_path_matches(target_path: &str, cookie_path: &str) -> bool {
    let cookie_path = if cookie_path.is_empty() { "/" } else { cookie_path };
    if target_path == cookie_path {
        return true;
    }
    if !target_path.starts_with(cookie_path) {
        return false;
    }
    cookie_path.ends_with('/')
        || target_path
            .as_bytes()
            .get(cookie_path.len())
            .is_some_and(|next| *next == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }

    #[test]
    fn firefox_database_filters_domain_path_secure_and_expiry() {
        let dir = unique_temp_dir("nova-firefox-cookies");
        fs::create_dir_all(&dir).expect("cookie temp dir");
        let database = dir.join("cookies.sqlite");
        let connection = Connection::open(&database).expect("create cookie database");
        connection
            .execute_batch(
                "CREATE TABLE moz_cookies (
                    id INTEGER PRIMARY KEY,
                    host TEXT NOT NULL,
                    path TEXT NOT NULL,
                    isSecure INTEGER NOT NULL,
                    expiry INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    value TEXT NOT NULL
                );",
            )
            .expect("schema");
        let future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_secs() as i64
            + 3600;
        let past = future - 7200;
        for (host, path, secure, expiry, name, value) in [
            (".example.test", "/private", 1_i64, future, "session", "secret"),
            (".example.test", "/", 0_i64, future, "pref", "wide"),
            (".example.test", "/admin", 0_i64, future, "admin", "hidden"),
            (".other.test", "/", 0_i64, future, "other", "ignored"),
            (".example.test", "/", 0_i64, past, "expired", "ignored"),
        ] {
            connection
                .execute(
                    "INSERT INTO moz_cookies (host, path, isSecure, expiry, name, value)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    (host, path, secure, expiry, name, value),
                )
                .expect("insert cookie");
        }
        drop(connection);

        let header = load_firefox_cookie_header_from_database(
            &database,
            "https://media.example.test/private/video",
        )
        .expect("Firefox cookie header");
        assert_eq!(header, "session=secret; pref=wide");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn browser_source_rejects_unmigrated_browsers_and_arbitrary_profile_paths() {
        validate_browser_cookie_source("firefox").expect("Firefox source");
        validate_browser_cookie_source("Firefox").expect("case-insensitive Firefox source");
        validate_browser_cookie_source("firefox:default-release").expect("Firefox profile");
        assert!(validate_browser_cookie_source("chrome").is_err());
        assert!(validate_browser_cookie_source("edge").is_err());
        assert!(validate_browser_cookie_source("firefox:../../secret").is_err());
    }

    #[test]
    fn cookie_path_boundaries_match_http_cookie_rules() {
        assert!(cookie_path_matches("/private", "/private"));
        assert!(cookie_path_matches("/private/video", "/private"));
        assert!(cookie_path_matches("/anything", "/"));
        assert!(!cookie_path_matches("/private-video", "/private"));
    }
}
