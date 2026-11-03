//! NIP-FA issuance and local JWT misuse checks; the relay verifies JWT signatures.
use super::{
    config::canonical_relay,
    protocol::{self, expiry, now, Failure},
    FederatedIdentity, Status,
};
use crate::identity::{EventTemplate, IdentityHost};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Weak,
};
use tokio::sync::{Mutex, OnceCell};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::Url;
use zeroize::Zeroizing;

pub(crate) const HEADER: &str = "Nostr-Federated-Identity";
const ACQUISITION_RETRY_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(2);

fn transient_acquisition_failure(code: &str) -> bool {
    matches!(
        code,
        "clock-unavailable" | "identity-unavailable" | "network-unavailable" | "network-timeout"
    )
}

fn admission_retired(mutation: bool) -> &'static str {
    if mutation {
        "Write result could not be confirmed; it may have completed. Inspect the existing operation before retrying."
    } else {
        "Federated authorization changed"
    }
}

/// How long before expiry an assertion is refreshed and its socket renewed:
/// 15 seconds, but at most half its lifetime, so a short-lived assertion
/// still leaves a socket time to admit.
fn refresh_margin(lifetime: std::time::Duration) -> std::time::Duration {
    (lifetime / 2).min(std::time::Duration::from_secs(15))
}

pub(super) fn monotonic_expiry(
    expires_at: u64,
    wall_now: std::time::SystemTime,
    monotonic_now: Instant,
) -> Option<(Instant, std::time::Duration)> {
    let wall_expiry =
        std::time::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(expires_at))?;
    let remaining = wall_expiry.duration_since(wall_now).unwrap_or_default();
    Some((monotonic_now.checked_add(remaining)?, remaining))
}

#[derive(Clone)]
pub(crate) struct Assertion {
    pub(crate) header: Zeroizing<String>,
    pub(crate) expires_at: Instant,
    pub(crate) revision: String,
    pub(crate) viewer: String,
    pub(crate) relay: String,
    refresh_at: Instant,
    /// The server that issued it; every later check asks that server.
    server: Weak<super::Inner>,
}
#[derive(Clone)]
pub(crate) struct Authorization {
    pub(crate) assertion: Option<Assertion>,
    /// Set when the relay advertises NIP-FI but this app could not attach a
    /// token: the request goes without one and the relay decides (a shadow
    /// relay admits it). A missing-evidence refusal then reads as this reason.
    pub(crate) unsigned: Option<&'static str>,
    relay: String,
    discovery: Arc<Discovery>,
    socket: bool,
    /// The server the relay's host routed to, whose discovery this is.
    server: Weak<super::Inner>,
}
impl Authorization {
    pub(crate) fn header(&self) -> Option<&str> {
        self.assertion
            .as_ref()
            .map(|assertion| assertion.header.as_str())
    }
    /// The sign-in reason for a relay's missing-evidence refusal (NIP-FI's
    /// `401` / `auth-required: authentication required`), only when this
    /// request advertised NIP-FI and went without a token.
    pub(crate) fn refusal(&self, status: u16) -> Option<&'static str> {
        self.unsigned.filter(|_| status == 401)
    }

    #[cfg(test)]
    pub(crate) fn remaining(&self) -> std::time::Duration {
        self.assertion
            .as_ref()
            .map_or(std::time::Duration::MAX, Assertion::remaining)
    }
}
#[cfg(test)]
pub(crate) async fn test_live_authorization(
    identity: &IdentityHost,
    relay: &str,
    lifetime: std::time::Duration,
) -> (FederatedIdentity, Authorization) {
    let host = super::tests::host(Arc::new(super::tests::Memory::default()));
    {
        let mut state = host.state();
        state.session = Some(super::tests::record());
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    let discovery = host
        .discovery_generation(
            relay,
            Some(("test-live-authorization".into(), CancellationToken::new())),
        )
        .unwrap();
    discovery.result.set(Ok(true)).unwrap();
    let authorization = Authorization {
        assertion: Some(Assertion {
            header: Zeroizing::new("Bearer fixture-assertion".into()),
            expires_at: Instant::now() + lifetime,
            revision: host.snapshot().revision,
            viewer: identity.viewer().await.unwrap(),
            relay: relay.into(),
            refresh_at: Instant::now(),
            server: Arc::downgrade(&host.0),
        }),
        unsigned: None,
        relay: relay.into(),
        discovery,
        socket: false,
        server: Arc::downgrade(&host.0),
    };
    (host, authorization)
}
impl Assertion {
    fn server(&self) -> Option<FederatedIdentity> {
        self.server.upgrade().map(FederatedIdentity)
    }
    /// Whether its session is still the issuing server's current one.
    fn current(&self) -> bool {
        self.server()
            .is_some_and(|server| server.current(&self.revision))
    }
    pub(crate) fn cancellation(&self) -> Result<CancellationToken, String> {
        self.server()
            .ok_or("Federated session changed")?
            .cancellation_for(&self.revision)
    }
    pub(crate) fn remaining(&self) -> std::time::Duration {
        self.expires_at.saturating_duration_since(Instant::now())
    }
    /// Time until a socket should renew: past this point a new connection
    /// mints a fresh assertion rather than reusing this one.
    pub(crate) fn renew_in(&self) -> std::time::Duration {
        self.refresh_at.saturating_duration_since(Instant::now())
    }
}
#[derive(Default)]
pub(super) struct Acquisition {
    completed: AtomicU64,
    result: Mutex<Option<Result<Assertion, Failure>>>,
    retry_at: Mutex<Option<Instant>>,
}
pub(super) type AssertionCache = std::collections::HashMap<String, Arc<Acquisition>>;

pub(super) struct Discovery {
    result: OnceCell<Result<bool, String>>,
    stop: CancellationToken,
    owner: Option<String>,
}
pub(super) type DiscoveryCache = std::collections::HashMap<String, Arc<Discovery>>;

/// No credential goes on discovery. The exact relay supplies only the requirement,
/// never the configured adapter destination.
pub(crate) async fn discovery(relay: &str) -> Result<bool, String> {
    let relay = canonical_relay(relay)?;
    let url = format!("https://{}/info", &relay[6..]);
    let client = protocol::client().map_err(str::to_owned)?;
    let document: serde_json::Value =
        protocol::json(|| client.get(&url).header("Accept", "application/nostr+json"))
            .await
            .map_err(|_| "Federated community discovery failed".to_owned())?;
    evaluate_discovery(&document).map_err(str::to_owned)
}
fn evaluate_discovery(document: &serde_json::Value) -> Result<bool, &'static str> {
    if !document.is_object() {
        return Err("Invalid federated community discovery");
    }
    let requires = match document.get("limitation") {
        Some(value) if !value.is_object() => return Err("Invalid federated community discovery"),
        value => match value.and_then(|v| v.get("federated_identity")) {
            None | Some(serde_json::Value::Bool(false)) => false,
            Some(serde_json::Value::Bool(true)) => true,
            _ => return Err("Invalid federated community discovery"),
        },
    };
    if !requires {
        return Ok(false);
    }
    let descriptor = document
        .get("federated_identity")
        .ok_or("Incomplete federated community discovery")?;
    if descriptor.get("core").and_then(|v| v.as_str()) != Some("client-attached")
        || descriptor
            .pointer("/assertion_freshness/class")
            .and_then(|v| v.as_str())
            != Some("offline-jwt")
        || !matches!(
            descriptor.pointer("/assertion_freshness/maximum_residual_upstream_revocation_seconds"),
            None | Some(serde_json::Value::Null)
        )
    {
        return Err("Unsupported federated community discovery");
    }
    Ok(true)
}

impl FederatedIdentity {
    fn discovery_generation(
        &self,
        relay: &str,
        connection: Option<(String, CancellationToken)>,
    ) -> Result<Arc<Discovery>, String> {
        let mut cache = self
            .0
            .discoveries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if connection.is_none() {
            if let Some(current) = cache.get(relay).filter(|entry| !entry.stop.is_cancelled()) {
                return Ok(current.clone());
            }
        }
        if !cache.contains_key(relay) && cache.len() >= 128 {
            return Err("Too many discovered communities".into());
        }
        let (owner, stop) = match connection {
            Some((id, stop)) => (Some(id), stop),
            None => (None, CancellationToken::new()),
        };
        let generation = Arc::new(Discovery {
            result: OnceCell::new(),
            stop,
            owner,
        });
        cache.insert(relay.into(), generation.clone());
        Ok(generation)
    }
    fn current_discovery(&self, relay: &str, generation: &Arc<Discovery>) -> bool {
        self.0
            .discoveries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(relay)
            .is_some_and(|current| Arc::ptr_eq(current, generation))
    }
    pub(crate) fn close_discovery(&self, id: &str) {
        for peer in &self.0.peers {
            peer.close_discovery(id);
        }
        for generation in self
            .0
            .discoveries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
        {
            if generation.owner.as_deref() == Some(id) {
                generation.stop.cancel();
            }
        }
    }
    /// Settles a relay's discovery without the network, as the relay's `/info` would.
    #[cfg(test)]
    pub(crate) fn discovered(&self, relay: &str, requires: bool) {
        let generation = self.discovery_generation(relay, None).unwrap();
        generation.result.set(Ok(requires)).unwrap();
    }
    pub(crate) fn clear_discoveries(&self) {
        for peer in &self.0.peers {
            peer.clear_discoveries();
        }
        for (_, generation) in self
            .0
            .discoveries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
        {
            generation.stop.cancel();
        }
    }
    pub(crate) async fn assertion_for_socket(
        &self,
        identity: &IdentityHost,
        url: &Url,
        id: String,
        stop: CancellationToken,
    ) -> Result<Authorization, String> {
        self.acquire_for_relay(identity, url, Some((id, stop)))
            .await
    }
    pub(crate) async fn assertion_for_relay(
        &self,
        identity: &IdentityHost,
        url: &Url,
    ) -> Result<Authorization, String> {
        self.acquire_for_relay(identity, url, None).await
    }
    /// Routes the community to its sign-in server by host, never by what the relay says.
    async fn acquire_for_relay(
        &self,
        identity: &IdentityHost,
        url: &Url,
        connection: Option<(String, CancellationToken)>,
    ) -> Result<Authorization, String> {
        let relay = canonical_relay(&url.origin().ascii_serialization())?;
        self.server_for(&relay)?
            .acquire(identity, relay, connection)
            .await
    }
    async fn acquire(
        &self,
        identity: &IdentityHost,
        relay: String,
        connection: Option<(String, CancellationToken)>,
    ) -> Result<Authorization, String> {
        let socket = connection.is_some();
        let mut generation = self.discovery_generation(&relay, connection)?;
        let mut reacquired = false;
        let requires = loop {
            let result = generation
                .result
                .get_or_init(|| discovery(&relay))
                .await
                .clone();
            if generation.stop.is_cancelled()
                || (!socket && !self.current_discovery(&relay, &generation))
            {
                if socket || reacquired {
                    return Err("Federated community discovery changed".into());
                }
                // No HTTP operation has dispatched. Adopt the replacement once;
                // a dispatched read/write is never replayed by this acquisition.
                generation = self.discovery_generation(&relay, None)?;
                reacquired = true;
                continue;
            }
            break result;
        };
        let mut authorization = Authorization {
            assertion: None,
            unsigned: None,
            relay: relay.clone(),
            discovery: generation.clone(),
            socket,
            server: Arc::downgrade(&self.0),
        };
        let requires = match requires {
            Ok(requires) => requires,
            Err(error) => {
                let mut cache = self
                    .0
                    .discoveries
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if cache
                    .get(&relay)
                    .is_some_and(|current| Arc::ptr_eq(current, &generation))
                {
                    cache.remove(&relay);
                }
                return Err(error);
            }
        };
        if !requires {
            return Ok(authorization);
        }
        // Advertising NIP-FI is support, not a requirement (NIP-FI Discovery):
        // without a token the request goes plainly and the relay decides.
        const UNCONFIGURED: &str = "Federated identity is not configured for this community";
        const SIGNED_OUT: &str = "Federated sign-in is required";
        let Some(config) = self.0.config.as_ref() else {
            authorization.unsigned = Some(UNCONFIGURED);
            return Ok(authorization);
        };
        if !config.matches_relay(&relay)? {
            authorization.unsigned = Some(UNCONFIGURED);
            return Ok(authorization);
        }
        self.restore().await;
        let viewer = identity.viewer().await?;
        let signed_in = {
            let state = self.state();
            state
                .session
                .clone()
                .filter(|_| !state.closed && state.snapshot.status == Status::SignedIn)
                .map(|session| {
                    (
                        state.snapshot.revision.clone(),
                        session,
                        state.cancellation.clone(),
                    )
                })
        };
        let Some((revision, session, cancel)) = signed_in else {
            authorization.unsigned = Some(SIGNED_OUT);
            return Ok(authorization);
        };
        let key = format!("{revision}:{viewer}:{relay}");
        let entry = {
            let mut cache = self
                .0
                .assertions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !cache.contains_key(&key) && cache.len() >= 128 {
                return Err("Too many protected communities".into());
            }
            cache.entry(key).or_default().clone()
        };
        let observed = entry.completed.load(Ordering::Acquire);
        let mut cached = entry.result.lock().await;
        if !self.current(&revision) {
            return Err("Federated session changed".into());
        }
        if entry.completed.load(Ordering::Acquire) != observed {
            let result = cached.as_ref().ok_or("Federated acquisition unavailable")?;
            let assertion = result.as_ref().map_err(|failure| failure.code.to_owned())?;
            authorization.assertion = Some(assertion.clone());
            self.admit_authorization(identity, &authorization).await?;
            return Ok(authorization);
        }
        if let Some(Err(failure)) = cached
            .as_ref()
            .filter(|result| matches!(result, Err(f) if refused(f)))
        {
            return Err(failure.code.into());
        }
        if let Some(assertion) = cached
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .filter(|assertion| Instant::now() < assertion.refresh_at)
        {
            authorization.assertion = Some(assertion.clone());
            self.admit_authorization(identity, &authorization).await?;
            return Ok(authorization);
        }
        if let Some(Err(failure)) = cached.as_ref() {
            if !transient_acquisition_failure(failure.code) {
                return Err(failure.code.into());
            }
            let mut retry_at = entry.retry_at.lock().await;
            if retry_at.is_some_and(|deadline| Instant::now() < deadline) {
                return Err(failure.code.into());
            }
            *retry_at = None;
        }
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err("Federated session changed".into()),
            result = self.issue(identity, &relay, &viewer, &revision, &session.record.session_token, expiry(&session.record.expires_at).map_err(str::to_owned)? as u64) => result,
        };
        *cached = Some(result.clone());
        entry.completed.fetch_add(1, Ordering::Release);
        if result
            .as_ref()
            .is_err_and(|failure| transient_acquisition_failure(failure.code))
        {
            *entry.retry_at.lock().await = Some(Instant::now() + ACQUISITION_RETRY_COOLDOWN);
        }
        match result {
            Ok(assertion) => {
                authorization.assertion = Some(assertion);
                self.admit_authorization(identity, &authorization).await?;
                Ok(authorization)
            }
            Err(failure) => {
                let retired = {
                    let mut state = self.state();
                    if !state.closed && state.snapshot.revision == revision {
                        if failure.session_denied {
                            self.signal(super::SessionChange::Expired);
                            self.retire_state(
                                &mut state,
                                Status::ReauthenticationRequired,
                                Some(failure.code),
                            )
                            .map(|session| (session, state.snapshot.revision.clone()))
                        } else {
                            state.snapshot.failure = Some(failure.code);
                            self.publish(&state);
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some((session, revision)) = retired {
                    if let Err(error) = self.remove(session).await {
                        self.change_current(&revision, Status::Unavailable, Some(error.code));
                    }
                }
                Err(failure.code.into())
            }
        }
    }
    pub(crate) async fn admit_assertion(
        &self,
        identity: &IdentityHost,
        assertion: &Assertion,
    ) -> Result<(), String> {
        let viewer = identity.viewer().await?;
        if viewer != assertion.viewer || assertion.remaining().is_zero() || !assertion.current() {
            return Err("Federated authorization changed".into());
        }
        Ok(())
    }
    /// An admitted import can outlive discovery and assertion expiry, but not its FI session.
    pub(crate) fn authorization_session_current(&self, authorization: &Authorization) -> bool {
        authorization
            .assertion
            .as_ref()
            .is_none_or(Assertion::current)
    }
    fn discovery_current(&self, authorization: &Authorization) -> bool {
        !authorization.discovery.stop.is_cancelled()
            && (authorization.socket
                || authorization.server.upgrade().is_some_and(|server| {
                    FederatedIdentity(server)
                        .current_discovery(&authorization.relay, &authorization.discovery)
                }))
    }
    pub(crate) fn authorization_cancellation(
        &self,
        authorization: &Authorization,
    ) -> Result<CancellationToken, String> {
        match &authorization.assertion {
            Some(assertion) => assertion.cancellation(),
            None => Ok(CancellationToken::new()),
        }
    }
    pub(crate) async fn admit_authorization(
        &self,
        identity: &IdentityHost,
        authorization: &Authorization,
    ) -> Result<(), String> {
        if !self.discovery_current(authorization) {
            return Err("Federated community discovery changed".into());
        }
        if let Some(assertion) = &authorization.assertion {
            self.admit_assertion(identity, assertion).await?;
        }
        // Viewer lookup can wait behind native signing; validate after that await.
        if !self.discovery_current(authorization) {
            return Err("Federated community discovery changed".into());
        }
        Ok(())
    }
    pub(crate) async fn during_authorization<T>(
        &self,
        identity: &IdentityHost,
        authorization: &Authorization,
        operation: impl std::future::Future<Output = T>,
    ) -> Result<T, String> {
        self.admit_authorization(identity, authorization).await?;
        let guarded = async {
            if let Some(assertion) = &authorization.assertion {
                self.during(identity, assertion, operation).await
            } else {
                Ok(operation.await)
            }
        };
        let result = tokio::select! {
            _ = authorization.discovery.stop.cancelled() => return Err("Federated community discovery changed".into()),
            result = guarded => result?,
        };
        self.admit_authorization(identity, authorization).await?;
        Ok(result)
    }
    pub(crate) async fn during_admitted_operation<T>(
        &self,
        identity: &IdentityHost,
        authorization: &Authorization,
        mutation: bool,
        operation: impl std::future::Future<Output = T>,
    ) -> Result<T, String> {
        self.admit_authorization(identity, authorization).await?;
        let cancellation = self.authorization_cancellation(authorization)?;
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(admission_retired(mutation).into()),
            result = operation => result,
        };
        self.admit_response(identity, authorization, mutation)
            .await?;
        Ok(result)
    }
    pub(crate) async fn admit_response(
        &self,
        identity: &IdentityHost,
        authorization: &Authorization,
        mutation: bool,
    ) -> Result<(), String> {
        let Some(assertion) = &authorization.assertion else {
            return Ok(());
        };
        let viewer = identity.viewer().await.ok();
        if assertion.current() && viewer.as_deref() == Some(assertion.viewer.as_str()) {
            return Ok(());
        }
        Err(admission_retired(mutation).into())
    }
    pub(crate) async fn reject_assertion(&self, assertion: &Assertion) {
        let key = format!(
            "{}:{}:{}",
            assertion.revision, assertion.viewer, assertion.relay
        );
        let Some(server) = assertion.server() else {
            return;
        };
        let entry = server
            .0
            .assertions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
            .cloned();
        if let Some(entry) = entry {
            let mut cached = entry.result.lock().await;
            if cached
                .as_ref()
                .and_then(|result| result.as_ref().ok())
                .is_some_and(|current| current.header == assertion.header)
            {
                *cached = None;
            }
        }
    }
    pub(crate) async fn during<T>(
        &self,
        identity: &IdentityHost,
        assertion: &Assertion,
        operation: impl std::future::Future<Output = T>,
    ) -> Result<T, String> {
        self.admit_assertion(identity, assertion).await?;
        let cancel = assertion.cancellation()?;
        let remaining = assertion.remaining();
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err("Federated authorization changed".into()),
            _ = tokio::time::sleep(remaining) => return Err("Federated authorization expired".into()),
            result = operation => result,
        };
        self.admit_assertion(identity, assertion).await?;
        Ok(result)
    }
    async fn issue(
        &self,
        identity: &IdentityHost,
        relay: &str,
        viewer: &str,
        revision: &str,
        token: &str,
        session_expiry: u64,
    ) -> Result<Assertion, Failure> {
        if viewer.len() != 64
            || !viewer
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid-viewer".into());
        }
        // Field order and exact bytes are the NIP-FA assertion request contract.
        #[derive(serde::Serialize)]
        struct Body<'a> {
            nostr_pubkey: &'a str,
            relay_url: &'a str,
        }
        let body = serde_json::to_string(&Body {
            nostr_pubkey: viewer,
            relay_url: relay,
        })
        .map_err(|_| "invalid-request")?;
        if body.len() > 4096 {
            return Err("invalid-request".into());
        }
        let endpoint = self
            .0
            .config
            .as_ref()
            .ok_or("unconfigured")?
            .endpoint("/v1/identity/assertions");
        let client = protocol::client()?;
        let timestamp = now()? as u64;
        let proof = identity
            .sign(EventTemplate {
                kind: 27235,
                created_at: timestamp,
                content: String::new(),
                tags: vec![
                    vec!["u".into(), endpoint.to_string()],
                    vec!["method".into(), "POST".into()],
                    vec![
                        "payload".into(),
                        format!("{:x}", Sha256::digest(body.as_bytes())),
                    ],
                ],
            })
            .await
            .map_err(|_| "identity-unavailable")?;
        if proof.get("pubkey").and_then(|v| v.as_str()) != Some(viewer) {
            return Err("invalid-viewer".into());
        }
        let proof = format!(
            "Nostr {}",
            STANDARD.encode(serde_json::to_vec(&proof).map_err(|_| "invalid-proof")?)
        );
        #[derive(Deserialize)]
        struct Issued {
            assertion: String,
            nostr_pubkey: String,
            expires_at: u64,
        }
        let issued: Issued = protocol::json(|| {
            client
                .post(endpoint.clone())
                .bearer_auth(token)
                .header("Nostr-Authorization", &proof)
                .header("Content-Type", "application/json")
                .body(body.clone())
        })
        .await?;
        let assertion = Zeroizing::new(issued.assertion);
        // Use one precise wall-clock sample for NumericDate validation and the
        // conversion to a monotonic deadline. Sampling the monotonic clock first
        // keeps the derived deadline at or before the issuer's whole-second exp.
        let monotonic_now = Instant::now();
        let wall_now = std::time::SystemTime::now();
        let now = wall_now
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "clock-unavailable")?
            .as_secs();
        validate_jwt(
            &assertion,
            &issued.nostr_pubkey,
            issued.expires_at,
            viewer,
            relay,
            session_expiry,
            now,
        )?;
        let (expires_at, lifetime) = monotonic_expiry(issued.expires_at, wall_now, monotonic_now)
            .ok_or("invalid-assertion")?;
        Ok(Assertion {
            header: Zeroizing::new(format!("Bearer {}", assertion.as_str())),
            expires_at,
            revision: revision.into(),
            viewer: viewer.into(),
            relay: relay.into(),
            refresh_at: expires_at - refresh_margin(lifetime),
            server: Arc::downgrade(&self.0),
        })
    }
}

/// NIP-FA: the issuer refused, or its success response was rejected. These are
/// not retried automatically; the refusal stands for its session revision,
/// viewer and relay until one of them changes or the app restarts. A 401
/// `invalid_grant` decodes as `grant-refused`; on this route it is an
/// undefined 401 code, so it is terminal too (NIP-FA).
fn refused(failure: &Failure) -> bool {
    matches!(
        failure.code,
        "adapter-refused"
            | "authorization-denied"
            | "binding-mismatch"
            | "grant-refused"
            | "invalid-proof"
            | "invalid-response"
            | "invalid-assertion"
            | "response-too-large"
    )
}
fn validate_jwt(
    token: &str,
    returned_key: &str,
    returned_expiry: u64,
    viewer: &str,
    relay: &str,
    session_expiry: u64,
    now: u64,
) -> Result<u64, Failure> {
    if token.len() > 8192 || token.chars().any(char::is_whitespace) || returned_key != viewer {
        return Err("invalid-assertion".into());
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("invalid-assertion".into());
    }
    let decode = |part: &str| -> Result<serde_json::Value, Failure> {
        let bytes = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(part)
                .map_err(|_| "invalid-assertion")?,
        );
        serde_json::from_slice(&bytes).map_err(|_| "invalid-assertion".into())
    };
    let header = decode(parts[0])?;
    let claims = decode(parts[1])?;
    let minted = claims
        .get("iat")
        .and_then(|v| v.as_u64())
        .ok_or("invalid-assertion")?;
    let expiry = claims
        .get("exp")
        .and_then(|v| v.as_u64())
        .ok_or("invalid-assertion")?;
    if header.get("typ").and_then(|v| v.as_str()) != Some("nip-fi+jwt")
        || claims.get("aud").and_then(|v| v.as_str())
            != Some(format!("https://{}", &relay[6..]).as_str())
        || claims.get("nostr_pubkey").and_then(|v| v.as_str()) != Some(viewer)
        || expiry != returned_expiry
        || expiry <= now
        || expiry > session_expiry
        || minted > now.saturating_add(5)
        || minted > expiry
    {
        return Err("invalid-assertion".into());
    }
    Ok(minted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_margin_leaves_short_lifetimes_half_their_time() {
        let secs = std::time::Duration::from_secs;
        assert_eq!(refresh_margin(secs(300)), secs(15));
        assert_eq!(refresh_margin(secs(30)), secs(15));
        assert_eq!(refresh_margin(secs(10)), secs(5));
        assert!(refresh_margin(std::time::Duration::ZERO).is_zero());
    }

    #[test]
    fn monotonic_expiry_preserves_subsecond_wall_clock_precision() {
        let wall_now = std::time::UNIX_EPOCH + std::time::Duration::from_millis(10_250);
        let monotonic_now = Instant::now();
        let (deadline, remaining) = monotonic_expiry(11, wall_now, monotonic_now).unwrap();
        assert_eq!(remaining, std::time::Duration::from_millis(750));
        assert_eq!(
            deadline,
            monotonic_now + std::time::Duration::from_millis(750)
        );

        let (_, expired) = monotonic_expiry(10, wall_now, monotonic_now).unwrap();
        assert!(expired.is_zero());

        assert!(monotonic_expiry(u64::MAX, std::time::UNIX_EPOCH, monotonic_now).is_none());
    }

    fn signed_in(host: &FederatedIdentity) {
        let mut state = host.state();
        state.session = Some(super::super::tests::record());
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }

    async fn protected(
        host: &FederatedIdentity,
        identity: &IdentityHost,
        relay: &str,
        expires_at: Instant,
    ) -> Authorization {
        let discovery = host.discovery_generation(relay, None).unwrap();
        discovery.result.set(Ok(true)).unwrap();
        Authorization {
            unsigned: None,
            assertion: Some(Assertion {
                header: Zeroizing::new("Bearer fixture".into()),
                expires_at,
                revision: host.snapshot().revision,
                viewer: identity.viewer().await.unwrap(),
                relay: relay.into(),
                refresh_at: Instant::now(),
                server: Arc::downgrade(&host.0),
            }),
            relay: relay.into(),
            discovery,
            socket: false,
            server: Arc::downgrade(&host.0),
        }
    }

    #[tokio::test]
    async fn a_true_decision_cannot_attach_after_replacement_during_native_viewer_lookup() {
        use super::super::tests::{host, Memory};
        use futures_util::FutureExt;
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let relay = "wss://relay.example";
        let old = host
            .discovery_generation(relay, Some(("old".into(), CancellationToken::new())))
            .unwrap();
        let authorization = Authorization {
            unsigned: None,
            assertion: Some(Assertion {
                header: Zeroizing::new("Bearer fixture".into()),
                expires_at: Instant::now() + std::time::Duration::from_secs(60),
                revision: host.snapshot().revision,
                viewer: identity.viewer().await.unwrap(),
                relay: relay.into(),
                refresh_at: Instant::now(),
                server: Arc::downgrade(&host.0),
            }),
            relay: relay.into(),
            discovery: old,
            socket: false,
            server: Arc::downgrade(&host.0),
        };
        let (start, started) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let signing = identity.clone();
        let occupied = tokio::spawn(async move {
            signing
                .with_key(move |_, _| {
                    let _ = start.send(());
                    let _ = held.recv(); // Dropping release also frees the queue on panic.
                    Ok(())
                })
                .await
        });
        started.await.unwrap();
        let admission = host.admit_authorization(&identity, &authorization);
        tokio::pin!(admission);
        assert!(admission.as_mut().now_or_never().is_none());
        let next = host
            .discovery_generation(relay, Some(("next".into(), CancellationToken::new())))
            .unwrap();
        next.result.set(Ok(false)).unwrap();
        release.send(()).unwrap();
        assert_eq!(
            admission.await.err().as_deref(),
            Some("Federated community discovery changed")
        );
        occupied.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn ordinary_admission_is_fenced_before_dispatch_but_not_after_release() {
        use super::super::tests::{host, Memory};
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let relay = "wss://127.0.0.1:9";
        let url = Url::parse(relay).unwrap();
        let old = host
            .discovery_generation(relay, Some(("old".into(), CancellationToken::new())))
            .unwrap();
        old.result.set(Ok(false)).unwrap();
        let authorization = host.assertion_for_relay(&identity, &url).await.unwrap();
        assert!(authorization.header().is_none());
        host.admit_authorization(&identity, &authorization)
            .await
            .unwrap();
        let next = host
            .discovery_generation(relay, Some(("next".into(), CancellationToken::new())))
            .unwrap();
        next.result.set(Ok(true)).unwrap();
        assert_eq!(
            host.admit_authorization(&identity, &authorization)
                .await
                .err()
                .as_deref(),
            Some("Federated community discovery changed")
        );
        host.admit_response(&identity, &authorization, false)
            .await
            .unwrap();
        host.admit_response(&identity, &authorization, true)
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn ordinary_operations_reuse_the_connection_discovery_without_a_network_round_trip() {
        use super::super::tests::{host, Memory};
        use futures_util::FutureExt;
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let url = Url::parse("https://127.0.0.1:9").unwrap();
        let generation = host
            .discovery_generation(
                "wss://127.0.0.1:9",
                Some(("fixture".into(), CancellationToken::new())),
            )
            .unwrap();
        generation.result.set(Ok(false)).unwrap();
        for _ in 0..3 {
            assert!(
                matches!(
                    host.assertion_for_relay(&identity, &url).now_or_never(),
                    Some(Ok(Authorization {
                        unsigned: None,
                        assertion: None,
                        ..
                    }))
                ),
                "a valid ordinary decision must not start another discovery request"
            );
        }
    }
    #[tokio::test]
    async fn reconnect_fences_a_late_ordinary_decision_and_preserves_the_new_requirement() {
        use super::super::tests::{host, Memory};
        use futures_util::FutureExt;
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let relay = "wss://127.0.0.1:9";
        let url = Url::parse(relay).unwrap();
        let old = host
            .discovery_generation(relay, Some(("fixture".into(), CancellationToken::new())))
            .unwrap();
        let (start, started) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        let captured = old.clone();
        let discovering = tokio::spawn(async move {
            captured
                .result
                .get_or_init(|| async {
                    start.send(()).unwrap();
                    held.await.unwrap();
                    Ok(false)
                })
                .await
                .clone()
        });
        started.await.unwrap();
        let operation = host.assertion_for_relay(&identity, &url);
        tokio::pin!(operation);
        assert!(operation.as_mut().now_or_never().is_none());
        let next = host
            .discovery_generation(relay, Some(("fixture".into(), CancellationToken::new())))
            .unwrap();
        next.result.set(Ok(true)).unwrap();
        release.send(()).unwrap();
        let recovered = operation.await.unwrap();
        assert_eq!(
            recovered.refusal(401),
            Some("Federated identity is not configured for this community")
        );
        let dispatched = std::sync::atomic::AtomicUsize::new(0);
        host.during_admitted_operation(&identity, &recovered, false, async {
            dispatched.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .unwrap();
        assert_eq!(dispatched.load(Ordering::SeqCst), 1);
        assert_eq!(discovering.await.unwrap(), Ok(false));
        // The new requirement holds: without configuration the request goes
        // unsigned, and a missing-evidence refusal names the reason.
        let unsigned = host.assertion_for_relay(&identity, &url).await.unwrap();
        assert!(unsigned.assertion.is_none());
        assert_eq!(
            unsigned.refusal(401),
            Some("Federated identity is not configured for this community")
        );
        assert_eq!(unsigned.refusal(403), None);
        assert!(host.current_discovery(relay, &next));
    }
    #[test]
    fn valid_absent_or_false_flags_do_not_require_credentials() {
        for doc in [
            serde_json::json!({}),
            serde_json::json!({"limitation":{"federated_identity":false},"federated_identity":{}}),
        ] {
            assert!(!evaluate_discovery(&doc).unwrap());
        }
        let supported = serde_json::json!({"limitation":{"federated_identity":true},"federated_identity":{"core":"client-attached","assertion_freshness":{"class":"offline-jwt"}}});
        assert!(evaluate_discovery(&supported).unwrap());
        for (pointer, value) in [
            (
                "/federated_identity/core",
                serde_json::json!("server-fetched"),
            ),
            (
                "/federated_identity/assertion_freshness/class",
                serde_json::json!("online"),
            ),
        ] {
            let mut unsupported = supported.clone();
            *unsupported.pointer_mut(pointer).unwrap() = value;
            assert!(evaluate_discovery(&unsupported).is_err());
        }
        let mut bounded = supported.clone();
        bounded["federated_identity"]["assertion_freshness"]
            ["maximum_residual_upstream_revocation_seconds"] = serde_json::json!(60);
        assert!(evaluate_discovery(&bounded).is_err());
        for doc in [
            serde_json::json!(null),
            serde_json::json!({"limitation":{"federated_identity":"true"}}),
            serde_json::json!({"limitation":{"federated_identity":true}}),
        ] {
            assert!(evaluate_discovery(&doc).is_err());
        }
    }
    #[tokio::test]
    async fn a_community_is_authorized_by_the_server_its_host_routes_to() {
        use super::super::{config::Config, tests::Memory};
        let peer = FederatedIdentity::with_store(
            Some(Config::parse(r#"{"version":1,"id":"peer","identityOrigin":"https://peer-identity.example","adapterBase":"https://peer-identity.example","apiBasePath":"/api/","communityHosts":["peer.example"]}"#).unwrap()),
            String::new(),
            String::new(),
            Arc::new(Memory::default()),
        );
        let first = FederatedIdentity::build(
            Some(Config::parse(r#"{"version":1,"id":"test","identityOrigin":"https://identity.example","adapterBase":"https://identity.example","apiBasePath":"/api/","communityHosts":["relay.example"]}"#).unwrap()),
            String::new(),
            String::new(),
            Arc::new(Memory::default()),
            vec![peer.clone()],
        );
        let identity = IdentityHost::fixture();
        peer.discovered("wss://peer.example", true);
        let url = Url::parse("https://peer.example/events").unwrap();
        // The peer, not the first server, decides: it is signed out.
        let unsigned = first.assertion_for_relay(&identity, &url).await.unwrap();
        assert_eq!(unsigned.refusal(401), Some("Federated sign-in is required"));
        first
            .admit_authorization(&identity, &unsigned)
            .await
            .unwrap();
        // Clearing the app's discoveries clears every server's.
        first.clear_discoveries();
        assert!(first
            .admit_authorization(&identity, &unsigned)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn an_independent_socket_generation_does_not_retire_an_existing_socket() {
        use super::super::tests::{host, Memory};
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let relay = "wss://relay.example";
        let stop = CancellationToken::new();
        let old = host
            .discovery_generation(relay, Some(("old".into(), stop.clone())))
            .unwrap();
        let assertion = Assertion {
            header: Zeroizing::new("Bearer fixture".into()),
            expires_at: Instant::now() + std::time::Duration::from_secs(60),
            revision: host.snapshot().revision,
            viewer: identity.viewer().await.unwrap(),
            relay: relay.into(),
            refresh_at: Instant::now(),
            server: Arc::downgrade(&host.0),
        };
        let authorization = Authorization {
            unsigned: None,
            assertion: Some(assertion),
            relay: relay.into(),
            discovery: old,
            socket: true,
            server: Arc::downgrade(&host.0),
        };
        host.admit_authorization(&identity, &authorization)
            .await
            .unwrap();
        let next = host
            .discovery_generation(relay, Some(("next".into(), CancellationToken::new())))
            .unwrap();
        host.close_discovery("old");
        host.admit_authorization(&identity, &authorization)
            .await
            .unwrap();
        assert!(!next.stop.is_cancelled());
        stop.cancel(); // The old socket registry retires only its captured lifetime.
        assert!(host
            .admit_authorization(&identity, &authorization)
            .await
            .is_err());
        assert!(!next.stop.is_cancelled());
        host.close_discovery("next");
        assert!(next.stop.is_cancelled());
    }
    fn jwt(viewer: &str, relay: &str, minted: u64, expires: u64) -> String {
        format!("{}.{}.eA", URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt","alg":"ES256"}"#), URL_SAFE_NO_PAD.encode(serde_json::json!({"nostr_pubkey":viewer,"aud":format!("https://{}",&relay[6..]),"iat":minted,"exp":expires}).to_string()))
    }
    #[test]
    fn assertion_misuse_checks_require_key_exact_audience_and_bounded_session_lifetime() {
        let viewer = "ab".repeat(32);
        let relay = "wss://relay.example:8443";
        let valid = jwt(&viewer, relay, 100, 200);
        assert_eq!(
            validate_jwt(&valid, &viewer, 200, &viewer, relay, 250, 101).unwrap(),
            100
        );
        for lifetime in [300, 86400, 86401, 604800] {
            let expiry = 100 + lifetime;
            let token = jwt(&viewer, relay, 100, expiry);
            assert_eq!(
                validate_jwt(&token, &viewer, expiry, &viewer, relay, expiry, 101).unwrap(),
                100
            );
        }
        for (token, returned, expires, requested, community, session, time) in [
            (
                valid.clone(),
                "cd".repeat(32),
                200,
                viewer.clone(),
                relay,
                250,
                101,
            ),
            (
                valid.clone(),
                viewer.clone(),
                201,
                viewer.clone(),
                relay,
                250,
                101,
            ),
            (
                valid.clone(),
                viewer.clone(),
                200,
                viewer.clone(),
                "wss://other.example",
                250,
                101,
            ),
            (
                valid.clone(),
                viewer.clone(),
                200,
                viewer.clone(),
                relay,
                199,
                101,
            ),
            (
                valid.clone(),
                viewer.clone(),
                200,
                viewer.clone(),
                relay,
                250,
                200,
            ),
            (
                jwt(&viewer, relay, 100, 99),
                viewer.clone(),
                99,
                viewer.clone(),
                relay,
                250,
                98,
            ),
            (
                jwt(&viewer, relay, 107, 200),
                viewer.clone(),
                200,
                viewer.clone(),
                relay,
                250,
                101,
            ),
            (
                "bad.jwt".into(),
                viewer.clone(),
                200,
                viewer.clone(),
                relay,
                250,
                101,
            ),
        ] {
            assert!(
                validate_jwt(&token, &returned, expires, &requested, community, session, time)
                    .is_err()
            );
        }
        let sub = format!("{}.{}.eA", URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt"}"#),URL_SAFE_NO_PAD.encode(serde_json::json!({"sub":viewer,"aud":"https://relay.example:8443","iat":100,"exp":200}).to_string()));
        assert!(validate_jwt(&sub, &viewer, 200, &viewer, relay, 250, 101).is_err());
    }
    /// An issuer that refuses every request with `status` and `body`, counting requests.
    async fn refusing_issuer(status: &'static str, body: &'static str) -> (String, Arc<AtomicU64>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/mount", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicU64::new(0));
        let counter = requests.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    if socket.read_exact(&mut byte).await.is_err() {
                        break;
                    }
                    head.push(byte[0]);
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        (base, requests)
    }
    #[tokio::test]
    async fn a_terminal_refusal_is_not_reissued_by_later_operations() {
        let relay = "wss://relay.example";
        let url = Url::parse("https://relay.example").unwrap();
        let identity = IdentityHost::fixture();
        for (status, body, code) in [
            (
                "403 Forbidden",
                r#"{"error":"authorization_denied"}"#,
                "authorization-denied",
            ),
            (
                "400 Bad Request",
                r#"{"error":"invalid_proof"}"#,
                "invalid-proof",
            ),
            ("418 I'm a teapot", "{}", "adapter-refused"),
            (
                "401 Unauthorized",
                r#"{"error":"invalid_grant"}"#,
                "grant-refused",
            ),
            ("200 OK", "{}", "invalid-response"),
        ] {
            let (base, requests) = refusing_issuer(status, body).await;
            let host = super::super::testing::signed_in(base, relay, true);
            for _ in 0..2 {
                assert_eq!(
                    host.assertion_for_relay(&identity, &url)
                        .await
                        .err()
                        .as_deref(),
                    Some(code)
                );
            }
            assert_eq!(
                requests.load(Ordering::SeqCst),
                1,
                "{status}: a later operation must keep the refusal without asking the issuer again"
            );
            assert!(host.snapshot().status == Status::SignedIn);
        }
    }
    #[tokio::test]
    async fn a_new_session_revision_asks_the_issuer_again_after_a_terminal_refusal() {
        let relay = "wss://relay.example";
        let url = Url::parse("https://relay.example").unwrap();
        let identity = IdentityHost::fixture();
        let (base, requests) =
            refusing_issuer("403 Forbidden", r#"{"error":"authorization_denied"}"#).await;
        let host = super::super::testing::signed_in(base, relay, true);
        assert!(host.assertion_for_relay(&identity, &url).await.is_err());
        assert!(host.assertion_for_relay(&identity, &url).await.is_err());
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        host.switch_account_for_test();
        assert_eq!(
            host.assertion_for_relay(&identity, &url)
                .await
                .err()
                .as_deref(),
            Some("authorization-denied")
        );
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn issuance_wire_has_separate_session_and_body_bound_same_key_nostr_proof() {
        use super::super::tests::{adapter, at_adapter, Memory};
        let identity = IdentityHost::fixture();
        let viewer = identity.viewer().await.unwrap();
        let relay = "wss://relay.example:8443";
        let minted = now().unwrap() as u64;
        let expires = minted + 60;
        let (base,server)=adapter(vec![serde_json::json!({"assertion":jwt(&viewer,relay,minted,expires),"nostr_pubkey":viewer,"expires_at":expires})]).await;
        let endpoint = format!("{base}/v1/identity/assertions");
        let host = at_adapter(Arc::new(Memory::default()), base);
        let assertion = host
            .issue(
                &identity,
                relay,
                &viewer,
                &host.snapshot().revision,
                "fixture-session-token",
                expires + 100,
            )
            .await
            .unwrap();
        assert!(assertion.header.starts_with("Bearer "));
        let seen = server.await.unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].target,
            "POST /mount/v1/identity/assertions HTTP/1.1"
        );
        let expected = format!(r#"{{"nostr_pubkey":"{viewer}","relay_url":"{relay}"}}"#);
        assert_eq!(seen[0].body, expected.as_bytes());
        let headers = &seen[0].headers;
        assert_eq!(
            headers
                .iter()
                .filter(|(name, _)| name == "authorization")
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>(),
            vec!["Bearer fixture-session-token"]
        );
        assert!(!headers.iter().any(
            |(name, _)| name == "nostr-federated-identity" || name == "x-bb-session-credential"
        ));
        let proof = headers
            .iter()
            .find(|(name, _)| name == "nostr-authorization")
            .unwrap()
            .1
            .strip_prefix("Nostr ")
            .unwrap();
        let proof: nostr::event::Event =
            serde_json::from_slice(&STANDARD.decode(proof).unwrap()).unwrap();
        proof.verify().unwrap();
        let proof = serde_json::to_value(proof).unwrap();
        assert_eq!(proof["pubkey"], viewer);
        assert_eq!(proof["kind"], 27235);
        assert_eq!(
            proof["tags"],
            serde_json::json!([
                ["u", endpoint],
                ["method", "POST"],
                [
                    "payload",
                    format!("{:x}", Sha256::digest(expected.as_bytes()))
                ]
            ])
        );
        assert!(
            assertion.remaining()
                <= std::time::UNIX_EPOCH
                    .checked_add(std::time::Duration::from_secs(expires))
                    .unwrap()
                    .duration_since(std::time::SystemTime::now())
                    .unwrap()
                    + std::time::Duration::from_millis(1)
        );
    }
    #[tokio::test(start_paused = true)]
    async fn retired_write_results_are_uncertain_and_do_not_offer_sign_in_retry() {
        use super::super::tests::{host, record, Memory};
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let assertion = Assertion {
            header: Zeroizing::new("Bearer fixture".into()),
            expires_at: Instant::now() + std::time::Duration::from_secs(60),
            revision: host.snapshot().revision,
            viewer: identity.viewer().await.unwrap(),
            relay: "wss://relay.example".into(),
            refresh_at: Instant::now(),
            server: Arc::downgrade(&host.0),
        };
        {
            let mut state = host.state();
            state.session = Some(record());
            state.snapshot.status = Status::SignedIn;
            state.restored = true;
        }
        host.admit_assertion(&identity, &assertion).await.unwrap();
        let authorization = Authorization {
            unsigned: None,
            assertion: Some(assertion),
            relay: "wss://relay.example".into(),
            discovery: host
                .discovery_generation("wss://relay.example", None)
                .unwrap(),
            socket: false,
            server: Arc::downgrade(&host.0),
        };
        host.retire(Status::SignedOut, None);
        assert_eq!(host.admit_response(&identity, &authorization, true).await.unwrap_err(),
            "Write result could not be confirmed; it may have completed. Inspect the existing operation before retrying.");
        assert_eq!(
            host.admit_response(&identity, &authorization, false)
                .await
                .unwrap_err(),
            "Federated authorization changed"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn admitted_request_keeps_result_after_assertion_expiry_and_discovery_retirement() {
        use super::super::tests::{host, Memory};
        let host = host(Arc::new(Memory::default()));
        signed_in(&host);
        let identity = IdentityHost::fixture();
        let relay = "wss://relay.example";
        let authorization = protected(
            &host,
            &identity,
            relay,
            Instant::now() + std::time::Duration::from_secs(1),
        )
        .await;
        let (started, observed) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        let worker = host.clone();
        let request = tokio::spawn(async move {
            worker
                .during_admitted_operation(&identity, &authorization, false, async {
                    let _ = started.send(());
                    let _ = held.await;
                    42
                })
                .await
        });
        observed.await.unwrap();
        tokio::time::advance(std::time::Duration::from_secs(2)).await;
        let next = host
            .discovery_generation(
                relay,
                Some(("replacement".into(), CancellationToken::new())),
            )
            .unwrap();
        next.result.set(Ok(false)).unwrap();
        release.send(()).unwrap();
        assert_eq!(request.await.unwrap().unwrap(), 42);
    }

    #[tokio::test(start_paused = true)]
    async fn admitted_request_is_cancelled_when_its_federated_session_retires() {
        use super::super::tests::{host, Memory};
        let host = host(Arc::new(Memory::default()));
        signed_in(&host);
        let identity = IdentityHost::fixture();
        let authorization = protected(
            &host,
            &identity,
            "wss://relay.example",
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .await;
        let (started, observed) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let worker = host.clone();
        let request = tokio::spawn(async move {
            worker
                .during_admitted_operation(&identity, &authorization, true, async {
                    let _ = started.send(());
                    let _ = held.await;
                    42
                })
                .await
        });
        observed.await.unwrap();
        host.retire(Status::SignedOut, None);
        assert_eq!(
            request.await.unwrap().unwrap_err(),
            "Write result could not be confirmed; it may have completed. Inspect the existing operation before retrying."
        );
        assert!(release.send(()).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn git_import_lease_ignores_assertion_and_discovery_retirement_but_not_session_retirement(
    ) {
        use super::super::tests::{host, Memory};
        let host = host(Arc::new(Memory::default()));
        signed_in(&host);
        let relay = "wss://relay.example";
        let authorization = protected(
            &host,
            &IdentityHost::fixture(),
            relay,
            Instant::now() + std::time::Duration::from_secs(1),
        )
        .await;

        tokio::time::advance(std::time::Duration::from_secs(2)).await;
        assert!(authorization.remaining().is_zero());
        let replacement = host
            .discovery_generation(
                relay,
                Some(("replacement".into(), CancellationToken::new())),
            )
            .unwrap();
        replacement.result.set(Ok(false)).unwrap();
        assert!(!host.current_discovery(relay, &authorization.discovery));
        assert!(host.authorization_session_current(&authorization));

        host.retire(Status::SignedOut, None);
        assert!(!host.authorization_session_current(&authorization));
    }

    #[tokio::test]
    async fn response_fence_rechecks_session_after_native_viewer_lookup() {
        use super::super::tests::{host, Memory};
        use futures_util::FutureExt;
        let host = host(Arc::new(Memory::default()));
        signed_in(&host);
        let identity = IdentityHost::fixture();
        let authorization = protected(
            &host,
            &identity,
            "wss://relay.example",
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .await;
        let (started, observed) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let signing = identity.clone();
        let signer = tokio::spawn(async move {
            signing
                .with_key(move |_, _| {
                    let _ = started.send(());
                    let _ = held.recv();
                    Ok(())
                })
                .await
        });
        observed.await.unwrap();
        let admission = host.admit_response(&identity, &authorization, true);
        tokio::pin!(admission);
        assert!(admission.as_mut().now_or_never().is_none());
        host.retire(Status::SignedOut, None);
        release.send(()).unwrap();
        assert_eq!(admission.await.unwrap_err(), admission_retired(true));
        signer.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn near_expiry_assertion_is_refreshed_for_a_later_explicit_join() {
        use super::super::tests::{adapter, at_adapter, Memory};
        let identity = IdentityHost::fixture();
        let viewer = identity.viewer().await.unwrap();
        let relay = "wss://relay.example";
        let minted = now().unwrap() as u64;
        let first_expiry = minted + 30;
        let second_expiry = minted + 300;
        let (base, server) = adapter(vec![
            serde_json::json!({"assertion":jwt(&viewer,relay,minted,first_expiry),"nostr_pubkey":viewer,"expires_at":first_expiry}),
            serde_json::json!({"assertion":jwt(&viewer,relay,minted,second_expiry),"nostr_pubkey":viewer,"expires_at":second_expiry}),
        ])
        .await;
        let host = at_adapter(Arc::new(Memory::default()), base);
        signed_in(&host);
        host.discovered(relay, true);
        let url = Url::parse(relay).unwrap();
        let first = host.assertion_for_relay(&identity, &url).await.unwrap();
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(16)).await;
        tokio::time::resume();
        let second = host.assertion_for_relay(&identity, &url).await.unwrap();
        assert_ne!(first.header(), second.header());
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn malformed_and_refused_assertion_responses_are_cached_for_the_session() {
        use super::super::tests::{adapter_with_status, at_adapter, Memory};
        for (status, body, expected) in [
            (
                200,
                serde_json::json!({"unexpected":true}),
                "invalid-response",
            ),
            (
                403,
                serde_json::json!({"error":"authorization_denied"}),
                "authorization-denied",
            ),
        ] {
            let (base, server) = adapter_with_status(vec![(status, body)]).await;
            let host = at_adapter(Arc::new(Memory::default()), base);
            signed_in(&host);
            let identity = IdentityHost::fixture();
            let relay = "wss://relay.example";
            host.discovered(relay, true);
            let url = Url::parse(relay).unwrap();
            for _ in 0..2 {
                assert_eq!(
                    host.assertion_for_relay(&identity, &url)
                        .await
                        .err()
                        .as_deref(),
                    Some(expected)
                );
            }
            assert_eq!(server.await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn terminal_status_with_an_unreadable_body_stays_terminal_across_acquisition_cooldown() {
        use super::super::tests::{at_adapter, Memory};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, kind) in [
            (400, "truncated"),
            (401, "truncated"),
            (403, "truncated"),
            (403, "oversize"),
            (403, "invalid-chunk"),
            (401, "held"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(AtomicUsize::new(0));
            let counted = requests.clone();
            let server = tokio::spawn(async move {
                let mut held_bodies = tokio::task::JoinSet::new();
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut head = Vec::new();
                    while !head.ends_with(b"\r\n\r\n") {
                        head.push(socket.read_u8().await.unwrap());
                    }
                    counted.fetch_add(1, Ordering::SeqCst);
                    let body = match kind {
                        "oversize" => "Content-Length: 65537\r\nConnection: close\r\n\r\n",
                        "invalid-chunk" => {
                            "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\nnot-a-size\r\n"
                        }
                        "held" => "Content-Length: 20\r\nConnection: close\r\n\r\n",
                        _ => "Content-Length: 20\r\nConnection: close\r\n\r\n{",
                    };
                    let response = format!("HTTP/1.1 {status} Refused\r\n{body}");
                    socket.write_all(response.as_bytes()).await.unwrap();
                    if kind == "held" {
                        held_bodies.spawn(async move {
                            std::future::pending::<()>().await;
                            drop(socket);
                        });
                        continue;
                    }
                    let _ = socket.shutdown().await;
                }
            });
            let host = at_adapter(Arc::new(Memory::default()), base);
            signed_in(&host);
            let identity = IdentityHost::fixture();
            let relay = "wss://relay.example";
            host.discovered(relay, true);
            let url = Url::parse(relay).unwrap();
            let first = if kind == "held" {
                let received = Arc::new(tokio::sync::Notify::new());
                let request = super::super::protocol::HEADERS_RECEIVED
                    .scope(received.clone(), host.assertion_for_relay(&identity, &url));
                let advance = async {
                    received.notified().await;
                    // The client has classified the headers. The server keeps
                    // the body pending, so advance through the total deadline.
                    tokio::time::pause();
                    tokio::time::advance(
                        super::super::protocol::DEADLINE + std::time::Duration::from_secs(1),
                    )
                    .await;
                };
                let (result, ()) = tokio::join!(request, advance);
                tokio::time::resume();
                result.err()
            } else {
                host.assertion_for_relay(&identity, &url).await.err()
            };
            tokio::time::pause();
            tokio::time::advance(ACQUISITION_RETRY_COOLDOWN).await;
            tokio::time::resume();
            let second = host.assertion_for_relay(&identity, &url).await.err();
            // Both acquisitions completed: no deferred retry remains to dispatch.
            let count = requests.load(Ordering::SeqCst);
            server.abort();
            let _ = server.await;
            assert_eq!(
                count, 1,
                "terminal {status}/{kind} was issued again after cooldown"
            );
            assert_eq!(first.as_deref(), Some("adapter-refused"));
            assert_eq!(second.as_deref(), Some("adapter-refused"));
            assert!(
                host.snapshot().status == Status::SignedIn,
                "an unreadable 401 cannot establish session invalidation"
            );
        }
    }

    #[tokio::test]
    async fn transient_assertion_failures_are_suppressed_until_the_cooldown_expires() {
        use super::super::tests::{adapter_with_status, at_adapter, Memory};
        let identity = IdentityHost::fixture();
        let viewer = identity.viewer().await.unwrap();
        let relay = "wss://relay.example";
        let minted = now().unwrap() as u64;
        let expires = minted + 60;
        let reply = serde_json::json!({"assertion":jwt(&viewer,relay,minted,expires),"nostr_pubkey":viewer,"expires_at":expires});
        let (base, server) = adapter_with_status(vec![
            (503, serde_json::json!({"error":"busy"})),
            (503, serde_json::json!({"error":"busy"})),
            (503, serde_json::json!({"error":"busy"})),
            (200, reply),
        ])
        .await;
        let host = at_adapter(Arc::new(Memory::default()), base);
        signed_in(&host);
        host.discovered(relay, true);
        let url = Url::parse(relay).unwrap();
        assert_eq!(
            host.assertion_for_relay(&identity, &url)
                .await
                .err()
                .as_deref(),
            Some("network-unavailable")
        );
        tokio::time::pause();
        assert_eq!(
            host.assertion_for_relay(&identity, &url)
                .await
                .err()
                .as_deref(),
            Some("network-unavailable")
        );
        tokio::time::advance(ACQUISITION_RETRY_COOLDOWN).await;
        tokio::time::resume();
        assert!(host.assertion_for_relay(&identity, &url).await.is_ok());
        assert_eq!(server.await.unwrap().len(), 4);
    }
    #[tokio::test(start_paused = true)]
    async fn retirement_interrupts_a_pending_protected_operation_before_its_late_result() {
        use super::super::tests::{host, record, Memory};
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let viewer = identity.viewer().await.unwrap();
        {
            let mut state = host.state();
            state.session = Some(record());
            state.snapshot.status = Status::SignedIn;
            state.restored = true;
        }
        let assertion = Assertion {
            header: Zeroizing::new("Bearer fixture".into()),
            expires_at: Instant::now() + std::time::Duration::from_secs(60),
            revision: host.snapshot().revision,
            viewer,
            relay: "wss://relay.example".into(),
            refresh_at: Instant::now(),
            server: Arc::downgrade(&host.0),
        };
        let (started, observed) = tokio::sync::oneshot::channel();
        let (late, held) = tokio::sync::oneshot::channel::<()>();
        let worker = host.clone();
        let task = tokio::spawn(async move {
            worker
                .during(&identity, &assertion, async {
                    let _ = started.send(());
                    let _ = held.await;
                    42
                })
                .await
        });
        observed.await.unwrap();
        host.retire(Status::SignedOut, None);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(
            late.send(()).is_err(),
            "the retired operation must be dropped"
        );
    }
    #[tokio::test]
    async fn finite_read_discovery_reacquires_once_and_stops_on_further_churn() {
        use super::super::tests::{host, Memory};
        use futures_util::FutureExt;
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let relay = "wss://127.0.0.1:9";
        let url = Url::parse(relay).unwrap();
        let old = host
            .discovery_generation(relay, Some(("old".into(), CancellationToken::new())))
            .unwrap();
        let (held, started) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let old_init = tokio::spawn(async move {
            old.result
                .get_or_init(|| async {
                    held.send(()).unwrap();
                    released.await.unwrap();
                    Ok(false)
                })
                .await
                .clone()
        });
        started.await.unwrap();
        let read = host.assertion_for_relay(&identity, &url);
        tokio::pin!(read);
        assert!(read.as_mut().now_or_never().is_none());
        let next = host
            .discovery_generation(relay, Some(("next".into(), CancellationToken::new())))
            .unwrap();
        let (held, started) = tokio::sync::oneshot::channel();
        let (release_next, released) = tokio::sync::oneshot::channel();
        let next_init = tokio::spawn(async move {
            next.result
                .get_or_init(|| async {
                    held.send(()).unwrap();
                    released.await.unwrap();
                    Ok(false)
                })
                .await
                .clone()
        });
        started.await.unwrap();
        release.send(()).unwrap();
        old_init.await.unwrap().unwrap();
        // The first replacement is adopted and held, rather than dispatched.
        assert!(read.as_mut().now_or_never().is_none());
        let newest = host
            .discovery_generation(relay, Some(("newest".into(), CancellationToken::new())))
            .unwrap();
        newest.result.set(Ok(false)).unwrap();
        release_next.send(()).unwrap();
        next_init.await.unwrap().unwrap();
        assert_eq!(
            read.await.err().as_deref(),
            Some("Federated community discovery changed")
        );
    }

    #[tokio::test]
    async fn finite_read_adopts_fresh_discovery_after_the_socket_closes() {
        use super::super::tests::{host, Memory};
        use futures_util::FutureExt;
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let relay = "wss://127.0.0.1:9";
        let url = Url::parse(relay).unwrap();
        let old = host
            .discovery_generation(relay, Some(("closing".into(), CancellationToken::new())))
            .unwrap();
        let (held, started) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let init = tokio::spawn(async move {
            old.result
                .get_or_init(|| async {
                    held.send(()).unwrap();
                    released.await.unwrap();
                    Ok(false)
                })
                .await
                .clone()
        });
        started.await.unwrap();
        let read = host.assertion_for_relay(&identity, &url);
        tokio::pin!(read);
        assert!(read.as_mut().now_or_never().is_none());
        host.close_discovery("closing");
        host.discovered(relay, false);
        release.send(()).unwrap();
        init.await.unwrap().unwrap();
        let authorization = read.await.unwrap();
        let dispatched = std::sync::atomic::AtomicUsize::new(0);
        host.during_admitted_operation(&identity, &authorization, false, async {
            dispatched.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .unwrap();
        assert_eq!(dispatched.load(Ordering::SeqCst), 1);
    }
}
