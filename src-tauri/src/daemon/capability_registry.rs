//! Assemble the public registry from the capability probes used by runtime.

use std::collections::BTreeMap;

use nova_core_model::{CapabilityEntry, CapabilityRegistry, CapabilityStatus};
use serde_json::{json, Value};

fn bool_at(value: &Value, pointer: &str) -> bool {
    value
        .pointer(pointer)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn value_at(value: &Value, pointer: &str) -> Value {
    value.pointer(pointer).cloned().unwrap_or(Value::Null)
}

fn strings_at(value: &Value, pointer: &str) -> Vec<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn supports_option(curl: &Value, option: &str) -> bool {
    strings_at(curl, "/supportedDirectOptionKeys")
        .iter()
        .any(|candidate| candidate == option)
}

fn command_supported(commands: &Value, id: &str) -> bool {
    commands
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|entry| entry.get("status"))
        .and_then(Value::as_str)
        == Some("supported")
}

fn command_note(commands: &Value, id: &str) -> Option<String> {
    commands
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|entry| entry.get("note"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn object_map(value: Value) -> BTreeMap<String, Value> {
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn entry(
    id: &str,
    supported: bool,
    unavailable_reason: Option<String>,
    source: &str,
    operations: &[&str],
    events: &[&str],
    constraints: Value,
) -> CapabilityEntry {
    CapabilityEntry {
        id: id.to_owned(),
        version: 1,
        status: if supported {
            CapabilityStatus::Supported
        } else {
            CapabilityStatus::Unavailable
        },
        platforms: vec![std::env::consts::OS.to_owned()],
        client_adapters: BTreeMap::new(),
        operations: operations.iter().map(|value| (*value).to_owned()).collect(),
        events: events.iter().map(|value| (*value).to_owned()).collect(),
        constraints: object_map(constraints),
        reason: if supported {
            None
        } else {
            Some(unavailable_reason.unwrap_or_else(|| {
                "The current runtime does not report this capability as available.".to_owned()
            }))
        },
        evidence: vec![format!("engineCapabilities:{source}")],
    }
}

fn command_group(
    commands: &Value,
    id: &str,
    required_commands: &[&str],
    operations: &[&str],
    event_types: &[&str],
) -> CapabilityEntry {
    let supported = required_commands
        .iter()
        .all(|command| command_supported(commands, command));
    let reason = if supported {
        None
    } else {
        required_commands
            .iter()
            .filter(|command| !command_supported(commands, command))
            .find_map(|command| command_note(commands, command))
            .or_else(|| Some("One or more required command handlers are unavailable.".to_owned()))
    };
    entry(
        id,
        supported,
        reason,
        "controlPlane.commandCapabilities",
        operations,
        event_types,
        json!({"commands": required_commands}),
    )
}

/// Create one sorted registry from live direct, media, torrent, and command
/// capabilities. Client adapter parity remains owned by the parity manifest.
pub fn build_runtime_capability_registry(
    curl: &Value,
    media: &Value,
    torrent: &Value,
    command_capabilities: &Value,
) -> CapabilityRegistry {
    let direct_ready = bool_at(curl, "/capabilities/directDownloads");
    let media_ready = bool_at(media, "/available");
    let torrent_ready = bool_at(torrent, "/available");
    let hls_ready = media_ready && bool_at(media, "/capabilities/hlsTaskExecution");
    let dash_ready = media_ready && bool_at(media, "/capabilities/dashTaskExecution");
    let segmented_ready = direct_ready && bool_at(curl, "/libcurlMulti/segmentedDownloads");
    let resume_ready = direct_ready && bool_at(curl, "/capabilities/resume");
    let audio_transcode_ready = media_ready && bool_at(media, "/capabilities/audioTranscoding");
    let video_transcode_ready = media_ready && bool_at(media, "/capabilities/videoTranscoding");
    let subtitle_embed_ready = media_ready && bool_at(media, "/capabilities/subtitleEmbed");
    let non_mp4_mux_ready = media_ready
        && media
            .pointer("/capabilities/nonMp4MuxBackend")
            .and_then(Value::as_str)
            == Some("nova-in-process-rust");
    let native_codec_registry_ready = media
        .pointer("/capabilities/nativeCodecRegistry/source")
        .and_then(Value::as_str)
        == Some("nova-media-processing-core");
    let proxy_ready = bool_at(curl, "/capabilities/proxy");
    let interface_binding_ready = bool_at(curl, "/capabilities/sourceInterface");
    let doh_ready = supports_option(curl, "dohUrl");
    let custom_dns_ready = supports_option(curl, "dnsServers");
    let magnet_ready = torrent_ready && bool_at(torrent, "/capabilities/magnetResolver");
    let dht_ready = torrent_ready && bool_at(torrent, "/capabilities/dht");
    let direct_protocols = value_at(curl, "/protocols");
    let proxy_options = strings_at(curl, "/supportedDirectOptionKeys")
        .into_iter()
        .filter(|option| option.starts_with("proxy") || option == "preProxy" || option == "noproxy")
        .collect::<Vec<_>>();
    let torrent_capabilities = value_at(torrent, "/capabilities");
    let native_codec_registry = value_at(media, "/capabilities/nativeCodecRegistry");

    let entries = vec![
        entry(
            "download.direct",
            direct_ready,
            Some("Linked libcurl does not expose a supported direct-download protocol.".to_owned()),
            "engines.libcurlMulti.capabilities.directDownloads",
            &["add", "pause", "resume", "retry", "delete"],
            &[
                "download.started",
                "download.progress",
                "download.completed",
                "download.failed",
            ],
            json!({
                "protocols": direct_protocols,
                "rangeRequests": value_at(curl, "/capabilities/rangeRequests"),
                "maxConnectionsPerTask": value_at(curl, "/libcurlMulti/maxConnectionsPerTask")
            }),
        ),
        entry(
            "download.segmented",
            segmented_ready,
            Some(
                "The linked direct-download runtime does not report segmented transfer support."
                    .to_owned(),
            ),
            "engines.libcurlMulti.libcurlMulti.segmentedDownloads",
            &["add", "pause", "resume"],
            &["download.progress", "download.connections_adjusted"],
            json!({
                "maximumConnectionsPerTask": value_at(curl, "/libcurlMulti/maxConnectionsPerTask")
            }),
        ),
        entry(
            "download.resume",
            resume_ready,
            Some("The linked direct-download runtime does not report resume support.".to_owned()),
            "engines.libcurlMulti.capabilities.resume",
            &["resume", "retry"],
            &["download.resumed", "download.retrying"],
            json!({"rangeRequests": value_at(curl, "/capabilities/rangeRequests")}),
        ),
        entry(
            "download.retry",
            direct_ready && bool_at(curl, "/capabilities/retry"),
            Some("The linked libcurl build does not expose retry controls.".to_owned()),
            "engines.libcurlMulti.capabilities.retry",
            &["retry"],
            &["download.retrying", "download.retry_scheduled"],
            json!({
                "retryAllErrors": value_at(curl, "/capabilities/retryAllErrors"),
                "retryConnectionRefused": value_at(curl, "/capabilities/retryConnRefused")
            }),
        ),
        entry(
            "network.proxy",
            proxy_ready,
            Some("The linked libcurl build does not expose proxy support.".to_owned()),
            "engines.libcurlMulti.capabilities.proxy",
            &["configure", "add"],
            &["download.started", "download.failed"],
            json!({"supportedOptions": proxy_options}),
        ),
        entry(
            "network.interfaceBinding",
            interface_binding_ready,
            Some("The linked libcurl build does not expose source-interface binding.".to_owned()),
            "engines.libcurlMulti.capabilities.sourceInterface",
            &["bindInterface", "add"],
            &["download.started", "download.failed"],
            json!({"option": "interface"}),
        ),
        entry(
            "network.dns.custom",
            custom_dns_ready,
            Some(
                "The linked libcurl build does not expose custom DNS resolver selection."
                    .to_owned(),
            ),
            "engines.libcurlMulti.supportedDirectOptionKeys",
            &["configure", "resolve"],
            &["download.started", "download.failed"],
            json!({"option": "dnsServers"}),
        ),
        entry(
            "network.dns.doh",
            doh_ready,
            Some(
                "The linked libcurl build does not expose DNS-over-HTTPS configuration.".to_owned(),
            ),
            "engines.libcurlMulti.supportedDirectOptionKeys",
            &["configure", "resolve"],
            &["download.started", "download.failed"],
            json!({"option": "dohUrl"}),
        ),
        entry(
            "network.profile",
            false,
            Some("Unified per-task and per-queue network profiles are not implemented.".to_owned()),
            "controlPlane.networkProfiles",
            &["select", "assign"],
            &[],
            json!({}),
        ),
        entry(
            "media.extraction",
            media_ready,
            Some("The native media extraction engine is unavailable in this runtime.".to_owned()),
            "engines.media.available",
            &["probe", "add"],
            &["download.started", "download.completed", "download.failed"],
            json!({"nativeEngine": value_at(media, "/runtimeCore")}),
        ),
        entry(
            "media.hls",
            hls_ready,
            Some("Native HLS task execution is unavailable in this runtime.".to_owned()),
            "engines.media.capabilities.hlsTaskExecution",
            &["probe", "add", "pause", "resume"],
            &[
                "download.started",
                "download.progress",
                "download.completed",
            ],
            json!({"live": value_at(media, "/capabilities/hlsLiveRefresh")}),
        ),
        entry(
            "media.dash",
            dash_ready,
            Some("Native DASH task execution is unavailable in this runtime.".to_owned()),
            "engines.media.capabilities.dashTaskExecution",
            &["probe", "add", "pause", "resume"],
            &[
                "download.started",
                "download.progress",
                "download.completed",
            ],
            json!({"dynamic": value_at(media, "/capabilities/dashDynamicTaskExecution")}),
        ),
        entry(
            "media.nativeCodecs",
            media_ready && native_codec_registry_ready,
            Some("The in-process codec registry is unavailable in this build.".to_owned()),
            "engines.media.capabilities.nativeCodecRegistry",
            &["inspect", "select"],
            &["download.started", "download.completed", "download.failed"],
            json!({"registry": native_codec_registry}),
        ),
        entry(
            "media.nativeMux",
            media_ready
                && (bool_at(media, "/capabilities/nativeMp4MultitrackMux") || non_mp4_mux_ready),
            Some("No compatible in-process media muxer is available in this build.".to_owned()),
            "engines.media.capabilities.nativeMp4MultitrackMux",
            &["mux", "remux"],
            &["download.started", "download.completed", "download.failed"],
            json!({
                "mp4": value_at(media, "/capabilities/nativeMp4MultitrackMux"),
                "nonMp4": non_mp4_mux_ready
            }),
        ),
        entry(
            "media.audioTranscode",
            audio_transcode_ready,
            Some(
                "No compatible in-process audio encoder and decoder pair is available.".to_owned(),
            ),
            "engines.media.capabilities.audioTranscoding",
            &["transcode", "extractAudio"],
            &["download.started", "download.completed", "download.failed"],
            json!({"codecRegistry": native_codec_registry_ready}),
        ),
        entry(
            "media.videoTranscode",
            video_transcode_ready,
            Some(
                "No compatible in-process video encoder and decoder pair is available.".to_owned(),
            ),
            "engines.media.capabilities.videoTranscoding",
            &["transcode"],
            &["download.started", "download.completed", "download.failed"],
            json!({"codecRegistry": native_codec_registry_ready}),
        ),
        entry(
            "media.subtitleEmbedding",
            subtitle_embed_ready,
            Some("The in-process subtitle muxer is unavailable in this build.".to_owned()),
            "engines.media.capabilities.subtitleEmbed",
            &["embed"],
            &["download.started", "download.completed", "download.failed"],
            json!({"containerSupport": value_at(media, "/capabilities/nativeCodecRegistry/subtitleContainers")}),
        ),
        entry(
            "torrent.core",
            torrent_ready,
            Some("The native torrent engine is unavailable in this runtime.".to_owned()),
            "engines.torrent.available",
            &["add", "pause", "resume", "retry", "delete"],
            &[
                "download.started",
                "download.progress",
                "download.completed",
                "download.failed",
            ],
            json!({"engine": value_at(torrent, "/runtimeCore"), "capabilities": torrent_capabilities}),
        ),
        entry(
            "torrent.magnet",
            magnet_ready,
            Some("Native magnet metadata resolution is unavailable in this runtime.".to_owned()),
            "engines.torrent.capabilities.magnetResolver",
            &["resolveMagnet", "add"],
            &["download.started", "download.failed"],
            json!({"metainfoExchange": value_at(torrent, "/capabilities/metadataExchangeProtocol")}),
        ),
        entry(
            "torrent.dht",
            dht_ready,
            Some("Native DHT discovery is unavailable in this runtime.".to_owned()),
            "engines.torrent.capabilities.dht",
            &["discoverPeers", "announce"],
            &["download.progress"],
            json!({
                "ipv4": value_at(torrent, "/capabilities/dhtIpv4Server"),
                "ipv6": value_at(torrent, "/capabilities/dhtIpv6Server")
            }),
        ),
        command_group(
            command_capabilities,
            "queue.management",
            &[
                "createQueue",
                "updateQueue",
                "deleteQueue",
                "reorderQueues",
                "reorderQueueTasks",
                "moveTask",
                "setTaskPriority",
                "startQueue",
                "stopQueue",
            ],
            &["create", "update", "delete", "reorder", "moveTask"],
            &["queue.changed"],
        ),
        command_group(
            command_capabilities,
            "profile.management",
            &["upsertProfile", "deleteProfile", "setActiveProfile"],
            &["create", "update", "delete", "activate"],
            &["profile.switched"],
        ),
        command_group(
            command_capabilities,
            "rules.management",
            &["addRule", "deleteRule"],
            &["add", "delete"],
            &["rule.applied"],
        ),
        command_group(
            command_capabilities,
            "scheduler.management",
            &[
                "addSchedule",
                "updateSchedule",
                "deleteSchedule",
                "setSchedulerPowerCommands",
            ],
            &["add", "update", "delete"],
            &["scheduler.triggered"],
        ),
        entry(
            "batch.atomic",
            command_supported(command_capabilities, "batch.atomic"),
            command_note(command_capabilities, "batch.atomic"),
            "controlPlane.commandCapabilities",
            &["batch"],
            &[],
            json!({"bestEffortMaximum": nova_core_model::MAX_COMMAND_BATCH_SIZE}),
        ),
        entry(
            "security.scopedTokens",
            false,
            Some(
                "The daemon still uses a local bearer token shared by authenticated clients."
                    .to_owned(),
            ),
            "controlPlane.principalModel",
            &["issue", "rotate", "revoke"],
            &[],
            json!({"currentPrincipalModel": "local-bearer-admin"}),
        ),
        entry(
            "remote.control",
            false,
            Some(
                "Remote API security boundary, TLS, and scoped authentication are not implemented."
                    .to_owned(),
            ),
            "controlPlane.remoteApi",
            &["connect", "authorize"],
            &[],
            json!({"localLoopbackOnly": true}),
        ),
    ];

    CapabilityRegistry::new(
        nova_core_model::CAPABILITY_REGISTRY_CONTRACT_VERSION,
        entries,
    )
}
