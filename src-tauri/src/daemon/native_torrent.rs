use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use nova_torrent_core::{
    udp_connect_packet, HttpTrackerResponse, TrackerAnnounceRequest, TrackerPeer,
    UdpAnnounceResponse, UdpConnectResponse, MAX_TRACKER_RESPONSE_BYTES,
};
use reqwest::header::LOCATION;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpStream, UdpSocket};
use tokio::time::{sleep, timeout};

use crate::daemon::utils::{is_internal_ip, private_network_allowed};

const MAX_UDP_DATAGRAM_BYTES: usize = 65_535;
const MAX_TRACKER_ERROR_DETAILS: usize = 512;

#[derive(Clone, Debug)]
pub struct TrackerTransportConfig {
    pub request_timeout: Duration,
    pub retry_base_delay: Duration,
    pub max_attempts_per_tracker: usize,
    pub max_redirects: usize,
}

impl Default for TrackerTransportConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(10),
            retry_base_delay: Duration::from_millis(500),
            max_attempts_per_tracker: 2,
            max_redirects: 3,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrackerAnnounceSuccess {
    pub tracker_url: String,
    pub interval_seconds: u32,
    pub complete: Option<u32>,
    pub incomplete: Option<u32>,
    pub peers: Vec<TrackerPeer>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TrackerTransport {
    config: TrackerTransportConfig,
    allow_private_network: bool,
}

impl TrackerTransport {
    pub fn new(config: TrackerTransportConfig) -> Self {
        Self {
            config,
            allow_private_network: private_network_allowed(),
        }
    }

    pub fn production_default() -> Self {
        Self::new(TrackerTransportConfig::default())
    }

    /// Announce against ordered tracker tiers, preserving BEP 12 failover
    /// semantics: every tracker in a tier is attempted before moving to the
    /// next tier. Duplicate URLs are skipped globally.
    pub async fn announce_tiers(
        &self,
        tiers: &[Vec<String>],
        request: &TrackerAnnounceRequest,
    ) -> Result<TrackerAnnounceSuccess, String> {
        if tiers.is_empty() {
            return Err("Torrent has no trackers to announce to".to_owned());
        }

        let mut attempted = HashSet::new();
        let mut failures = Vec::new();
        for tier in tiers {
            for tracker in tier {
                if !attempted.insert(tracker.clone()) {
                    continue;
                }
                match self.announce_tracker(tracker, request).await {
                    Ok(success) => return Ok(success),
                    Err(error) => failures.push(format!(
                        "{}: {}",
                        tracker,
                        limit_error_detail(&error)
                    )),
                }
            }
        }

        if failures.is_empty() {
            Err("Torrent tracker tiers contained no usable tracker URLs".to_owned())
        } else {
            Err(format!(
                "All torrent trackers failed: {}",
                failures.join("; ")
            ))
        }
    }

    /// Announce against one tracker with bounded retry/backoff.
    pub async fn announce_tracker(
        &self,
        tracker_url: &str,
        request: &TrackerAnnounceRequest,
    ) -> Result<TrackerAnnounceSuccess, String> {
        let parsed = reqwest::Url::parse(tracker_url)
            .map_err(|error| format!("Invalid tracker URL: {error}"))?;
        let scheme = parsed.scheme().to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "udp") {
            return Err(format!("Unsupported tracker protocol '{scheme}'"));
        }

        let attempts = self.config.max_attempts_per_tracker.max(1);
        let mut last_error = None;
        for attempt in 0..attempts {
            let result = match scheme.as_str() {
                "http" | "https" => self.announce_http_once(tracker_url, request).await,
                "udp" => self.announce_udp_once(tracker_url, request).await,
                _ => unreachable!("validated tracker scheme"),
            };

            match result {
                Ok(success) => return Ok(success),
                Err(error) => {
                    let retryable = error.retryable;
                    last_error = Some(error.message);
                    if !retryable || attempt + 1 >= attempts {
                        break;
                    }
                    sleep(retry_delay(self.config.retry_base_delay, attempt)).await;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| "Tracker announce failed".to_owned()))
    }

    async fn announce_http_once(
        &self,
        tracker_url: &str,
        request: &TrackerAnnounceRequest,
    ) -> Result<TrackerAnnounceSuccess, TrackerAttemptError> {
        let announce_url = request
            .to_http_url(tracker_url)
            .map_err(|error| TrackerAttemptError::hard(error.to_string()))?;
        let mut current = reqwest::Url::parse(&announce_url)
            .map_err(|error| TrackerAttemptError::hard(format!("Invalid announce URL: {error}")))?;

        for redirect_count in 0..=self.config.max_redirects {
            let endpoint = self.resolve_http_endpoint(&current).await?;
            let client = pinned_http_client(
                current.host_str().expect("validated HTTP tracker host"),
                endpoint,
                self.config.request_timeout,
            )?;

            let response = timeout(
                self.config.request_timeout,
                client
                    .get(current.clone())
                    .header(reqwest::header::ACCEPT, "text/plain, application/octet-stream;q=0.9, */*;q=0.1")
                    .send(),
            )
            .await
            .map_err(|_| TrackerAttemptError::retryable("HTTP tracker request timed out"))?
            .map_err(|error| TrackerAttemptError::retryable(format!("HTTP tracker request failed: {error}")))?;

            let status = response.status();
            if status.is_redirection() {
                if redirect_count >= self.config.max_redirects {
                    return Err(TrackerAttemptError::hard(
                        "HTTP tracker exceeded redirect limit",
                    ));
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| {
                        TrackerAttemptError::hard(
                            "HTTP tracker redirect is missing a valid Location header",
                        )
                    })?;
                current = current.join(location).map_err(|error| {
                    TrackerAttemptError::hard(format!(
                        "HTTP tracker returned an invalid redirect: {error}"
                    ))
                })?;
                continue;
            }

            if !status.is_success() {
                let retryable = status.as_u16() == 408
                    || status.as_u16() == 429
                    || status.is_server_error();
                let message = format!("HTTP tracker returned status {}", status.as_u16());
                return Err(if retryable {
                    TrackerAttemptError::retryable(message)
                } else {
                    TrackerAttemptError::hard(message)
                });
            }

            let body = read_tracker_body_limited(response).await?;
            let parsed = HttpTrackerResponse::parse(&body)
                .map_err(|error| TrackerAttemptError::hard(error.to_string()))?;
            return Ok(TrackerAnnounceSuccess {
                tracker_url: current.to_string(),
                interval_seconds: parsed.interval_seconds,
                complete: parsed.complete,
                incomplete: parsed.incomplete,
                peers: parsed.peers,
                warning: parsed.warning,
            });
        }

        Err(TrackerAttemptError::hard(
            "HTTP tracker redirect processing terminated unexpectedly",
        ))
    }

    async fn announce_udp_once(
        &self,
        tracker_url: &str,
        request: &TrackerAnnounceRequest,
    ) -> Result<TrackerAnnounceSuccess, TrackerAttemptError> {
        let parsed = reqwest::Url::parse(tracker_url)
            .map_err(|error| TrackerAttemptError::hard(format!("Invalid UDP tracker URL: {error}")))?;
        if parsed.scheme() != "udp" {
            return Err(TrackerAttemptError::hard(
                "UDP tracker request used a non-UDP URL",
            ));
        }
        reject_url_userinfo(&parsed)?;
        let host = parsed
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| TrackerAttemptError::hard("UDP tracker URL is missing a host"))?;
        let port = parsed
            .port()
            .ok_or_else(|| TrackerAttemptError::hard("UDP tracker URL must include a port"))?;
        let endpoint = self.resolve_endpoint(host, port).await?;

        let bind_address = if endpoint.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let socket = UdpSocket::bind(bind_address)
            .await
            .map_err(|error| TrackerAttemptError::retryable(format!(
                "Could not bind UDP tracker socket: {error}"
            )))?;
        socket
            .connect(endpoint)
            .await
            .map_err(|error| TrackerAttemptError::retryable(format!(
                "Could not connect UDP tracker socket: {error}"
            )))?;

        let connect_transaction = random_u32();
        let connect_packet = udp_connect_packet(connect_transaction);
        udp_send(&socket, &connect_packet, self.config.request_timeout).await?;
        let connect_response =
            udp_recv(&socket, self.config.request_timeout).await?;
        let connection =
            UdpConnectResponse::parse(&connect_response, connect_transaction)
                .map_err(|error| TrackerAttemptError::hard(error.to_string()))?;

        let announce_transaction = random_u32();
        let announce_packet = request
            .to_udp_announce_packet(connection.connection_id, announce_transaction)
            .map_err(|error| TrackerAttemptError::hard(error.to_string()))?;
        udp_send(&socket, &announce_packet, self.config.request_timeout).await?;
        let announce_response =
            udp_recv(&socket, self.config.request_timeout).await?;
        let parsed =
            UdpAnnounceResponse::parse(&announce_response, announce_transaction)
                .map_err(|error| TrackerAttemptError::hard(error.to_string()))?;

        Ok(TrackerAnnounceSuccess {
            tracker_url: tracker_url.to_owned(),
            interval_seconds: parsed.interval_seconds,
            complete: Some(parsed.seeders),
            incomplete: Some(parsed.leechers),
            peers: parsed.peers,
            warning: None,
        })
    }

    async fn resolve_http_endpoint(
        &self,
        url: &reqwest::Url,
    ) -> Result<SocketAddr, TrackerAttemptError> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(TrackerAttemptError::hard(
                "Only HTTP(S) tracker redirects are allowed",
            ));
        }
        reject_url_userinfo(url)?;
        let host = url
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| TrackerAttemptError::hard("HTTP tracker URL is missing a host"))?;
        let port = url
            .port_or_known_default()
            .ok_or_else(|| TrackerAttemptError::hard("HTTP tracker URL is missing a port"))?;
        self.resolve_endpoint(host, port).await
    }

    /// Resolve every address and reject the entire hostname if even one answer
    /// is internal. This mirrors NOVA's existing SSRF policy and prevents a
    /// mixed public/private DNS answer from being used as a bypass.
    async fn resolve_endpoint(
        &self,
        host: &str,
        port: u16,
    ) -> Result<SocketAddr, TrackerAttemptError> {
        if host.eq_ignore_ascii_case("localhost") && !self.allow_private_network {
            return Err(TrackerAttemptError::hard(
                "SSRF blocked: tracker targets localhost",
            ));
        }

        if let Ok(ip) = host.parse::<IpAddr>() {
            self.ensure_external_ip(ip)?;
            return Ok(SocketAddr::new(ip, port));
        }

        let resolved = timeout(
            self.config.request_timeout,
            lookup_host((host, port)),
        )
        .await
        .map_err(|_| TrackerAttemptError::retryable(format!(
            "Timed out resolving tracker host '{host}'"
        )))?
        .map_err(|error| TrackerAttemptError::retryable(format!(
            "Could not resolve tracker host '{host}': {error}"
        )))?
        .collect::<Vec<_>>();

        if resolved.is_empty() {
            return Err(TrackerAttemptError::retryable(format!(
                "Tracker host '{host}' resolved to no addresses"
            )));
        }

        for address in &resolved {
            self.ensure_external_ip(address.ip())?;
        }

        Ok(resolved[0])
    }

    fn ensure_external_ip(&self, ip: IpAddr) -> Result<(), TrackerAttemptError> {
        if is_internal_ip(ip) && !self.allow_private_network {
            Err(TrackerAttemptError::hard(format!(
                "SSRF blocked: tracker targets internal IP {ip}"
            )))
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    fn for_tests(config: TrackerTransportConfig) -> Self {
        Self {
            config,
            allow_private_network: true,
        }
    }
}

fn reject_url_userinfo(url: &reqwest::Url) -> Result<(), TrackerAttemptError> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(TrackerAttemptError::hard(
            "Tracker URL userinfo is not allowed",
        ));
    }
    Ok(())
}

fn pinned_http_client(
    host: &str,
    endpoint: SocketAddr,
    request_timeout: Duration,
) -> Result<reqwest::Client, TrackerAttemptError> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(request_timeout)
        .timeout(request_timeout)
        .user_agent(concat!("NOVA-Torrent/", env!("CARGO_PKG_VERSION")));

    if host.parse::<IpAddr>().is_err() {
        builder = builder.resolve(host, endpoint);
    }

    builder.build().map_err(|error| {
        TrackerAttemptError::hard(format!("Could not create tracker HTTP client: {error}"))
    })
}

async fn read_tracker_body_limited(
    mut response: reqwest::Response,
) -> Result<Vec<u8>, TrackerAttemptError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_TRACKER_RESPONSE_BYTES as u64)
    {
        return Err(TrackerAttemptError::hard(format!(
            "Tracker response exceeds {} byte limit",
            MAX_TRACKER_RESPONSE_BYTES
        )));
    }

    let mut body = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(64 * 1024) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| TrackerAttemptError::retryable(format!(
            "Could not read tracker response: {error}"
        )))?
    {
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| TrackerAttemptError::hard("Tracker response length overflow"))?;
        if next_len > MAX_TRACKER_RESPONSE_BYTES {
            return Err(TrackerAttemptError::hard(format!(
                "Tracker response exceeds {} byte limit",
                MAX_TRACKER_RESPONSE_BYTES
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn udp_send(
    socket: &UdpSocket,
    payload: &[u8],
    request_timeout: Duration,
) -> Result<(), TrackerAttemptError> {
    let sent = timeout(request_timeout, socket.send(payload))
        .await
        .map_err(|_| TrackerAttemptError::retryable("UDP tracker send timed out"))?
        .map_err(|error| TrackerAttemptError::retryable(format!(
            "UDP tracker send failed: {error}"
        )))?;
    if sent != payload.len() {
        return Err(TrackerAttemptError::retryable(format!(
            "UDP tracker datagram was truncated: sent {sent} of {} bytes",
            payload.len()
        )));
    }
    Ok(())
}

async fn udp_recv(
    socket: &UdpSocket,
    request_timeout: Duration,
) -> Result<Vec<u8>, TrackerAttemptError> {
    let mut buffer = vec![0u8; MAX_UDP_DATAGRAM_BYTES];
    let received = timeout(request_timeout, socket.recv(&mut buffer))
        .await
        .map_err(|_| TrackerAttemptError::retryable("UDP tracker receive timed out"))?
        .map_err(|error| TrackerAttemptError::retryable(format!(
            "UDP tracker receive failed: {error}"
        )))?;
    buffer.truncate(received);
    Ok(buffer)
}

fn random_u32() -> u32 {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn retry_delay(base: Duration, attempt: usize) -> Duration {
    let shift = attempt.min(3) as u32;
    base.checked_mul(1u32 << shift)
        .unwrap_or(Duration::from_secs(30))
}

fn limit_error_detail(message: &str) -> String {
    let mut output = message
        .chars()
        .take(MAX_TRACKER_ERROR_DETAILS)
        .collect::<String>();
    if message.chars().count() > MAX_TRACKER_ERROR_DETAILS {
        output.push_str("...");
    }
    output
}

#[derive(Debug)]
struct TrackerAttemptError {
    message: String,
    retryable: bool,
}

impl TrackerAttemptError {
    fn hard(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nova_torrent_core::{InfoHash, TrackerEvent};

    fn announce_request() -> TrackerAnnounceRequest {
        TrackerAnnounceRequest {
            info_hash: InfoHash::new([1u8; 20]),
            peer_id: *b"-NV0001-123456789012",
            port: 6881,
            uploaded: 0,
            downloaded: 0,
            left: 1024,
            event: TrackerEvent::Started,
            key: 7,
            num_want: Some(50),
        }
    }

    fn fast_test_config() -> TrackerTransportConfig {
        TrackerTransportConfig {
            request_timeout: Duration::from_secs(2),
            retry_base_delay: Duration::from_millis(1),
            max_attempts_per_tracker: 1,
            max_redirects: 2,
        }
    }

    #[tokio::test]
    async fn http_tracker_transport_parses_real_local_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind HTTP tracker");
        let address = listener.local_addr().expect("local address");

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut request = vec![0u8; 4096];
            let read = stream.read(&mut request).await.expect("read request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("info_hash=%01%01%01"));
            assert!(request.contains("event=started"));

            let mut body = b"d8:intervali60e5:peers6:".to_vec();
            body.extend_from_slice(&[8, 8, 8, 8, 0x1a, 0xe1]);
            body.push(b'e');
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.expect("header");
            stream.write_all(&body).await.expect("body");
        });

        let transport = TrackerTransport::for_tests(fast_test_config());
        let result = transport
            .announce_tracker(
                &format!("http://127.0.0.1:{}/announce", address.port()),
                &announce_request(),
            )
            .await
            .expect("HTTP tracker announce");

        assert_eq!(result.interval_seconds, 60);
        assert_eq!(result.peers.len(), 1);
        assert_eq!(
            result.peers[0].address,
            "8.8.8.8:6881".parse::<SocketAddr>().unwrap()
        );
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn tier_failover_moves_to_next_tracker() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind HTTP tracker");
        let address = listener.local_addr().expect("local address");

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request).await.expect("read");
            let body = b"d8:intervali30e5:peers0:e";
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.expect("header");
            stream.write_all(body).await.expect("body");
        });

        let tiers = vec![
            vec!["http://127.0.0.1:1/unreachable".to_owned()],
            vec![format!("http://127.0.0.1:{}/announce", address.port())],
        ];
        let transport = TrackerTransport::for_tests(fast_test_config());
        let result = transport
            .announce_tiers(&tiers, &announce_request())
            .await
            .expect("fail over to second tier");

        assert_eq!(result.interval_seconds, 30);
        assert!(result.tracker_url.contains(&address.port().to_string()));
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn udp_tracker_transport_performs_connect_and_announce() {
        let socket = UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind UDP tracker");
        let address = socket.local_addr().expect("UDP tracker address");

        let server = tokio::spawn(async move {
            let mut buffer = [0u8; 256];
            let (connect_len, peer) = socket.recv_from(&mut buffer).await.expect("connect packet");
            assert_eq!(connect_len, 16);
            let connect_tx = u32::from_be_bytes(buffer[12..16].try_into().unwrap());

            let mut connect_response = Vec::new();
            connect_response.extend_from_slice(&0u32.to_be_bytes());
            connect_response.extend_from_slice(&connect_tx.to_be_bytes());
            connect_response.extend_from_slice(&0x1122_3344_5566_7788u64.to_be_bytes());
            socket
                .send_to(&connect_response, peer)
                .await
                .expect("connect response");

            let (announce_len, peer) = socket.recv_from(&mut buffer).await.expect("announce packet");
            assert_eq!(announce_len, 98);
            let announce_tx = u32::from_be_bytes(buffer[12..16].try_into().unwrap());

            let mut announce_response = Vec::new();
            announce_response.extend_from_slice(&1u32.to_be_bytes());
            announce_response.extend_from_slice(&announce_tx.to_be_bytes());
            announce_response.extend_from_slice(&45u32.to_be_bytes());
            announce_response.extend_from_slice(&3u32.to_be_bytes());
            announce_response.extend_from_slice(&7u32.to_be_bytes());
            announce_response.extend_from_slice(&[1, 1, 1, 1, 0x1a, 0xe1]);
            socket
                .send_to(&announce_response, peer)
                .await
                .expect("announce response");
        });

        let transport = TrackerTransport::for_tests(fast_test_config());
        let result = transport
            .announce_tracker(
                &format!("udp://127.0.0.1:{}/announce", address.port()),
                &announce_request(),
            )
            .await
            .expect("UDP tracker announce");

        assert_eq!(result.interval_seconds, 45);
        assert_eq!(result.complete, Some(7));
        assert_eq!(result.incomplete, Some(3));
        assert_eq!(result.peers.len(), 1);
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn production_policy_blocks_loopback_tracker() {
        let mut transport = TrackerTransport::new(fast_test_config());
        transport.allow_private_network = false;
        let error = transport
            .announce_tracker("http://127.0.0.1:8080/announce", &announce_request())
            .await
            .expect_err("loopback must be blocked");
        assert!(error.contains("SSRF blocked"));
    }
}
