use std::collections::HashMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

/// Test DNS resolution for a hostname
fn test_dns(host: &str) -> serde_json::Value {
    let start = Instant::now();
    match format!("{}:80", host).to_socket_addrs() {
        Ok(addrs) => {
            let ips: Vec<String> = addrs.map(|a| a.ip().to_string()).collect();
            serde_json::json!({
                "host": host,
                "resolved": true,
                "ips": ips,
                "durationMs": start.elapsed().as_millis() as u64
            })
        }
        Err(e) => {
            serde_json::json!({
                "host": host,
                "resolved": false,
                "error": e.to_string(),
                "durationMs": start.elapsed().as_millis() as u64
            })
        }
    }
}

/// Test TCP connectivity to a host:port
fn test_tcp(host: &str, port: u16, timeout_secs: u64) -> serde_json::Value {
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);

    let addr = match format!("{}:{}", host, port).to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(a) => a,
            None => {
                return serde_json::json!({
                    "host": host, "port": port, "reachable": false,
                    "error": "DNS resolution returned no addresses",
                    "durationMs": start.elapsed().as_millis() as u64
                });
            }
        },
        Err(e) => {
            return serde_json::json!({
                "host": host, "port": port, "reachable": false,
                "error": format!("DNS resolution failed: {}", e),
                "durationMs": start.elapsed().as_millis() as u64
            });
        }
    };

    match TcpStream::connect_timeout(&addr, timeout) {
        Ok(_) => serde_json::json!({
            "host": host, "port": port, "reachable": true,
            "durationMs": start.elapsed().as_millis() as u64
        }),
        Err(e) => serde_json::json!({
            "host": host, "port": port, "reachable": false,
            "error": e.to_string(),
            "durationMs": start.elapsed().as_millis() as u64
        }),
    }
}

/// Test HTTPS connectivity with redirect following
async fn test_https_connectivity(url: &str) -> serde_json::Value {
    let start = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({
                "url": url, "error": format!("Failed to create client: {}", e)
            })
        }
    };

    let result = client.head(url).send().await;
    match result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let final_url = resp.url().as_str().to_string();
            let redirect_chain = if final_url != url {
                vec![url.to_string(), final_url.clone()]
            } else {
                vec![url.to_string()]
            };
            let headers: HashMap<String, String> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("?").to_string()))
                .collect();

            serde_json::json!({
                "url": url,
                "status": status,
                "finalUrl": final_url,
                "redirectChain": redirect_chain,
                "headers": headers,
                "durationMs": start.elapsed().as_millis() as u64,
                "success": status < 400
            })
        }
        Err(e) => {
            serde_json::json!({
                "url": url,
                "error": e.to_string(),
                "durationMs": start.elapsed().as_millis() as u64,
                "success": false
            })
        }
    }
}

fn validate_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.starts_with('-')
}

/// Test SSL certificate chain for a host
fn test_ssl_cert(host: &str, port: u16) -> serde_json::Value {
    let start = Instant::now();
    if !validate_hostname(host) {
        return serde_json::json!({
            "host": host,
            "error": "Invalid hostname format",
            "durationMs": start.elapsed().as_millis() as u64
        });
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let output = std::process::Command::new("openssl")
            .args([
                "s_client",
                "-connect",
                &format!("{host}:{port}"),
                "-servername",
                host,
            ])
            .stdin(std::process::Stdio::null())
            .output();
        match output {
            Ok(out) if out.status.success() => {
                let info = String::from_utf8_lossy(&out.stdout);
                serde_json::json!({
                    "host": host,
                    "certificateInfo": info.trim(),
                    "durationMs": start.elapsed().as_millis() as u64
                })
            }
            _ => {
                serde_json::json!({
                    "host": host,
                    "error": "openssl not available or cert check failed",
                    "durationMs": start.elapsed().as_millis() as u64
                })
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("powershell");
        crate::daemon::utils::hide_command_window(&mut cmd);
        let output = cmd
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "try {{$req=[System.Net.HttpWebRequest]::Create('https://{host}:{port}/'); $req.GetResponse() | Out-Null; $cert=$req.ServicePoint.Certificate; $subject=$cert.Subject; $issuer=$cert.Issuer; Write-Output \"subject=$subject`nissuer=$issuer\"}} catch {{Write-Error $_}}"
                ),
            ])
            .output();
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                serde_json::json!({
                    "host": host,
                    "stdout": stdout.trim(),
                    "stderr": stderr.trim(),
                    "durationMs": start.elapsed().as_millis() as u64
                })
            }
            Err(e) => {
                serde_json::json!({
                    "host": host,
                    "error": e.to_string(),
                    "durationMs": start.elapsed().as_millis() as u64
                })
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        serde_json::json!({"host": host, "error": "SSL cert check not supported on this platform"})
    }
}

/// Run a comprehensive download speed test against a known fast CDN URL
async fn test_download_speed(timeout_secs: u64) -> serde_json::Value {
    let test_urls = [
        "https://speed.cloudflare.com/__down?bytes=10485760",
        "https://proof.ovh.net/files/10Mb.dat",
    ];

    for url in &test_urls {
        let start = Instant::now();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build();
        let client = match client {
            Ok(c) => c,
            Err(_) => continue,
        };

        let result = client.get(*url).send().await;
        match result {
            Ok(resp) => {
                let total_size = resp.content_length().unwrap_or(0);
                let bytes = resp.bytes().await;
                match bytes {
                    Ok(data) => {
                        let elapsed = start.elapsed();
                        let elapsed_secs = elapsed.as_secs_f64();
                        let speed_bps = if elapsed_secs > 0.0 {
                            (data.len() as f64 * 8.0) / elapsed_secs
                        } else {
                            0.0
                        };
                        let speed_mbps = speed_bps / 1_000_000.0;

                        return serde_json::json!({
                            "url": url,
                            "downloadedBytes": data.len(),
                            "totalSize": total_size,
                            "durationMs": elapsed.as_millis() as u64,
                            "speedBps": speed_bps as u64,
                            "speedMbps": (speed_mbps * 100.0).round() / 100.0,
                            "success": true
                        });
                    }
                    Err(e) => {
                        return serde_json::json!({
                            "url": url,
                            "error": format!("Download body failed: {}", e),
                            "success": false
                        });
                    }
                }
            }
            Err(_e) => {
                continue;
            }
        }
    }

    serde_json::json!({
        "error": "All speed test URLs failed",
        "success": false
    })
}

/// Run a comprehensive E2E test against common CDNs and sites
pub async fn run_e2e_test(timeout_secs: u64) -> serde_json::Value {
    let start = Instant::now();

    // Test DNS resolution
    let dns_hosts = [
        "google.com",
        "cloudflare.com",
        "github.com",
        "videolan.org",
        "speed.cloudflare.com",
    ];
    let dns_results: Vec<serde_json::Value> = dns_hosts.iter().map(|h| test_dns(h)).collect();

    // Test TCP connectivity
    let tcp_hosts = [
        ("cloudflare.com", 443u16),
        ("google.com", 443u16),
        ("github.com", 443u16),
        ("videolan.org", 443u16),
    ];
    let tcp_results: Vec<serde_json::Value> =
        tcp_hosts.iter().map(|(h, p)| test_tcp(h, *p, 5)).collect();

    // Test HTTPS with real download URLs
    let https_urls = [
        "https://cloudflare.com",
        "https://github.com",
        "https://get.videolan.org/vlc/3.0.23/win64/vlc-3.0.23-win64.exe",
        "https://proof.ovh.net/files/1Mb.dat",
    ];
    let mut https_results = Vec::new();
    for url in &https_urls {
        https_results.push(test_https_connectivity(url).await);
    }

    // SSL certificate test
    let ssl_hosts = ["cloudflare.com", "github.com", "google.com"];
    let ssl_results: Vec<serde_json::Value> =
        ssl_hosts.iter().map(|h| test_ssl_cert(h, 443)).collect();

    // Download speed test
    let speed_test = test_download_speed(timeout_secs).await;

    serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "durationMs": start.elapsed().as_millis() as u64,
        "dns": dns_results,
        "tcp": tcp_results,
        "https": https_results,
        "sslCertificates": ssl_results,
        "speedTest": speed_test,
    })
}

/// Full system diagnostics including E2E tests
// Snapshot of independent system stats gathered by the caller; grouping them
// into a struct would add indirection without improving the call site.
#[allow(clippy::too_many_arguments)]
pub async fn full_diagnostics(
    memory_mb: u64,
    disk_free_gb: u64,
    jobs: usize,
    curl_available: bool,
    curl_version: String,
    ytdlp_available: bool,
    ffmpeg_available: bool,
    network_interfaces: Vec<String>,
    uptime_secs: u64,
    media_jobs: usize,
    curl_jobs: usize,
) -> serde_json::Value {
    let e2e = run_e2e_test(30).await;

    let summary_status = {
        let dns_ok = e2e
            .pointer("/dns")
            .and_then(|v| v.as_array())
            .is_some_and(|arr| arr.iter().any(|d| d["resolved"] == true));
        if dns_ok {
            "ok"
        } else {
            "degraded"
        }
    };

    let network_ok = e2e
        .pointer("/tcp")
        .and_then(|v| v.as_array())
        .is_some_and(|arr| arr.iter().any(|t| t["reachable"] == true));

    serde_json::json!({
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "summary": {
            "status": summary_status,
            "networkReachable": network_ok,
            "jobsRunning": jobs,
            "memoryUsageMb": memory_mb,
            "diskFreeGb": disk_free_gb,
            "uptimeSecs": uptime_secs,
        },
        "system": {
            "pid": std::process::id(),
            "memoryUsageMb": memory_mb,
            "diskFreeGb": disk_free_gb,
            "networkInterfaces": network_interfaces,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "rustTarget": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        },
        "engines": {
            "libcurl": { "available": curl_available, "version": curl_version },
            "yt-dlp": { "available": ytdlp_available },
            "ffmpeg": { "available": ffmpeg_available },
        },
        "jobs": {
            "total": jobs,
            "curlJobs": curl_jobs,
            "mediaJobs": media_jobs,
        },
        "e2eTests": e2e,
        "exportVersion": 2,
    })
}
