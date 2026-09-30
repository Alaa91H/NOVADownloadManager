//! Shared validation, authorization and idempotency boundary for mutations.

use hmac::{Hmac, Mac};
use nova_core_model::{CommandEnvelope, ControlCommand, Principal, StructuredError};
use sha2::Sha256;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use zeroize::Zeroize;

const IDEMPOTENCY_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_IDEMPOTENCY_RECORDS: usize = 4096;
type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    pub contract_version: u32,
    pub request_id: String,
    pub idempotency_key: String,
    pub replayed: bool,
    pub result: serde_json::Value,
}

#[derive(Clone)]
struct CachedResult {
    fingerprint: [u8; 32],
    created_at: Instant,
    outcome: Result<serde_json::Value, StructuredError>,
}

struct IdempotencyStore {
    records: HashMap<String, CachedResult>,
    in_flight: HashMap<String, Weak<Mutex<()>>>,
}

/// Process-wide command bus state. Side effects remain in domain handlers;
/// adapters share this one validation, permission and replay gate.
pub struct CommandBus {
    store: Mutex<IdempotencyStore>,
    fingerprint_key: [u8; 32],
}

impl Default for CommandBus {
    fn default() -> Self {
        let mut fingerprint_key = [0; 32];
        fingerprint_key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        fingerprint_key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self {
            store: Mutex::new(IdempotencyStore {
                records: HashMap::new(),
                in_flight: HashMap::new(),
            }),
            fingerprint_key,
        }
    }
}

impl Drop for CommandBus {
    fn drop(&mut self) {
        self.fingerprint_key.zeroize();
    }
}

impl CommandBus {
    pub async fn execute<F, Fut>(
        &self,
        principal: &Principal,
        envelope: CommandEnvelope,
        executor: F,
    ) -> Result<CommandReceipt, StructuredError>
    where
        F: FnOnce(ControlCommand) -> Fut + Send,
        Fut: Future<Output = Result<serde_json::Value, StructuredError>> + Send,
    {
        envelope.validate()?;
        if principal.subject.trim().is_empty() {
            return Err(StructuredError::new(
                "unauthenticated_principal",
                "The authenticated principal has no subject.",
                401,
                false,
            ));
        }
        if let Some(required) = envelope
            .command
            .required_scopes()
            .into_iter()
            .find(|scope| !principal.allows(*scope))
        {
            return Err(StructuredError::new(
                "permission_denied",
                format!("The principal lacks the required {required:?} scope."),
                403,
                false,
            ));
        }

        let mut encoded = serde_json::to_vec(&envelope.command).map_err(|error| {
            StructuredError::new(
                "command_encoding_failed",
                format!("Command could not be fingerprinted: {error}"),
                400,
                false,
            )
        })?;
        let mut fingerprint_hasher = HmacSha256::new_from_slice(&self.fingerprint_key)
            .expect("HMAC accepts keys of any length");
        fingerprint_hasher.update(&encoded);
        encoded.zeroize();
        let fingerprint: [u8; 32] = fingerprint_hasher.finalize().into_bytes().into();
        let storage_key = format!("{}:{}", principal.subject, envelope.idempotency_key);

        // Requests with the same principal and idempotency key serialize while
        // unrelated commands remain concurrent.
        let command_lock = {
            let mut store = self.store.lock().await;
            Self::prune(&mut store);
            store.in_flight.retain(|_, lock| lock.strong_count() > 0);
            let lock = store
                .in_flight
                .get(&storage_key)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(Mutex::new(())));
            store
                .in_flight
                .insert(storage_key.clone(), Arc::downgrade(&lock));
            lock
        };
        let _command_guard = command_lock.lock().await;

        let cached = {
            let mut store = self.store.lock().await;
            Self::prune(&mut store);
            store.records.get(&storage_key).cloned()
        };
        if let Some(cached) = cached {
            if cached.fingerprint != fingerprint {
                return Err(StructuredError::new(
                    "idempotency_key_reused",
                    "This idempotency key was already used for a different command.",
                    409,
                    false,
                ));
            }
            return match cached.outcome {
                Ok(result) => Ok(receipt(&envelope, result, true)),
                Err(mut error) => {
                    error.replayed = true;
                    Err(error)
                }
            };
        }

        let request_id = envelope.request_id.clone();
        let idempotency_key = envelope.idempotency_key.clone();
        let command = envelope.command;
        let outcome = executor(command).await;
        // A retryable infrastructure failure has not committed the command's
        // intended effect. Keep the idempotency key free so the client can
        // safely retry it after the transient condition clears. Permanent
        // domain outcomes remain cached to preserve replay semantics.
        let cache_outcome = !matches!(&outcome, Err(error) if error.retryable);
        if cache_outcome {
            let mut store = self.store.lock().await;
            Self::prune(&mut store);
            if store.records.len() >= MAX_IDEMPOTENCY_RECORDS {
                if let Some(oldest_key) = store
                    .records
                    .iter()
                    .min_by_key(|(_, record)| record.created_at)
                    .map(|(key, _)| key.clone())
                {
                    store.records.remove(&oldest_key);
                }
            }
            store.records.insert(
                storage_key,
                CachedResult {
                    fingerprint,
                    created_at: Instant::now(),
                    outcome: outcome.clone(),
                },
            );
        }

        outcome.map(|result| CommandReceipt {
            contract_version: nova_core_model::CONTROL_PLANE_CONTRACT_VERSION,
            request_id,
            idempotency_key,
            replayed: false,
            result,
        })
    }

    fn prune(store: &mut IdempotencyStore) {
        store
            .records
            .retain(|_, record| record.created_at.elapsed() < IDEMPOTENCY_TTL);
    }
}

fn receipt(
    envelope: &CommandEnvelope,
    result: serde_json::Value,
    replayed: bool,
) -> CommandReceipt {
    CommandReceipt {
        contract_version: nova_core_model::CONTROL_PLANE_CONTRACT_VERSION,
        request_id: envelope.request_id.clone(),
        idempotency_key: envelope.idempotency_key.clone(),
        replayed,
        result,
    }
}
