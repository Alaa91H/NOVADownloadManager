use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use nova_download_core::{
    stream_http_body_with_context, stream_http_range_with_context, HttpRequestContext,
    MAX_PARALLEL_SEGMENTS,
};
use nova_stream_core::{HlsMediaPlan, HlsTransferUnitKind};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HlsStageFile {
    pub order: u64,
    pub kind: HlsTransferUnitKind,
    pub path: PathBuf,
    pub bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HlsStageResult {
    pub files: Vec<HlsStageFile>,
    pub total_bytes: u64,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum HlsStageError {
    #[error("HLS staging plan contains no transfer units")]
    EmptyPlan,
    #[error("encrypted HLS is not enabled in the native staging executor yet")]
    EncryptionNotYetSupported,
    #[error("HLS byte range is missing an absolute offset")]
    MissingByteRangeOffset,
    #[error("invalid HLS byte range overflow")]
    ByteRangeOverflow,
    #[error("native HLS staging I/O failed: {0}")]
    Io(String),
    #[error("native HLS transfer failed: {0}")]
    Transport(String),
}

/// Download all units of one parsed HLS media playlist into deterministic
/// staging files using NOVA's native libcurl transport.
///
/// Units are fetched concurrently but returned in manifest order. Muxing and
/// decryption intentionally remain separate pipeline stages.
pub fn stage_hls_media_plan(
    plan: &HlsMediaPlan,
    context: &HttpRequestContext,
    staging_dir: &Path,
    requested_parallelism: u32,
) -> Result<HlsStageResult, HlsStageError> {
    if plan.units.is_empty() {
        return Err(HlsStageError::EmptyPlan);
    }
    if plan.units.iter().any(|unit| unit.key.is_some()) {
        return Err(HlsStageError::EncryptionNotYetSupported);
    }

    fs::create_dir_all(staging_dir).map_err(|error| HlsStageError::Io(error.to_string()))?;

    let workers = requested_parallelism
        .max(1)
        .min(MAX_PARALLEL_SEGMENTS)
        .min(plan.units.len() as u32) as usize;
    let next_index = AtomicUsize::new(0);
    let total_bytes = AtomicU64::new(0);
    let results = Mutex::new(vec![None::<HlsStageFile>; plan.units.len()]);
    let first_error = Mutex::new(None::<HlsStageError>);

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
                let suffix = match unit.kind {
                    HlsTransferUnitKind::Initialization => "init",
                    HlsTransferUnitKind::MediaSegment => "media",
                };
                let final_path =
                    staging_dir.join(format!("{:08}-{suffix}.part", unit.order));
                let temp_path =
                    staging_dir.join(format!("{:08}-{suffix}.part.tmp", unit.order));

                let transfer = (|| -> Result<u64, HlsStageError> {
                    let mut file = OpenOptions::new()
                        .create(true)
                        .write(true)
                        .truncate(true)
                        .open(&temp_path)
                        .map_err(|error| HlsStageError::Io(error.to_string()))?;

                    let bytes = if let Some(range) = &unit.byte_range {
                        let start = range
                            .offset
                            .ok_or(HlsStageError::MissingByteRangeOffset)?;
                        let end = start
                            .checked_add(range.length)
                            .and_then(|value| value.checked_sub(1))
                            .ok_or(HlsStageError::ByteRangeOverflow)?;
                        stream_http_range_with_context(
                            &unit.uri,
                            start,
                            end,
                            &mut file,
                            context,
                        )
                        .map_err(|error| HlsStageError::Transport(error.to_string()))?
                        .bytes_received
                    } else {
                        stream_http_body_with_context(&unit.uri, &mut file, context)
                            .map_err(|error| HlsStageError::Transport(error.to_string()))?
                            .bytes_received
                    };

                    file.flush()
                        .and_then(|_| file.sync_all())
                        .map_err(|error| HlsStageError::Io(error.to_string()))?;
                    drop(file);

                    if final_path.exists() {
                        fs::remove_file(&final_path)
                            .map_err(|error| HlsStageError::Io(error.to_string()))?;
                    }
                    fs::rename(&temp_path, &final_path)
                        .map_err(|error| HlsStageError::Io(error.to_string()))?;
                    Ok(bytes)
                })();

                match transfer {
                    Ok(bytes) => {
                        total_bytes.fetch_add(bytes, Ordering::AcqRel);
                        if let Ok(mut entries) = results.lock() {
                            entries[index] = Some(HlsStageFile {
                                order: unit.order,
                                kind: unit.kind,
                                path: final_path,
                                bytes,
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
        .map_err(|_| HlsStageError::Io("HLS error state lock poisoned".to_owned()))?
    {
        return Err(error);
    }

    let mut files = results
        .into_inner()
        .map_err(|_| HlsStageError::Io("HLS result state lock poisoned".to_owned()))?
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| HlsStageError::Io("HLS staging did not produce every unit".to_owned()))?;
    files.sort_by_key(|file| file.order);

    Ok(HlsStageResult {
        files,
        total_bytes: total_bytes.load(Ordering::Acquire),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nova_stream_core::{HlsTransferUnit, HlsTransferUnitKind};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rejects_encrypted_plan_until_native_decryption_stage_exists() {
        let plan = HlsMediaPlan {
            units: vec![HlsTransferUnit {
                order: 0,
                kind: HlsTransferUnitKind::MediaSegment,
                uri: "https://cdn.test/a.ts".to_owned(),
                byte_range: None,
                sequence: Some(0),
                discontinuity: false,
                key: Some(nova_stream_core::HlsKey {
                    method: nova_stream_core::HlsEncryptionMethod::Aes128,
                    uri: Some("https://cdn.test/key".to_owned()),
                    iv: None,
                    key_format: None,
                }),
            }],
            end_list: true,
            target_duration_seconds: Some(6),
        };

        assert_eq!(
            stage_hls_media_plan(
                &plan,
                &HttpRequestContext::default(),
                Path::new("/unused"),
                2
            ),
            Err(HlsStageError::EncryptionNotYetSupported)
        );
    }

    #[test]
    fn stages_plain_hls_segments_in_manifest_order() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind HLS test server");
        let address = listener.local_addr().expect("HLS server address");

        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept HLS segment");
                let mut request = [0_u8; 2048];
                let read = stream.read(&mut request).expect("read HLS request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body: &[u8] = if request.contains("GET /a.ts ") {
                    b"AAAA"
                } else if request.contains("GET /b.ts ") {
                    b"BBBBB"
                } else {
                    panic!("unexpected HLS request: {request}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(body))
                    .expect("write HLS segment response");
            }
        });

        let plan = HlsMediaPlan {
            units: vec![
                HlsTransferUnit {
                    order: 0,
                    kind: HlsTransferUnitKind::MediaSegment,
                    uri: format!("http://{address}/a.ts"),
                    byte_range: None,
                    sequence: Some(10),
                    discontinuity: false,
                    key: None,
                },
                HlsTransferUnit {
                    order: 1,
                    kind: HlsTransferUnitKind::MediaSegment,
                    uri: format!("http://{address}/b.ts"),
                    byte_range: None,
                    sequence: Some(11),
                    discontinuity: false,
                    key: None,
                },
            ],
            end_list: true,
            target_duration_seconds: Some(6),
        };

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-hls-stage-{unique}"));
        let result =
            stage_hls_media_plan(&plan, &HttpRequestContext::default(), &dir, 2)
                .expect("stage HLS");
        server.join().expect("HLS server");

        assert_eq!(result.total_bytes, 9);
        assert_eq!(result.files.len(), 2);
        assert_eq!(fs::read(&result.files[0].path).expect("first segment"), b"AAAA");
        assert_eq!(fs::read(&result.files[1].path).expect("second segment"), b"BBBBB");

        let _ = fs::remove_dir_all(dir);
    }
}
