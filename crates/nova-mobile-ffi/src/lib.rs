//! Typed FFI boundary for NOVA mobile clients.
//!
//! The bridge deliberately starts with a versioned compatibility handshake.
//! It must not expose the desktop daemon, Axum routes, Tauri commands, or
//! arbitrary filesystem paths. Task operations are added only after the shared
//! core owns their durable semantics.

uniffi::setup_scaffolding!();

/// Increment when a bridge change is not backward compatible.
pub const BRIDGE_API_VERSION: u32 = 1;

/// Typed capability and compatibility information returned before a mobile
/// client creates a core session.
#[derive(uniffi::Record)]
pub struct BridgeInfo {
    pub bridge_api_version: u32,
    pub core_version: String,
    pub task_schema: String,
}

/// A stable error for a client that was compiled against an incompatible bridge.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BridgeError {
    #[error("Android client bridge version {client_version} is incompatible with core version {core_version}")]
    IncompatibleVersion {
        client_version: u32,
        core_version: u32,
    },
}

/// Validates that a mobile client and the Rust core agree on the public bridge
/// contract before any task command is accepted.
#[uniffi::export]
pub fn initialize(client_bridge_api_version: u32) -> Result<BridgeInfo, BridgeError> {
    if client_bridge_api_version != BRIDGE_API_VERSION {
        return Err(BridgeError::IncompatibleVersion {
            client_version: client_bridge_api_version,
            core_version: BRIDGE_API_VERSION,
        });
    }

    Ok(BridgeInfo {
        bridge_api_version: BRIDGE_API_VERSION,
        core_version: env!("CARGO_PKG_VERSION").to_owned(),
        task_schema: "nova.task.v1".to_owned(),
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_accepts_current_bridge_version() {
        let info = initialize(BRIDGE_API_VERSION).expect("current bridge version must initialize");
        assert_eq!(info.bridge_api_version, BRIDGE_API_VERSION);
        assert_eq!(info.task_schema, "nova.task.v1");
    }

    #[test]
    fn initialize_rejects_incompatible_bridge_version() {
        let result = initialize(BRIDGE_API_VERSION + 1);
        assert!(matches!(
            result,
            Err(BridgeError::IncompatibleVersion {
                client_version,
                core_version,
            }) if client_version == BRIDGE_API_VERSION + 1 && core_version == BRIDGE_API_VERSION
        ));
    }
}
