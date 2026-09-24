use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use nova_download_core::{
    fetch_http_bytes_with_context, stream_http_body_controlled_with_context,
    stream_http_range_controlled_with_context, HttpRequestContext, TransferControl,
    TransportError, MAX_PARALLEL_SEGMENTS,
};
use nova_stream_core::{
    HlsEncryptionMethod, HlsKey, HlsMediaPlan, HlsTransferUnit,
    HlsTransferUnitKind,
};
use thiserror::Error;

type Aes128CbcDecryptor = cbc::Decryptor<Aes128>;

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
    #[error("unsupported HLS encryption mode: {0}")]
    UnsupportedEncryption(String),
    #[error("HLS AES-128 key URI is missing")]
    MissingKeyUri,
    #[error("HLS AES-128 key must contain exactly 16 bytes, got {0}")]
    InvalidKeyLength(usize),
    #[error("HLS AES-128 initialization map requires an explicit IV")]
    MissingInitializationIv,
    #[error("invalid HLS AES-128 IV: {0}")]
    InvalidIv(String),
    #[error("HLS AES-128 ciphertext or padding is invalid")]
    InvalidCiphertext,
    #[error("HLS byte range is missing an absolute offset")]
    MissingByteRangeOffset,
    #[error("invalid HLS byte range overflow")]
    ByteRangeOverflow,
    #[error("native HLS staging I/O failed: {0}")]
    Io(String),
    #[error("native HLS transfer failed: {0}")]
    Transport(String),
    #[error("native HLS staging was cancelled")]
    Cancelled,
}

/// Download all units of one parsed HLS media playlist into deterministic
/// staging files using NOVA's native libcurl transport.
///
/// AES-128/CBC is decrypted in-process. SAMPLE-AES and non-identity key
/// formats are rejected explicitly instead of being silently handed to an
/// external tool.
pub fn stage_hls_media_plan(
    plan: &HlsMediaPlan,
    context: &HttpRequestContext,
    staging_dir: &Path,
    requested_parallelism: u32,
) -> Result<HlsStageResult, HlsStageError> {
    stage_hls_media_plan_controlled(
        plan,
        context,
        staging_dir,
        requested_parallelism,
        || false,
    )
}

pub fn stage_hls_media_plan_controlled<F>(
    plan: &HlsMediaPlan,
    context: &HttpRequestContext,
    staging_dir: &Path,
    requested_parallelism: u32,
    should_cancel: F,
) -> Result<HlsStageResult, HlsStageError>
where
    F: Fn() -> bool + Sync,
{
    stage_hls_media_plan_controlled_with_progress(
        plan,
        context,
        staging_dir,
        requested_parallelism,
        should_cancel,
        |_| {},
    )
}

pub fn stage_hls_media_plan_controlled_with_progress<F, P>(
    plan: &HlsMediaPlan,
    context: &HttpRequestContext,
    staging_dir: &Path,
    requested_parallelism: u32,
    should_cancel: F,
    on_progress: P,
) -> Result<HlsStageResult, HlsStageError>
where
    F: Fn() -> bool + Sync,
    P: Fn(u64) + Sync,
{
    stage_hls_media_plan_controlled_with_progress_scoped(
        plan,
        context,
        None,
        staging_dir,
        requested_parallelism,
        should_cancel,
        on_progress,
    )
}

pub fn stage_hls_media_plan_controlled_with_progress_scoped<F, P>(
    plan: &HlsMediaPlan,
    context: &HttpRequestContext,
    context_origin: Option<&str>,
    staging_dir: &Path,
    requested_parallelism: u32,
    should_cancel: F,
    on_progress: P,
) -> Result<HlsStageResult, HlsStageError>
where
    F: Fn() -> bool + Sync,
    P: Fn(u64) + Sync,
{
    if plan.units.is_empty() {
        return Err(HlsStageError::EmptyPlan);
    }

    validate_encryption_modes(plan)?;
    fs::create_dir_all(staging_dir).map_err(|error| HlsStageError::Io(error.to_string()))?;

    let workers = requested_parallelism
        .max(1)
        .min(MAX_PARALLEL_SEGMENTS)
        .min(plan.units.len() as u32) as usize;
    let next_index = AtomicUsize::new(0);
    let total_bytes = AtomicU64::new(0);
    let results = Mutex::new(vec![None::<HlsStageFile>; plan.units.len()]);
    let first_error = Mutex::new(None::<HlsStageError>);
    let key_cache = Mutex::new(HashMap::<String, [u8; 16]>::new());

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if should_cancel() {
                    if let Ok(mut slot) = first_error.lock() {
                        if slot.is_none() {
                            *slot = Some(HlsStageError::Cancelled);
                        }
                    }
                    break;
                }
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

                let transfer = stage_one_unit(
                    unit,
                    context,
                    context_origin,
                    &key_cache,
                    &temp_path,
                    &final_path,
                    &should_cancel,
                );

                match transfer {
                    Ok(bytes) => {
                        let total = total_bytes
                            .fetch_add(bytes, Ordering::AcqRel)
                            .saturating_add(bytes);
                        on_progress(total);
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

fn map_transport_error(error: TransportError) -> HlsStageError {
    match error {
        TransportError::Cancelled => HlsStageError::Cancelled,
        other => HlsStageError::Transport(other.to_string()),
    }
}

fn validate_encryption_modes(plan: &HlsMediaPlan) -> Result<(), HlsStageError> {
    for unit in &plan.units {
        let Some(key) = &unit.key else {
            continue;
        };

        if let Some(key_format) = key.key_format.as_deref() {
            if !key_format.eq_ignore_ascii_case("identity") {
                return Err(HlsStageError::UnsupportedEncryption(format!(
                    "KEYFORMAT={key_format}"
                )));
            }
        }

        match &key.method {
            HlsEncryptionMethod::Aes128 => {}
            HlsEncryptionMethod::None => {}
            HlsEncryptionMethod::SampleAes => {
                return Err(HlsStageError::UnsupportedEncryption(
                    "SAMPLE-AES".to_owned(),
                ));
            }
            HlsEncryptionMethod::Other(method) => {
                return Err(HlsStageError::UnsupportedEncryption(method.clone()));
            }
        }
    }
    Ok(())
}

fn stage_one_unit(
    unit: &HlsTransferUnit,
    context: &HttpRequestContext,
    context_origin: Option<&str>,
    key_cache: &Mutex<HashMap<String, [u8; 16]>>,
    temp_path: &Path,
    final_path: &Path,
    should_cancel: &(dyn Fn() -> bool + Sync),
) -> Result<u64, HlsStageError> {
    if should_cancel() {
        return Err(HlsStageError::Cancelled);
    }
    let request_context = context_origin
        .map(|origin| crate::scope_http_request_context(context, origin, &unit.uri))
        .unwrap_or_else(|| context.clone());

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(temp_path)
        .map_err(|error| HlsStageError::Io(error.to_string()))?;

    if let Some(range) = &unit.byte_range {
        let start = range
            .offset
            .ok_or(HlsStageError::MissingByteRangeOffset)?;
        let end = start
            .checked_add(range.length)
            .and_then(|value| value.checked_sub(1))
            .ok_or(HlsStageError::ByteRangeOverflow)?;
        stream_http_range_controlled_with_context(
            &unit.uri,
            start,
            end,
            &mut file,
            &request_context,
            || {
                if should_cancel() {
                    TransferControl::Cancel
                } else {
                    TransferControl::Continue
                }
            },
        )
        .map_err(map_transport_error)?;
    } else {
        stream_http_body_controlled_with_context(
            &unit.uri,
            &mut file,
            &request_context,
            || {
                if should_cancel() {
                    TransferControl::Cancel
                } else {
                    TransferControl::Continue
                }
            },
        )
        .map_err(map_transport_error)?;
    }

    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|error| HlsStageError::Io(error.to_string()))?;
    drop(file);

    let final_bytes = if let Some(key) = unit
        .key
        .as_ref()
        .filter(|key| key.method == HlsEncryptionMethod::Aes128)
    {
        decrypt_staged_unit(
            unit,
            key,
            context,
            context_origin,
            key_cache,
            temp_path,
        )?
    } else {
        fs::metadata(temp_path)
            .map(|metadata| metadata.len())
            .map_err(|error| HlsStageError::Io(error.to_string()))?
    };

    if final_path.exists() {
        fs::remove_file(final_path).map_err(|error| HlsStageError::Io(error.to_string()))?;
    }
    fs::rename(temp_path, final_path).map_err(|error| HlsStageError::Io(error.to_string()))?;
    Ok(final_bytes)
}

fn decrypt_staged_unit(
    unit: &HlsTransferUnit,
    key: &HlsKey,
    context: &HttpRequestContext,
    context_origin: Option<&str>,
    key_cache: &Mutex<HashMap<String, [u8; 16]>>,
    path: &Path,
) -> Result<u64, HlsStageError> {
    let key_uri = key.uri.as_deref().ok_or(HlsStageError::MissingKeyUri)?;
    let key_bytes = get_aes128_key(
        key_uri,
        context,
        context_origin,
        key_cache,
    )?;
    let iv = resolve_iv(unit, key)?;

    let ciphertext = fs::read(path).map_err(|error| HlsStageError::Io(error.to_string()))?;
    let plaintext = decrypt_aes128_cbc_pkcs7(&ciphertext, &key_bytes, &iv)?;

    fs::write(path, &plaintext).map_err(|error| HlsStageError::Io(error.to_string()))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| HlsStageError::Io(error.to_string()))?;
    file.sync_all()
        .map_err(|error| HlsStageError::Io(error.to_string()))?;

    Ok(plaintext.len() as u64)
}

fn get_aes128_key(
    key_uri: &str,
    context: &HttpRequestContext,
    context_origin: Option<&str>,
    key_cache: &Mutex<HashMap<String, [u8; 16]>>,
) -> Result<[u8; 16], HlsStageError> {
    if let Ok(cache) = key_cache.lock() {
        if let Some(key) = cache.get(key_uri) {
            return Ok(*key);
        }
    }

    let request_context = context_origin
        .map(|origin| crate::scope_http_request_context(context, origin, key_uri))
        .unwrap_or_else(|| context.clone());
    let response = fetch_http_bytes_with_context(key_uri, &request_context, 16)
        .map_err(|error| HlsStageError::Transport(error.to_string()))?;
    if response.body.len() != 16 {
        return Err(HlsStageError::InvalidKeyLength(response.body.len()));
    }

    let mut key = [0_u8; 16];
    key.copy_from_slice(&response.body);

    if let Ok(mut cache) = key_cache.lock() {
        cache.insert(key_uri.to_owned(), key);
    }
    Ok(key)
}

fn resolve_iv(unit: &HlsTransferUnit, key: &HlsKey) -> Result<[u8; 16], HlsStageError> {
    if let Some(iv) = key.iv.as_deref() {
        return parse_iv(iv);
    }

    if unit.kind == HlsTransferUnitKind::Initialization {
        return Err(HlsStageError::MissingInitializationIv);
    }

    let sequence = unit.sequence.ok_or(HlsStageError::InvalidIv(
        "media segment is missing a sequence number".to_owned(),
    ))?;
    let mut iv = [0_u8; 16];
    iv[8..].copy_from_slice(&sequence.to_be_bytes());
    Ok(iv)
}

fn parse_iv(value: &str) -> Result<[u8; 16], HlsStageError> {
    let hex = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);

    if hex.is_empty() || hex.len() > 32 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HlsStageError::InvalidIv(value.to_owned()));
    }

    let padded = format!("{hex:0>32}");
    let mut iv = [0_u8; 16];
    for (index, chunk) in padded.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(chunk)
            .map_err(|_| HlsStageError::InvalidIv(value.to_owned()))?;
        iv[index] = u8::from_str_radix(pair, 16)
            .map_err(|_| HlsStageError::InvalidIv(value.to_owned()))?;
    }
    Ok(iv)
}

fn decrypt_aes128_cbc_pkcs7(
    ciphertext: &[u8],
    key: &[u8; 16],
    iv: &[u8; 16],
) -> Result<Vec<u8>, HlsStageError> {
    Aes128CbcDecryptor::new(&(*key).into(), &(*iv).into())
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|_| HlsStageError::InvalidCiphertext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::{BlockEncryptMut, KeyIvInit};
    use nova_stream_core::{HlsEncryptionMethod, HlsTransferUnit};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    type Aes128CbcEncryptor = cbc::Encryptor<Aes128>;

    #[test]
    fn controlled_hls_staging_cancels_before_network_io() {
        let plan = HlsMediaPlan {
            units: vec![HlsTransferUnit {
                order: 0,
                kind: HlsTransferUnitKind::MediaSegment,
                uri: "https://example.invalid/segment.ts".to_owned(),
                byte_range: None,
                sequence: Some(1),
                discontinuity: false,
                key: None,
            }],
            end_list: true,
            target_duration_seconds: Some(6),
        };

        let result = stage_hls_media_plan_controlled(
            &plan,
            &HttpRequestContext::default(),
            Path::new("/unused"),
            1,
            || true,
        );
        assert_eq!(result, Err(HlsStageError::Cancelled));
    }

    #[test]
    fn derives_sequence_iv_and_parses_explicit_iv() {
        let unit = HlsTransferUnit {
            order: 0,
            kind: HlsTransferUnitKind::MediaSegment,
            uri: "https://cdn.test/a.ts".to_owned(),
            byte_range: None,
            sequence: Some(42),
            discontinuity: false,
            key: None,
        };
        let key = HlsKey {
            method: HlsEncryptionMethod::Aes128,
            uri: Some("https://cdn.test/key".to_owned()),
            iv: None,
            key_format: None,
        };

        let derived = resolve_iv(&unit, &key).expect("sequence IV");
        assert_eq!(&derived[8..], &42_u64.to_be_bytes());
        assert_eq!(
            parse_iv("0x1").expect("explicit IV"),
            [
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
            ]
        );
    }

    #[test]
    fn decrypts_aes128_cbc_with_pkcs7_padding() {
        let key = [0x11_u8; 16];
        let iv = [0x22_u8; 16];
        let plaintext = b"NOVA native HLS AES-128";
        let ciphertext = Aes128CbcEncryptor::new(&key.into(), &iv.into())
            .encrypt_padded_vec_mut::<Pkcs7>(plaintext);

        assert_eq!(
            decrypt_aes128_cbc_pkcs7(&ciphertext, &key, &iv).expect("decrypt"),
            plaintext
        );
    }

    #[test]
    fn rejects_sample_aes_without_external_fallback() {
        let plan = HlsMediaPlan {
            units: vec![HlsTransferUnit {
                order: 0,
                kind: HlsTransferUnitKind::MediaSegment,
                uri: "https://cdn.test/a.ts".to_owned(),
                byte_range: None,
                sequence: Some(0),
                discontinuity: false,
                key: Some(HlsKey {
                    method: HlsEncryptionMethod::SampleAes,
                    uri: Some("https://cdn.test/key".to_owned()),
                    iv: None,
                    key_format: None,
                }),
            }],
            end_list: true,
            target_duration_seconds: Some(6),
        };

        assert_eq!(
            validate_encryption_modes(&plan),
            Err(HlsStageError::UnsupportedEncryption(
                "SAMPLE-AES".to_owned()
            ))
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

    #[test]
    fn stages_and_decrypts_aes128_hls_segment() {
        let key = [0x33_u8; 16];
        let iv = [0_u8; 16];
        let plaintext = b"encrypted NOVA media segment";
        let ciphertext = Aes128CbcEncryptor::new(&key.into(), &iv.into())
            .encrypt_padded_vec_mut::<Pkcs7>(plaintext);

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind AES HLS server");
        let address = listener.local_addr().expect("AES HLS address");
        let key_body = key.to_vec();
        let segment_body = ciphertext.clone();

        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept AES request");
                let mut request = [0_u8; 2048];
                let read = stream.read(&mut request).expect("read AES request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body = if request.contains("GET /key.bin ") {
                    key_body.as_slice()
                } else if request.contains("GET /segment.ts ") {
                    segment_body.as_slice()
                } else {
                    panic!("unexpected AES request: {request}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(body))
                    .expect("write AES response");
            }
        });

        let plan = HlsMediaPlan {
            units: vec![HlsTransferUnit {
                order: 0,
                kind: HlsTransferUnitKind::MediaSegment,
                uri: format!("http://{address}/segment.ts"),
                byte_range: None,
                sequence: Some(0),
                discontinuity: false,
                key: Some(HlsKey {
                    method: HlsEncryptionMethod::Aes128,
                    uri: Some(format!("http://{address}/key.bin")),
                    iv: None,
                    key_format: None,
                }),
            }],
            end_list: true,
            target_duration_seconds: Some(6),
        };

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-hls-aes-{unique}"));
        let result =
            stage_hls_media_plan(&plan, &HttpRequestContext::default(), &dir, 1)
                .expect("stage AES HLS");
        server.join().expect("AES HLS server");

        assert_eq!(
            fs::read(&result.files[0].path).expect("decrypted segment"),
            plaintext
        );
        let _ = fs::remove_dir_all(dir);
    }
}
