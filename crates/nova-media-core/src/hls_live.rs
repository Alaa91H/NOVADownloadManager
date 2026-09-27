use std::path::Path;

use nova_download_core::{fetch_http_bytes_with_context, HttpRequestContext};
use nova_stream_core::{
    build_hls_live_refresh, parse_hls, HlsLiveCursor, HlsLiveRefresh,
};
use thiserror::Error;

use crate::{stage_hls_media_plan, HlsStageError, HlsStageResult};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HlsLiveStageRefresh {
    pub refresh: HlsLiveRefresh,
    pub staged: Option<HlsStageResult>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum HlsLiveError {
    #[error("native HLS live manifest transfer failed: {0}")]
    Transport(String),
    #[error("native HLS live manifest is not UTF-8")]
    Encoding,
    #[error("native HLS live manifest parse failed: {0}")]
    Parse(String),
    #[error("native HLS live planning failed: {0}")]
    Plan(String),
    #[error(transparent)]
    Stage(#[from] HlsStageError),
}

/// Execute one live-HLS refresh tick entirely through NOVA's Rust core.
///
/// The caller owns scheduling and persistence. The returned refresh contains
/// the recommended delay before the next poll.
pub fn refresh_and_stage_hls_live_once(
    manifest_url: &str,
    context: &HttpRequestContext,
    cursor: HlsLiveCursor,
    staging_dir: &Path,
    requested_parallelism: u32,
    max_manifest_bytes: usize,
) -> Result<HlsLiveStageRefresh, HlsLiveError> {
    let response = fetch_http_bytes_with_context(
        manifest_url,
        context,
        max_manifest_bytes,
    )
    .map_err(|error| HlsLiveError::Transport(error.to_string()))?;
    let body = String::from_utf8(response.body).map_err(|_| HlsLiveError::Encoding)?;
    let manifest = parse_hls(&response.effective_url, &body)
        .map_err(|error| HlsLiveError::Parse(error.to_string()))?;
    let refresh = build_hls_live_refresh(&manifest, cursor)
        .map_err(|error| HlsLiveError::Plan(error.to_string()))?;

    let staged = refresh
        .plan
        .as_ref()
        .map(|plan| {
            stage_hls_media_plan(
                plan,
                context,
                staging_dir,
                requested_parallelism,
            )
        })
        .transpose()?;

    Ok(HlsLiveStageRefresh { refresh, staged })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn refresh_tick_fetches_manifest_and_stages_only_new_segments() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind live server");
        let address = listener.local_addr().expect("live address");

        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept live request");
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).expect("read live request");
                let request = String::from_utf8_lossy(&request[..read]);

                let body: Vec<u8> = if request.contains("GET /live.m3u8 ") {
                    format!(
                        "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://{address}/7.ts\n"
                    )
                    .into_bytes()
                } else if request.contains("GET /7.ts ") {
                    b"NOVA-LIVE".to_vec()
                } else {
                    panic!("unexpected live request: {request}");
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(&body))
                    .expect("write live response");
            }
        });

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-live-refresh-{unique}"));

        let refresh = refresh_and_stage_hls_live_once(
            &format!("http://{address}/live.m3u8"),
            &HttpRequestContext::default(),
            HlsLiveCursor::default(),
            &dir,
            1,
            64 * 1024,
        )
        .expect("live refresh");
        server.join().expect("live server");

        assert_eq!(refresh.refresh.next_cursor.next_sequence, Some(8));
        assert_eq!(refresh.refresh.reload_after_millis, 2000);
        assert_eq!(
            refresh
                .staged
                .as_ref()
                .expect("staged")
                .files
                .len(),
            1
        );
        let staged = refresh.staged.expect("staged");
        assert_eq!(
            std::fs::read(&staged.files[0].path).expect("segment"),
            b"NOVA-LIVE"
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
