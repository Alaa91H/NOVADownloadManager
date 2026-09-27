/// Shared system-info helpers for engine modules.
///
/// Centralizes platform-specific memory queries so engine modules agree on the
/// host's usable memory. On Linux, a process running in a cgroup must honor the
/// cgroup memory limit and current usage rather than treating the host's RAM as
/// available to a download process.
const FALLBACK_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[cfg(target_os = "linux")]
fn meminfo_value_bytes(content: &str, key: &str) -> Option<u64> {
    content.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?;
        let value = rest.split_whitespace().next()?.parse::<u64>().ok()?;
        Some(value.saturating_mul(1024))
    })
}

#[cfg(target_os = "linux")]
fn cgroup_value(paths: &[&str], unlimited_is_none: bool) -> Option<u64> {
    paths.iter().find_map(|path| {
        let value = std::fs::read_to_string(path).ok()?;
        let value = value.trim();
        if unlimited_is_none && value.eq_ignore_ascii_case("max") {
            return None;
        }
        let bytes = value.parse::<u64>().ok()?;
        // cgroup v1 uses a very large sentinel for an unlimited limit.
        if unlimited_is_none && bytes >= u64::MAX / 2 {
            None
        } else {
            Some(bytes)
        }
    })
}

#[cfg(target_os = "linux")]
fn cgroup_memory_limit_bytes() -> Option<u64> {
    cgroup_value(
        &[
            "/sys/fs/cgroup/memory.max",
            "/sys/fs/cgroup/memory/memory.limit_in_bytes",
        ],
        true,
    )
    .filter(|limit| *limit > 0)
}

#[cfg(target_os = "linux")]
fn cgroup_memory_usage_bytes() -> Option<u64> {
    cgroup_value(
        &[
            "/sys/fs/cgroup/memory.current",
            "/sys/fs/cgroup/memory/memory.usage_in_bytes",
        ],
        false,
    )
}

/// Return total memory available to the current process in bytes.
///
/// On a Linux host this is the lower of `MemTotal` and a finite cgroup limit,
/// preventing connection and buffer policies from overcommitting containers.
pub fn total_physical_memory_bytes() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use std::mem;
        #[repr(C)]
        struct MemoryStatusEx {
            dw_length: u32,
            dw_memory_load: u32,
            ull_total_phys: u64,
            ull_avail_phys: u64,
            ull_total_page_file: u64,
            ull_avail_page_file: u64,
            ull_total_virtual: u64,
            ull_avail_virtual: u64,
            ull_avail_extended_virtual: u64,
        }
        extern "system" {
            fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
        }
        unsafe {
            let mut status: MemoryStatusEx = mem::zeroed();
            status.dw_length = mem::size_of::<MemoryStatusEx>() as u32;
            if GlobalMemoryStatusEx(&mut status) != 0 {
                status.ull_total_phys.max(1)
            } else {
                FALLBACK_MEMORY_BYTES
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let host_total = std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|content| meminfo_value_bytes(&content, "MemTotal:"));
        match (host_total, cgroup_memory_limit_bytes()) {
            (Some(host), Some(limit)) => host.min(limit).max(1),
            (Some(host), None) => host.max(1),
            (None, Some(limit)) => limit.max(1),
            (None, None) => FALLBACK_MEMORY_BYTES,
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|bytes| *bytes > 0)
            .unwrap_or(FALLBACK_MEMORY_BYTES)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        FALLBACK_MEMORY_BYTES
    }
}

/// Return memory currently available to the process in bytes.
///
/// Linux combines host `MemAvailable` with the remaining cgroup budget. The
/// minimum is conservative and guarantees the reported availability never
/// exceeds the process's finite memory allocation.
pub fn available_physical_memory_bytes() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use std::mem;
        #[repr(C)]
        struct MemoryStatusEx {
            dw_length: u32,
            dw_memory_load: u32,
            ull_total_phys: u64,
            ull_avail_phys: u64,
            ull_total_page_file: u64,
            ull_avail_page_file: u64,
            ull_total_virtual: u64,
            ull_avail_virtual: u64,
            ull_avail_extended_virtual: u64,
        }
        extern "system" {
            fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
        }
        unsafe {
            let mut status: MemoryStatusEx = mem::zeroed();
            status.dw_length = mem::size_of::<MemoryStatusEx>() as u32;
            if GlobalMemoryStatusEx(&mut status) != 0 {
                status.ull_avail_phys
            } else {
                FALLBACK_MEMORY_BYTES / 2
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let host_available = std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|content| meminfo_value_bytes(&content, "MemAvailable:"));
        let cgroup_available = cgroup_memory_limit_bytes()
            .zip(cgroup_memory_usage_bytes())
            .map(|(limit, usage)| limit.saturating_sub(usage));
        match (host_available, cgroup_available) {
            (Some(host), Some(cgroup)) => host.min(cgroup),
            (Some(host), None) => host,
            (None, Some(cgroup)) => cgroup,
            (None, None) => FALLBACK_MEMORY_BYTES / 2,
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        total_physical_memory_bytes() / 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_physical_memory_is_positive() {
        assert!(total_physical_memory_bytes() > 0);
    }

    #[test]
    fn available_physical_memory_is_bounded_by_total() {
        assert!(available_physical_memory_bytes() <= total_physical_memory_bytes());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn meminfo_parser_uses_saturating_byte_conversion() {
        assert_eq!(
            meminfo_value_bytes("MemTotal: 1024 kB", "MemTotal:"),
            Some(1_048_576)
        );
        assert_eq!(
            meminfo_value_bytes("MemTotal: 18446744073709551615 kB", "MemTotal:"),
            Some(u64::MAX)
        );
        assert_eq!(meminfo_value_bytes("MemFree: 1 kB", "MemTotal:"), None);
    }
}
