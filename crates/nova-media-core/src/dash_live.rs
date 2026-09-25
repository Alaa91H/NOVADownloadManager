use std::path::Path;

use nova_download_core::{fetch_http_bytes_with_context, HttpRequestContext};
use nova_stream_core::{
    build_dash_live_refresh, parse_dash, DashLiveCursor, DashLiveRefresh,
};
use thiserror::Error;

use crate::{stage_dash_representation_plan, DashStageError, DashStageResult};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DashLiveStageRefresh {
    pub refresh: DashLiveRefresh,
    pub staged: Option<DashStageResult>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DashLiveError {
    #[error("native DASH live manifest transfer failed: {0}")]
    Transport(String),
    #[error("native DASH live manifest is not UTF-8")]
    Encoding,
    #[error("native DASH live manifest parse failed: {0}")]
    Parse(String),
    #[error("native DASH live planning failed: {0}")]
    Plan(String),
    #[error(transparent)]
    Stage(#[from] DashStageError),
}

/// Execute one dynamic-DASH refresh tick entirely through NOVA's Rust core.
pub fn refresh_and_stage_dash_live_once(
    manifest_url: &str,
    context: &HttpRequestContext,
    cursor: DashLiveCursor,
    staging_dir: &Path,
    requested_parallelism: u32,
    max_manifest_bytes: usize,
    period_index: usize,
    adaptation_index: usize,
    representation_index: usize,
) -> Result<DashLiveStageRefresh, DashLiveError> {
    let response = fetch_http_bytes_with_context(
        manifest_url,
        context,
        max_manifest_bytes,
    )
    .map_err(|error| DashLiveError::Transport(error.to_string()))?;
    let body = String::from_utf8(response.body).map_err(|_| DashLiveError::Encoding)?;
    let manifest = parse_dash(&body).map_err(|error| DashLiveError::Parse(error.to_string()))?;
    let refresh = build_dash_live_refresh(
        &manifest,
        &response.effective_url,
        period_index,
        adaptation_index,
        representation_index,
        cursor,
    )
    .map_err(|error| DashLiveError::Plan(error.to_string()))?;

    let staged = refresh
        .plan
        .as_ref()
        .map(|plan| {
            stage_dash_representation_plan(
                plan,
                context,
                staging_dir,
                requested_parallelism,
            )
        })
        .transpose()?;

    Ok(DashLiveStageRefresh { refresh, staged })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn refresh_tick_stages_dynamic_dash_timeline_snapshot() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind DASH live server");
        let address = listener.local_addr().expect("DASH live address");

        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().expect("accept DASH live request");
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).expect("read DASH live request");
                let request = String::from_utf8_lossy(&request[..read]);

                let body: Vec<u8> = if request.contains("GET /live.mpd ") {
                    format!(
                        "<MPD type=\"dynamic\" minimumUpdatePeriod=\"PT2S\"><Period><AdaptationSet contentType=\"video\"><SegmentTemplate timescale=\"1\" initialization=\"init.mp4\" media=\"$Time$.m4s\"><SegmentTimeline><S t=\"10\" d=\"2\"/></SegmentTimeline></SegmentTemplate><Representation id=\"v1\" bandwidth=\"1000\"/></AdaptationSet></Period></MPD>"
                    )
                    .into_bytes()
                } else if request.contains("GET /init.mp4 ") {
                    b"INIT".to_vec()
                } else if request.contains("GET /10.m4s ") {
                    b"MEDIA".to_vec()
                } else {
                    panic!("unexpected DASH live request: {request}");
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(&body))
                    .expect("write DASH live response");
            }
        });

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-dash-live-{unique}"));

        let refresh = refresh_and_stage_dash_live_once(
            &format!("http://{address}/live.mpd"),
            &HttpRequestContext::default(),
            DashLiveCursor::default(),
            &dir,
            2,
            64 * 1024,
            0,
            0,
            0,
        )
        .expect("dynamic DASH refresh");
        server.join().expect("DASH live server");

        assert_eq!(refresh.refresh.reload_after_millis, 2000);
        assert_eq!(refresh.refresh.next_cursor.last_time, Some(10));
        assert_eq!(refresh.staged.as_ref().expect("staged").files.len(), 2);

        let _ = std::fs::remove_dir_all(dir);
    }
}
