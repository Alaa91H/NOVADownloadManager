//! Operating-system-backed storage for secrets referenced by NOVA policies.
//!
//! Credential values never enter daemon JSON persistence or command results.
//! The OS store may still be locked or unavailable at runtime; callers receive
//! a generic error instead of platform details.

use keyring::Entry;
use nova_core_model::CredentialSecret;

const SERVICE_NAME: &str = "com.nova.download-manager.credentials";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialStoreError {
    InvalidIdentifier,
    InvalidSecret,
    NotFound,
    BackendUnavailable,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CredentialStore;

impl CredentialStore {
    /// Whether this target was built with a native keyring backend.
    pub const fn platform_supported() -> bool {
        cfg!(any(
            target_os = "windows",
            target_os = "macos",
            target_os = "linux"
        ))
    }

    pub fn store(&self, credential_id: &str, secret: &str) -> Result<(), CredentialStoreError> {
        if !valid_identifier(credential_id) {
            return Err(CredentialStoreError::InvalidIdentifier);
        }
        if secret.is_empty() || secret.len() > 16_384 || secret.contains('\0') {
            return Err(CredentialStoreError::InvalidSecret);
        }
        let entry = self.entry(credential_id)?;
        entry
            .set_password(secret)
            .map_err(|_| CredentialStoreError::BackendUnavailable)
    }

    /// Resolve a secret for internal engine use only. Never include it in API
    /// responses, logs, events, snapshots, or diagnostic bundles.
    pub fn retrieve(&self, credential_id: &str) -> Result<CredentialSecret, CredentialStoreError> {
        let entry = self.entry(credential_id)?;
        match entry.get_password() {
            Ok(secret) => Ok(CredentialSecret::new(secret)),
            Err(keyring::Error::NoEntry) => Err(CredentialStoreError::NotFound),
            Err(_) => Err(CredentialStoreError::BackendUnavailable),
        }
    }

    /// Deleting an absent key is an idempotent success represented by `false`.
    pub fn delete(&self, credential_id: &str) -> Result<bool, CredentialStoreError> {
        let entry = self.entry(credential_id)?;
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(CredentialStoreError::BackendUnavailable),
        }
    }

    fn entry(&self, credential_id: &str) -> Result<Entry, CredentialStoreError> {
        if !valid_identifier(credential_id) {
            return Err(CredentialStoreError::InvalidIdentifier);
        }
        Entry::new(SERVICE_NAME, credential_id)
            .map_err(|_| CredentialStoreError::BackendUnavailable)
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
