use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use nova_download_core::{
    stream_http_body_with_context, HttpRequestContext, MAX_PARALLEL_SEGMENTS,
};
use nova_stream_core::DashRepresentationPlan;
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DashStageFile {
    pub order: u64,
    pub path: PathBuf,
    pub bytes: u64,
    pub initialization: bool,
    pub number: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DashStageResult {
    pub files: Vec<DashStageFile>,
    pub total_bytes: u64,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DashStageError {
    #[error("DASH staging plan contains no transfer units")]
    EmptyPlan,
    #[error("native DASH staging I/O failed: {0}")]
    Io(String),
    #[error("native DASH transfer failed: {0}")]
    Transport(String),
}

/// Download one static DASH representation into deterministic staging files.
///
/// The representation plan already contains fully resolved URLs, so execution
/// remains a pure native-transfer concern and does not depend on an external media resolver.
pub fn stage_dash_representation_plan(
    plan: &DashRepresentationPlan,
    context: &HttpRequestContext,
    staging_dir: &Path,
    requested_parallelism: u32,
) -> Result<DashStageResult, DashStageError> {
    if plan.units.is_empty() {
        return Err(DashStageError::EmptyPlan);
    }

    fs::create_dir_all(staging_dir).map_err(|error| DashStageError::Io(error.to_string()))?;

    let workers = requested_parallelism
        .max(1)
        .min(MAX_PARALLEL_SEGMENTS)
        .min(plan.units.len() as u32) as usize;
    let next_index = AtomicUsize::new(0);
    let total_bytes = AtomicU64::new(0);
    let results = Mutex::new(vec![None::<DashStageFile>; plan.units.len()]);
    let first_error = Mutex::new(None::<DashStageError>);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if first_error.lock().ok().is_some_and(|error| error.is_some()) {
                    break;
                }

                let index = next_index.fetch_add(1, Ordering::AcqRel);
                if index >= plan.units.len() {
                    break;
                }

                let unit = &plan.units[index];
                let suffix = if unit.initialization { "init" } else { "media" };
                let final_path =
                    staging_dir.join(format!("{:08}-{suffix}.part", unit.order));
                let temp_path =
                    staging_dir.join(format!("{:08}-{suffix}.part.tmp", unit.order));

                let transfer = (|| -> Result<u64, DashStageError> {
                    let mut file = OpenOptions::new()
                        .create(true)
                        .write(true)
                        .truncate(true)
                        .open(&temp_path)
                        .map_err(|error| DashStageError::Io(error.to_string()))?;

                    let bytes = stream_http_body_with_context(&unit.url, &mut file, context)
                        .map_err(|error| DashStageError::Transport(error.to_string()))?
                        .bytes_received;

                    file.flush()
                        .and_then(|_| file.sync_all())
                        .map_err(|error| DashStageError::Io(error.to_string()))?;
                    drop(file);

                    if final_path.exists() {
                        fs::remove_file(&final_path)
                            .map_err(|error| DashStageError::Io(error.to_string()))?;
                    }
                    fs::rename(&temp_path, &final_path)
                        .map_err(|error| DashStageError::Io(error.to_string()))?;
                    Ok(bytes)
                })();

                match transfer {
                    Ok(bytes) => {
                        total_bytes.fetch_add(bytes, Ordering::AcqRel);
                        if let Ok(mut entries) = results.lock() {
                            entries[index] = Some(DashStageFile {
                                order: unit.order,
                                path: final_path,
                                bytes,
                                initialization: unit.initialization,
                                number: unit.number,
                            });
                        }
                    }
                    Err(error) => {
                        let _ = fs::remove_file(&temp_path);
                        if let Ok(mut slot) = first_error.lock() {
                            if slot.is_none() {
                                *slot = Some(error);
                            }
                        }
                        break;
                    }
                }
            });
        }
    });

    if let Some(error) = first_error
        .into_inner()
        .map_err(|_| DashStageError::Io("DASH error state lock poisoned".to_owned()))?
    {
        return Err(error);
    }

    let mut files = results
        .into_inner()
        .map_err(|_| DashStageError::Io("DASH result state lock poisoned".to_owned()))?
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| DashStageError::Io("DASH staging did not produce every unit".to_owned()))?;
    files.sort_by_key(|file| file.order);

    Ok(DashStageResult {
        files,
        total_bytes: total_bytes.load(Ordering::Acquire),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nova_stream_core::{DashRepresentationPlan, DashTrackKind, DashTransferUnit};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn stages_dash_init_and_media_units_in_order() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind DASH server");
        let address = listener.local_addr().expect("DASH server address");

        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept DASH request");
                let mut request = [0_u8; 2048];
                let read = stream.read(&mut request).expect("read DASH request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body: &[u8] = if request.contains("GET /init.mp4 ") {
                    b"INIT"
                } else if request.contains("GET /1.m4s ") {
                    b"MEDIA"
                } else {
                    panic!("unexpected DASH request: {request}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(body))
                    .expect("write DASH response");
            }
        });

        let plan = DashRepresentationPlan {
            representation_id: Some("v1".to_owned()),
            track_kind: DashTrackKind::Video,
            bandwidth: Some(2_000_000),
            units: vec![
                DashTransferUnit {
                    order: 0,
                    url: format!("http://{address}/init.mp4"),
                    initialization: true,
                    number: None,
                    time: None,
                },
                DashTransferUnit {
                    order: 1,
                    url: format!("http://{address}/1.m4s"),
                    initialization: false,
                    number: Some(1),
                    time: None,
                },
            ],
        };

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-dash-stage-{unique}"));

        let result = stage_dash_representation_plan(
            &plan,
            &HttpRequestContext::default(),
            &dir,
            2,
        )
        .expect("stage DASH");
        server.join().expect("DASH server");

        assert_eq!(result.total_bytes, 9);
        assert_eq!(result.files.len(), 2);
        assert!(result.files[0].initialization);
        assert_eq!(fs::read(&result.files[0].path).expect("init"), b"INIT");
        assert_eq!(fs::read(&result.files[1].path).expect("media"), b"MEDIA");

        let _ = fs::remove_dir_all(dir);
    }
}
