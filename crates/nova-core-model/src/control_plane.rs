//! Versioned, platform-neutral contracts for NOVA's command/query boundary.
//!
//! Transport adapters must authenticate callers and provide a trusted
//! [`Principal`]. They must not accept a principal or permission scopes from an
//! untrusted request body.

use serde::{Deserialize, Serialize};

/// Version of the first stable command, query and error envelope.
pub const CONTROL_PLANE_CONTRACT_VERSION: u32 = 1;
pub const CONTROL_PLANE_CAPABILITY_REGISTRY_VERSION: u32 = 2;
pub const CONTROL_EVENT_SCHEMA_VERSION: u32 = 1;
pub const CONTROL_EVENT_TYPES: &[&str] = &[
    "download.started",
    "download.progress",
    "download.completed",
    "download.retrying",
    "download.failed",
    "download.paused",
    "download.resumed",
    "download.cancelled",
    "download.segment_stolen",
    "download.connections_adjusted",
    "download.retry_scheduled",
    "download.checksum_verified",
    "download.mirror_found",
    "download.speed_changed",
    "queue.changed",
    "download.bandwidth_allocated",
    "scheduler.triggered",
    "rule.applied",
    "profile.switched",
];

/// Maximum number of operations accepted in one best-effort batch.
pub const MAX_COMMAND_BATCH_SIZE: usize = 128;

/// Runtime-visible availability values shared by all control-plane adapters.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityStatus {
    Supported,
    Unavailable,
    Experimental,
    PlatformRestricted,
}

/// A command advertised by the runtime, with an honest availability state.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneCapability {
    pub id: &'static str,
    pub status: CapabilityStatus,
    pub scopes: &'static [CommandScope],
    pub conditional_scopes: &'static [CommandScope],
    pub scope_condition: Option<&'static str>,
    pub note: Option<&'static str>,
}

/// Daemon command availability for the current Control Plane contract.
/// Client-specific parity is tracked separately and must not be inferred from
/// daemon support alone.
pub const CONTROL_PLANE_CAPABILITIES: &[ControlPlaneCapability] = &[
    ControlPlaneCapability {
        id: "addDownload",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskAdd],
        conditional_scopes: &[CommandScope::TorrentManage],
        scope_condition: Some("urlIsMagnet"),
        note: Some("Magnet downloads also require torrentManage."),
    },
    ControlPlaneCapability {
        id: "addMediaDownload",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskAdd, CommandScope::MediaManage],
        conditional_scopes: &[CommandScope::TorrentManage],
        scope_condition: Some("urlIsMagnet"),
        note: Some("Magnet downloads also require torrentManage."),
    },
    ControlPlaneCapability {
        id: "addMediaPlaylist",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskAdd, CommandScope::MediaManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "addTorrent",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskAdd, CommandScope::TorrentManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "storeCredential",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::CredentialManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Stores the secret in the operating-system credential store; the backend must be available."),
    },
    ControlPlaneCapability {
        id: "deleteCredential",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::CredentialManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Deletes a secret from the operating-system credential store."),
    },
    ControlPlaneCapability {
        id: "pauseTask",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskControl],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "resumeTask",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskControl],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "retryTask",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskControl],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Reuses the engine resume path and retained partial data when available."),
    },
    ControlPlaneCapability {
        id: "updateTask",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskControl],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Task name and URL metadata only."),
    },
    ControlPlaneCapability {
        id: "redownloadTask",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskControl, CommandScope::DeleteFiles],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Starts again from the beginning."),
    },
    ControlPlaneCapability {
        id: "deleteTask",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::TaskDelete],
        conditional_scopes: &[CommandScope::DeleteFiles],
        scope_condition: Some("deleteFilesIsTrue"),
        note: Some("Deleting on-disk files additionally needs deleteFiles scope."),
    },
    ControlPlaneCapability {
        id: "moveTask",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "setTaskPriority",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "startQueue",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage, CommandScope::TaskControl],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "createQueue",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Queue configuration is normalized and persisted by the runtime."),
    },
    ControlPlaneCapability {
        id: "updateQueue",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "deleteQueue",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Tasks are returned to the main queue before removal."),
    },
    ControlPlaneCapability {
        id: "reorderQueues",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("The request must contain every queue exactly once."),
    },
    ControlPlaneCapability {
        id: "reorderQueueTasks",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("The request must contain every task in the queue exactly once."),
    },
    ControlPlaneCapability {
        id: "stopQueue",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::QueueManage, CommandScope::TaskControl],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "setActiveProfile",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::ProfileManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Applies retry and bandwidth policy to the runtime."),
    },
    ControlPlaneCapability {
        id: "upsertProfile",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::ProfileManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Built-in profile identifiers are reserved."),
    },
    ControlPlaneCapability {
        id: "deleteProfile",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::ProfileManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Built-in profiles cannot be removed."),
    },
    ControlPlaneCapability {
        id: "addRule",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::RulesManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Rule constraints are validated by the runtime rule engine."),
    },
    ControlPlaneCapability {
        id: "deleteRule",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::RulesManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "addSchedule",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::ScheduleManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "updateSchedule",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::ScheduleManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "deleteSchedule",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::ScheduleManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: None,
    },
    ControlPlaneCapability {
        id: "setSchedulerPowerCommands",
        status: CapabilityStatus::Supported,
        scopes: &[CommandScope::ScheduleManage],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Destructive power actions remain disabled unless explicitly enabled."),
    },
    ControlPlaneCapability {
        id: "batch.bestEffort",
        status: CapabilityStatus::Supported,
        scopes: &[],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Maximum 128 commands per batch."),
    },
    ControlPlaneCapability {
        id: "batch.atomic",
        status: CapabilityStatus::Unavailable,
        scopes: &[],
        conditional_scopes: &[],
        scope_condition: None,
        note: Some("Download engines do not expose transactional rollback."),
    },
];

/// Authorization scopes recognized by the shared command contract.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandScope {
    Read,
    TaskAdd,
    TaskControl,
    TaskDelete,
    DeleteFiles,
    QueueManage,
    ProfileManage,
    ScheduleManage,
    RulesManage,
    NetworkManage,
    TorrentManage,
    MediaManage,
    Admin,
    CredentialManage,
}

/// Secret material accepted by the credential command contract.
///
/// Debug output is always redacted and the owned bytes are cleared on drop.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CredentialSecret(String);

impl CredentialSecret {
    pub fn new(secret: String) -> Self {
        Self(secret)
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for CredentialSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("CredentialSecret([REDACTED])")
    }
}

impl Drop for CredentialSecret {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.0);
    }
}

/// Identity and scopes attached by a trusted adapter after authentication.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub subject: String,
    #[serde(default)]
    pub scopes: Vec<CommandScope>,
}

impl Principal {
    /// Local authenticated clients currently share the daemon's local token.
    /// This explicit principal keeps that existing boundary visible while
    /// leaving room for scoped tokens without changing command payloads.
    pub fn local_admin() -> Self {
        Self {
            subject: "local-api".to_owned(),
            scopes: vec![CommandScope::Admin],
        }
    }

    pub fn allows(&self, scope: CommandScope) -> bool {
        self.scopes.contains(&CommandScope::Admin) || self.scopes.contains(&scope)
    }
}

/// Supported state-changing operations carried over the unified command bus.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlCommand {
    AddDownload {
        request: serde_json::Value,
    },
    AddMediaDownload {
        request: serde_json::Value,
    },
    AddMediaPlaylist {
        request: serde_json::Value,
    },
    AddTorrent {
        request: serde_json::Value,
    },
    StoreCredential {
        #[serde(rename = "credentialId")]
        credential_id: String,
        secret: CredentialSecret,
    },
    DeleteCredential {
        #[serde(rename = "credentialId")]
        credential_id: String,
    },
    PauseTask {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    ResumeTask {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    RetryTask {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    RedownloadTask {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    DeleteTask {
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(default, rename = "deleteFiles")]
        delete_files: bool,
    },
    MoveTask {
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "queueId")]
        queue_id: String,
    },
    SetTaskPriority {
        #[serde(rename = "taskId")]
        task_id: String,
        priority: u32,
    },
    UpdateTask {
        #[serde(rename = "taskId")]
        task_id: String,
        request: serde_json::Value,
    },
    StartQueue {
        #[serde(rename = "queueId")]
        queue_id: String,
    },
    StopQueue {
        #[serde(rename = "queueId")]
        queue_id: String,
    },
    CreateQueue {
        name: String,
        #[serde(default, rename = "taskId")]
        task_id: Option<String>,
    },
    UpdateQueue {
        #[serde(rename = "queueId")]
        queue_id: String,
        queue: serde_json::Value,
    },
    DeleteQueue {
        #[serde(rename = "queueId")]
        queue_id: String,
    },
    ReorderQueues {
        #[serde(rename = "queueIds")]
        queue_ids: Vec<String>,
    },
    ReorderQueueTasks {
        #[serde(rename = "queueId")]
        queue_id: String,
        #[serde(rename = "taskIds")]
        task_ids: Vec<String>,
    },
    SetActiveProfile {
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    UpsertProfile {
        request: serde_json::Value,
    },
    DeleteProfile {
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    AddRule {
        request: serde_json::Value,
    },
    DeleteRule {
        #[serde(rename = "ruleId")]
        rule_id: String,
    },
    AddSchedule {
        request: serde_json::Value,
    },
    UpdateSchedule {
        request: serde_json::Value,
    },
    DeleteSchedule {
        #[serde(rename = "scheduleId")]
        schedule_id: String,
    },
    SetSchedulerPowerCommands {
        enabled: bool,
    },
    Batch {
        mode: BatchMode,
        commands: Vec<ControlCommand>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchMode {
    BestEffort,
    Atomic,
}

/// Idempotent command request envelope. `principal` is intentionally not a
/// field here; the adapter supplies it from its authentication boundary.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEnvelope {
    pub contract_version: u32,
    pub request_id: String,
    pub idempotency_key: String,
    pub command: ControlCommand,
}

impl CommandEnvelope {
    pub fn validate(&self) -> Result<(), StructuredError> {
        if self.contract_version != CONTROL_PLANE_CONTRACT_VERSION {
            return Err(StructuredError::new(
                "unsupported_contract_version",
                format!(
                    "Command contract version {} is unsupported; this runtime accepts version {}.",
                    self.contract_version, CONTROL_PLANE_CONTRACT_VERSION
                ),
                400,
                false,
            ));
        }
        validate_identifier(&self.request_id, "requestId", 128)?;
        validate_identifier(&self.idempotency_key, "idempotencyKey", 128)?;
        self.command.validate(0)
    }
}

impl ControlCommand {
    /// Return all scopes needed to execute this command, including nested
    /// batch operations. Duplicate scopes are removed.
    pub fn required_scopes(&self) -> Vec<CommandScope> {
        let mut scopes = Vec::new();
        self.collect_scopes(&mut scopes);
        scopes.sort_by_key(|scope| *scope as u8);
        scopes.dedup();
        scopes
    }

    fn collect_scopes(&self, scopes: &mut Vec<CommandScope>) {
        match self {
            Self::AddDownload { request } => {
                scopes.push(CommandScope::TaskAdd);
                if is_magnet_request(request) {
                    scopes.push(CommandScope::TorrentManage);
                }
            }
            Self::AddMediaDownload { request } => {
                scopes.push(CommandScope::TaskAdd);
                scopes.push(CommandScope::MediaManage);
                if is_magnet_request(request) {
                    scopes.push(CommandScope::TorrentManage);
                }
            }
            Self::AddMediaPlaylist { .. } => {
                scopes.push(CommandScope::TaskAdd);
                scopes.push(CommandScope::MediaManage);
            }
            Self::AddTorrent { .. } => {
                scopes.push(CommandScope::TaskAdd);
                scopes.push(CommandScope::TorrentManage);
            }
            Self::StoreCredential { .. } | Self::DeleteCredential { .. } => {
                scopes.push(CommandScope::CredentialManage);
            }
            Self::PauseTask { .. }
            | Self::ResumeTask { .. }
            | Self::RetryTask { .. }
            | Self::UpdateTask { .. } => {
                scopes.push(CommandScope::TaskControl);
            }
            Self::RedownloadTask { .. } => {
                scopes.push(CommandScope::TaskControl);
                scopes.push(CommandScope::DeleteFiles);
            }
            Self::DeleteTask { delete_files, .. } => {
                scopes.push(CommandScope::TaskDelete);
                if *delete_files {
                    scopes.push(CommandScope::DeleteFiles);
                }
            }
            Self::MoveTask { .. } | Self::SetTaskPriority { .. } => {
                scopes.push(CommandScope::QueueManage);
            }
            Self::StartQueue { .. } | Self::StopQueue { .. } => {
                scopes.push(CommandScope::QueueManage);
                scopes.push(CommandScope::TaskControl);
            }
            Self::CreateQueue { .. }
            | Self::UpdateQueue { .. }
            | Self::DeleteQueue { .. }
            | Self::ReorderQueues { .. }
            | Self::ReorderQueueTasks { .. } => {
                scopes.push(CommandScope::QueueManage);
            }
            Self::SetActiveProfile { .. }
            | Self::UpsertProfile { .. }
            | Self::DeleteProfile { .. } => {
                scopes.push(CommandScope::ProfileManage);
            }
            Self::AddRule { .. } | Self::DeleteRule { .. } => {
                scopes.push(CommandScope::RulesManage);
            }
            Self::AddSchedule { .. }
            | Self::UpdateSchedule { .. }
            | Self::DeleteSchedule { .. }
            | Self::SetSchedulerPowerCommands { .. } => {
                scopes.push(CommandScope::ScheduleManage);
            }
            Self::Batch { commands, .. } => {
                for command in commands {
                    command.collect_scopes(scopes);
                }
            }
        }
    }

    fn validate(&self, depth: usize) -> Result<(), StructuredError> {
        match self {
            Self::AddDownload { request }
            | Self::AddMediaDownload { request }
            | Self::AddMediaPlaylist { request }
            | Self::AddTorrent { request } => {
                if !request.is_object() {
                    return Err(StructuredError::new(
                        "invalid_command_payload",
                        "Download request must be a JSON object.",
                        400,
                        false,
                    ));
                }
            }
            Self::UpdateTask { task_id, request } => {
                validate_identifier(task_id, "taskId", 128)?;
                if !request.is_object() {
                    return Err(StructuredError::new(
                        "invalid_command_payload",
                        "Task update must be a JSON object.",
                        400,
                        false,
                    ));
                }
            }
            Self::PauseTask { task_id }
            | Self::ResumeTask { task_id }
            | Self::RetryTask { task_id }
            | Self::RedownloadTask { task_id }
            | Self::DeleteTask { task_id, .. } => {
                validate_identifier(task_id, "taskId", 128)?;
            }
            Self::MoveTask { task_id, queue_id } => {
                validate_identifier(task_id, "taskId", 128)?;
                validate_identifier(queue_id, "queueId", 128)?;
            }
            Self::SetTaskPriority { task_id, priority } => {
                validate_identifier(task_id, "taskId", 128)?;
                if *priority > 4 {
                    return Err(StructuredError::new(
                        "invalid_priority",
                        "Task priority must be between 0 (critical) and 4 (background).",
                        400,
                        false,
                    ));
                }
            }
            Self::StartQueue { queue_id } | Self::StopQueue { queue_id } => {
                validate_identifier(queue_id, "queueId", 128)?;
            }
            Self::CreateQueue { name, task_id } => {
                if name.trim().is_empty() || name.len() > 160 || name.chars().any(char::is_control)
                {
                    return Err(StructuredError::new(
                        "invalid_queue_name",
                        "Queue name must be non-empty, at most 160 bytes, and contain no control characters.",
                        400,
                        false,
                    ));
                }
                if let Some(task_id) = task_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|task_id| !task_id.is_empty())
                {
                    validate_identifier(task_id, "taskId", 128)?;
                }
            }
            Self::UpdateQueue { queue_id, queue } => {
                validate_identifier(queue_id, "queueId", 128)?;
                if !queue.is_object() {
                    return Err(StructuredError::new(
                        "invalid_command_payload",
                        "Queue update must be a JSON object.",
                        400,
                        false,
                    ));
                }
            }
            Self::DeleteQueue { queue_id } => validate_identifier(queue_id, "queueId", 128)?,
            Self::ReorderQueues { queue_ids } => {
                if queue_ids.is_empty() || queue_ids.len() > 128 {
                    return Err(StructuredError::new(
                        "invalid_queue_order",
                        "queueIds must contain between 1 and 128 queue identifiers.",
                        400,
                        false,
                    ));
                }
                for queue_id in queue_ids {
                    validate_identifier(queue_id, "queueId", 128)?;
                }
            }
            Self::ReorderQueueTasks { queue_id, task_ids } => {
                validate_identifier(queue_id, "queueId", 128)?;
                if task_ids.len() > 10_000 {
                    return Err(StructuredError::new(
                        "invalid_task_order",
                        "taskIds cannot contain more than 10000 task identifiers.",
                        400,
                        false,
                    ));
                }
                for task_id in task_ids {
                    validate_identifier(task_id, "taskId", 128)?;
                }
            }
            Self::SetActiveProfile { profile_id } | Self::DeleteProfile { profile_id } => {
                validate_identifier(profile_id, "profileId", 128)?;
            }
            Self::UpsertProfile { request } => {
                if !request.is_object() {
                    return Err(StructuredError::new(
                        "invalid_command_payload",
                        "Profile request must be a JSON object.",
                        400,
                        false,
                    ));
                }
                let profile_id = request
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        StructuredError::new(
                            "invalid_command_payload",
                            "Profile request must include a string id.",
                            400,
                            false,
                        )
                    })?;
                validate_identifier(profile_id, "profileId", 128)?;
            }
            Self::AddRule { request } => {
                if !request.is_object() {
                    return Err(StructuredError::new(
                        "invalid_command_payload",
                        "Rule request must be a JSON object.",
                        400,
                        false,
                    ));
                }
                let rule_id = request
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        StructuredError::new(
                            "invalid_command_payload",
                            "Rule request must include a string id.",
                            400,
                            false,
                        )
                    })?;
                validate_identifier(rule_id, "ruleId", 128)?;
            }
            Self::DeleteRule { rule_id } => validate_identifier(rule_id, "ruleId", 128)?,
            Self::AddSchedule { request } | Self::UpdateSchedule { request } => {
                if !request.is_object() {
                    return Err(StructuredError::new(
                        "invalid_command_payload",
                        "Schedule request must be a JSON object.",
                        400,
                        false,
                    ));
                }
                let schedule_id = request
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        StructuredError::new(
                            "invalid_command_payload",
                            "Schedule request must include a string id.",
                            400,
                            false,
                        )
                    })?;
                validate_identifier(schedule_id, "scheduleId", 128)?;
            }
            Self::DeleteSchedule { schedule_id } => {
                validate_identifier(schedule_id, "scheduleId", 128)?;
            }
            Self::StoreCredential {
                credential_id,
                secret,
            } => {
                validate_credential_id(credential_id)?;
                if secret.expose_secret().is_empty()
                    || secret.expose_secret().len() > 16_384
                    || secret.expose_secret().contains('\0')
                {
                    return Err(StructuredError::new(
                        "invalid_credential_secret",
                        "Credential secret must contain 1 to 16384 bytes and no NUL character.",
                        400,
                        false,
                    ));
                }
            }
            Self::DeleteCredential { credential_id } => {
                validate_credential_id(credential_id)?;
            }
            Self::SetSchedulerPowerCommands { .. } => {}
            Self::Batch { commands, .. } => {
                if depth > 0 {
                    return Err(StructuredError::new(
                        "nested_batch_not_allowed",
                        "A batch cannot contain another batch.",
                        400,
                        false,
                    ));
                }
                if commands.is_empty() || commands.len() > MAX_COMMAND_BATCH_SIZE {
                    return Err(StructuredError::new(
                        "invalid_batch_size",
                        format!(
                            "A batch must contain between 1 and {MAX_COMMAND_BATCH_SIZE} commands."
                        ),
                        400,
                        false,
                    ));
                }
                for command in commands {
                    command.validate(depth + 1)?;
                }
            }
        }
        Ok(())
    }
}

fn is_magnet_request(request: &serde_json::Value) -> bool {
    request
        .get("url")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|url| url.trim().to_ascii_lowercase().starts_with("magnet:"))
}

/// Supported read-only query shapes. Query adapters should return these
/// through the same versioned contract as commands.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlQuery {
    Capabilities,
    ListQueues,
    ListProfiles,
    GetProfile {
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    ListRules,
    ListSchedules,
    ListTasks {
        #[serde(default)]
        filter: TaskQueryFilter,
    },
    Diagnostics,
    RecentLogs {
        limit: Option<u32>,
        level: Option<String>,
    },
    GetTask {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    Events {
        cursor: Option<String>,
        limit: Option<u32>,
    },
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueryFilter {
    pub status: Option<Vec<String>>,
    pub queue_id: Option<String>,
    pub category: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryEnvelope {
    pub contract_version: u32,
    pub request_id: String,
    pub query: ControlQuery,
}

impl QueryEnvelope {
    pub fn validate(&self) -> Result<(), StructuredError> {
        if self.contract_version != CONTROL_PLANE_CONTRACT_VERSION {
            return Err(StructuredError::new(
                "unsupported_contract_version",
                format!(
                    "Query contract version {} is unsupported; this runtime accepts version {}.",
                    self.contract_version, CONTROL_PLANE_CONTRACT_VERSION
                ),
                400,
                false,
            ));
        }
        validate_identifier(&self.request_id, "requestId", 128)?;
        match &self.query {
            ControlQuery::GetProfile { profile_id } => {
                validate_identifier(profile_id, "profileId", 128)?;
            }
            ControlQuery::ListProfiles => {}
            ControlQuery::ListRules => {}
            ControlQuery::ListSchedules => {}
            ControlQuery::GetTask { task_id } => {
                validate_identifier(task_id, "taskId", 128)?;
            }
            ControlQuery::ListTasks { filter } => {
                validate_limit(filter.limit)?;
                if filter
                    .status
                    .as_ref()
                    .is_some_and(|values| values.len() > 32)
                {
                    return Err(StructuredError::new(
                        "invalid_status_filter",
                        "At most 32 task statuses may be included in a query filter.",
                        400,
                        false,
                    ));
                }
                if let Some(statuses) = filter.status.as_ref() {
                    for status in statuses {
                        validate_identifier(status, "status", 32)?;
                    }
                }
                if let Some(cursor) = filter.cursor.as_deref() {
                    validate_identifier(cursor, "cursor", 128)?;
                }
                if let Some(queue_id) = filter.queue_id.as_deref() {
                    validate_identifier(queue_id, "queueId", 128)?;
                }
                if let Some(category) = filter.category.as_deref() {
                    validate_identifier(category, "category", 128)?;
                }
            }
            ControlQuery::RecentLogs { limit, level } => {
                validate_limit(*limit)?;
                if let Some(level) = level.as_deref() {
                    if !matches!(
                        level.trim().to_ascii_lowercase().as_str(),
                        "trace" | "debug" | "info" | "warn" | "error"
                    ) {
                        return Err(StructuredError::new(
                            "invalid_log_level",
                            "Log level must be trace, debug, info, warn, or error.",
                            400,
                            false,
                        ));
                    }
                }
            }
            ControlQuery::Diagnostics => {}
            ControlQuery::Events { cursor, limit } => {
                validate_limit(*limit)?;
                if let Some(cursor) = cursor.as_deref() {
                    validate_identifier(cursor, "cursor", 1024)?;
                }
            }
            ControlQuery::Capabilities => {}
            ControlQuery::ListQueues => {}
        }
        Ok(())
    }
}

/// Stable page shape for cursor-based query responses.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPage<T> {
    pub contract_version: u32,
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total: Option<u64>,
}

/// Stable, redacted event shape shared by every control-plane client.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEvent {
    pub schema_version: u32,
    pub event_id: u64,
    pub event_type: String,
    pub task_id: Option<String>,
    pub timestamp_millis: u128,
    pub data: serde_json::Value,
}

/// Common machine-readable error returned by commands and queries.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredError {
    pub code: String,
    pub message: String,
    pub http_status: u16,
    pub retryable: bool,
    pub replayed: bool,
    pub details: Option<serde_json::Value>,
}

impl StructuredError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        http_status: u16,
        retryable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            http_status,
            retryable,
            replayed: false,
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

fn validate_identifier(value: &str, field: &str, max_bytes: usize) -> Result<(), StructuredError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_bytes || trimmed.chars().any(char::is_control) {
        return Err(StructuredError::new(
            "invalid_identifier",
            format!("{field} must be non-empty, at most {max_bytes} bytes, and contain no control characters."),
            400,
            false,
        ));
    }
    Ok(())
}

fn validate_credential_id(value: &str) -> Result<(), StructuredError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !valid {
        return Err(StructuredError::new(
            "invalid_credential_id",
            "credentialId must be 1 to 128 ASCII letters, digits, dots, underscores, or hyphens.",
            400,
            false,
        ));
    }
    Ok(())
}

fn validate_limit(limit: Option<u32>) -> Result<(), StructuredError> {
    if limit.is_some_and(|value| value == 0 || value > 1000) {
        return Err(StructuredError::new(
            "invalid_page_limit",
            "Query limit must be between 1 and 1000.",
            400,
            false,
        ));
    }
    Ok(())
}
