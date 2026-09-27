use axum::response::Json;
use axum::routing::post;
use axum::Router;
use std::time::Instant;

use crate::daemon::state::SharedState;
use crate::daemon::utils::hide_command_window;

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router.route("/api/dns/ping-all", post(handle_dns_ping_all))
}

async fn handle_dns_ping_all() -> Json<serde_json::Value> {
    let providers: Vec<(&str, &str)> = vec![
        ("Cloudflare", "1.1.1.1"),
        ("Google", "8.8.8.8"),
        ("OpenDNS", "208.67.222.222"),
        ("Quad9", "9.9.9.9"),
        ("Comodo Secure", "8.26.56.26"),
        ("AdGuard", "94.140.14.14"),
        ("CleanBrowsing", "185.228.168.9"),
    ];

    // Ping all providers in parallel so a single diagnostics request doesn't
    // block for the sum of all timeouts (7 sequential pings x 2s worst case).
    let mut handles = Vec::with_capacity(providers.len());
    for (name, ip) in providers {
        let name = name.to_owned();
        let ip = ip.to_owned();
        handles.push(tokio::spawn(async move {
            let latency = ping_ip(&ip).await;
            serde_json::json!({
                "name": name,
                "ip": ip,
                "latencyMs": latency,
            })
        }));
    }

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(json) = handle.await {
            results.push(json);
        }
    }

    Json(serde_json::json!({ "results": results }))
}

async fn ping_ip(ip: &str) -> Option<f64> {
    let start = Instant::now();
    let ip = ip.to_owned();

    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("ping");
        #[cfg(target_os = "windows")]
        {
            cmd.arg("-n").arg("1").arg("-w").arg("2000");
        }
        #[cfg(not(target_os = "windows"))]
        {
            cmd.arg("-c").arg("1").arg("-W").arg("2");
        }
        cmd.arg(&ip);
        hide_command_window(&mut cmd);
        cmd.output()
    })
    .await
    .ok()?;

    match output {
        Ok(out) if out.status.success() => {
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            Some((ms * 10.0).round() / 10.0)
        }
        _ => None,
    }
}
