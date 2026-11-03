use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
pub(super) struct Memory {
    pub(super) raw: Mutex<Option<Zeroizing<Vec<u8>>>>,
    pub(super) compare_gate: Mutex<Option<super::agent::grant::tests::Gate>>,
    refusal: Mutex<Option<String>>,
    denied: AtomicBool,
    reads: AtomicUsize,
}
impl Store for Memory {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.raw.lock().unwrap().clone())
    }
    fn compare(
        &self,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str> {
        let mut raw = self.raw.lock().unwrap();
        if raw.as_ref().map(|v| v.as_slice()) != expected {
            return Err("session-changed");
        }
        if self.denied.load(Ordering::SeqCst) {
            return Err("storage-denied");
        }
        *raw = replacement.map(|value| Zeroizing::new(value.to_vec()));
        drop(raw);
        if let Some((held, release)) = self.compare_gate.lock().unwrap().take() {
            held.send(()).unwrap();
            release.recv().unwrap();
        }
        Ok(())
    }
    fn load(&self) -> Result<store::LoadedRecord, &'static str> {
        Ok((self.read()?, self.refusal.lock().unwrap().clone()))
    }
    fn remove(&self, expected: &[u8], revision: &str) -> Result<(), &'static str> {
        let mut raw = self.raw.lock().unwrap();
        if raw.as_ref().map(|value| value.as_slice()) != Some(expected) {
            return Err("session-changed");
        }
        *self.refusal.lock().unwrap() = Some(revision.into());
        if self.denied.load(Ordering::SeqCst) {
            return Err("storage-denied");
        }
        *raw = None;
        *self.refusal.lock().unwrap() = None;
        Ok(())
    }
}
pub(super) fn host(store: Arc<Memory>) -> FederatedIdentity {
    let config = Config::parse(r#"{"version":1,"id":"test","identityOrigin":"https://identity.example","adapterBase":"https://identity.example","apiBasePath":"/api/","communityHosts":["relay.example"]}"#).unwrap();
    FederatedIdentity::with_store(Some(config), "fingerprint".into(), "account".into(), store)
}
pub(super) fn record() -> Arc<Session> {
    let record = Record {
        version: 1,
        fingerprint: "fingerprint".into(),
        revision: uuid::Uuid::new_v4().to_string(),
        session_token: "fixture-session-token".into(),
        expires_at: "2099-01-01T00:00:00Z".into(),
        email: None,
    };
    let raw = Zeroizing::new(serde_json::to_vec(&record).unwrap());
    Arc::new(Session {
        record,
        raw,
        issued_at: 0,
    })
}

#[test]
fn each_community_routes_by_host_to_its_own_server() {
    let servers = config::compiled(
        Some(r#"{"version":1,"id":"bb-block","identityOrigin":"https://block.builderlab.xyz","communityHosts":["buzz.block.builderlab.xyz"],"adapterBase":"https://block.builderlab.xyz/api/goose","apiBasePath":"/api/goose/"}"#),
        None,
    )
    .unwrap();
    let server = |config: Config| {
        FederatedIdentity::with_store(
            Some(config),
            String::new(),
            String::new(),
            Arc::new(Memory::default()),
        )
    };
    let mut servers = servers.into_iter();
    let first = servers.next().unwrap();
    let public = server(servers.next().unwrap());
    let first = FederatedIdentity::build(
        Some(first),
        String::new(),
        String::new(),
        Arc::new(Memory::default()),
        vec![public.clone()],
    );
    let id = |relay: &str| {
        first
            .server_for(relay)
            .unwrap()
            .0
            .config
            .as_ref()
            .unwrap()
            .id
            .clone()
    };
    assert_eq!(id("wss://buzz.block.builderlab.xyz"), "bb-block");
    assert_eq!(id("wss://team.communities.buzz.xyz"), "bb-public");
    assert!(first
        .server_for("wss://team.communities.buzz.xyz")
        .unwrap()
        .is(&public));
    // A community no server covers stays with the first, which attaches no token.
    assert_eq!(id("wss://relay.example"), "bb-block");
    assert_eq!(
        first
            .server_for_command(Some("https://Team.communities.buzz.xyz"))
            .unwrap()
            .0
            .config
            .as_ref()
            .unwrap()
            .id,
        "bb-public"
    );
    assert!(first.server_for_command(None).unwrap().is(&first));
}

#[tokio::test]
async fn restored_snapshots_do_not_wait_for_an_interactive_operation() {
    use futures_util::FutureExt;
    let owner = host(Arc::new(Memory::default()));
    {
        let mut state = owner.state();
        state.restored = true;
        state.snapshot.status = Status::SigningIn;
    }
    let operation = owner.0.operation.lock().await;
    let snapshot = owner
        .restore()
        .now_or_never()
        .expect("a restored snapshot must not wait for the browser operation");
    assert!(snapshot.status == Status::SigningIn);
    drop(operation);
}

#[tokio::test]
async fn cancel_releases_the_native_callback_before_a_replacement_login() {
    let owner = host(Arc::new(Memory::default()));
    let callbacks = crate::oauth_callback::OAuthCallbackHost::default();
    let url = "https://identity.example/v1/login/start";
    let attempt = callbacks.begin_federated(url.into(), |_| Ok(())).unwrap();
    let guard = CallbackGuard(callbacks.clone(), attempt.id);
    {
        let mut state = owner.state();
        state.restored = true;
        state.snapshot.status = Status::SigningIn;
        state.callback = Some(guard.clone());
    }
    owner.cancel_sign_in();
    let replacement = callbacks.begin_federated(url.into(), |_| Ok(())).unwrap();
    drop(guard); // The old future's cleanup cannot cancel the replacement.
    assert!(callbacks.begin_federated(url.into(), |_| Ok(())).is_err());
    callbacks.cancel(&replacement.id).unwrap();
}

#[tokio::test]
async fn concurrent_absent_restore_reads_once_and_never_creates_an_account() {
    let store = Arc::new(Memory::default());
    let host = host(store.clone());
    let (a, b) = tokio::join!(host.restore(), host.restore());
    assert!(a.status == Status::SignedOut && b.status == Status::SignedOut);
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    assert!(store.raw.lock().unwrap().is_none());
}

#[tokio::test]
async fn failed_sign_out_refuses_the_record_on_restart_until_deletion_succeeds() {
    let store = Arc::new(Memory::default());
    let session = record();
    *store.raw.lock().unwrap() = Some(session.raw.clone());
    let host = host(store.clone());
    {
        let mut state = host.state();
        state.session = Some(session.clone());
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    let old_revision = host.snapshot().revision;
    store.denied.store(true, Ordering::SeqCst);
    let signed_out = host.sign_out().await;
    assert!(signed_out.status == Status::Unavailable);
    assert_eq!(signed_out.failure, Some("storage-denied"));
    assert!(!host.current(&old_revision));
    assert!(host.state().session.is_none());
    assert_eq!(
        store.refusal.lock().unwrap().as_deref(),
        Some(session.record.revision.as_str())
    );
    let restart = super::tests::host(store.clone());
    assert!(restart.restore().await.status == Status::Unavailable);
    assert!(restart.state().session.is_none());
    store.denied.store(false, Ordering::SeqCst);
    assert!(restart.restore().await.status == Status::SignedOut);
    assert!(store.raw.lock().unwrap().is_none());
    assert!(store.refusal.lock().unwrap().is_none());
}

#[tokio::test]
async fn stale_cleanup_cannot_delete_a_replacement_session() {
    let store = Arc::new(Memory::default());
    let old = record();
    let newer = record();
    *store.raw.lock().unwrap() = Some(newer.raw.clone());
    *store.refusal.lock().unwrap() = Some(newer.record.revision.clone());
    let host = host(store.clone());
    assert_eq!(host.remove(old).await.unwrap_err().code, "session-changed");
    assert_eq!(
        store.raw.lock().unwrap().as_ref().unwrap().as_slice(),
        newer.raw.as_slice()
    );
    assert_eq!(
        store.refusal.lock().unwrap().as_deref(),
        Some(newer.record.revision.as_str())
    );
}

#[tokio::test]
async fn corrupt_storage_is_unavailable_and_public_snapshots_have_no_secret() {
    let store = Arc::new(Memory::default());
    *store.raw.lock().unwrap() = Some(Zeroizing::new(b"not a record".to_vec()));
    let host = host(store.clone());
    let snapshot = host.restore().await;
    assert!(snapshot.status == Status::Unavailable);
    assert_eq!(snapshot.failure, Some("storage-corrupt"));
    assert_eq!(
        store.raw.lock().unwrap().as_ref().unwrap().as_slice(),
        b"not a record"
    );
    let session = record();
    {
        let mut state = host.state();
        state.session = Some(session);
        state.snapshot.status = Status::SignedIn;
    }
    let public = serde_json::to_value(host.snapshot()).unwrap();
    assert_eq!(public.as_object().unwrap().len(), 7);
    assert!(!public.to_string().contains("fixture-session-token"));
}

#[tokio::test]
async fn local_expiry_retires_a_cached_session_without_sending_it_upstream() {
    let store = Arc::new(Memory::default());
    let mut expired = record();
    let session = Arc::get_mut(&mut expired).unwrap();
    session.record.expires_at = "2000-01-01T00:00:00Z".into();
    session.raw = Zeroizing::new(serde_json::to_vec(&session.record).unwrap());
    *store.raw.lock().unwrap() = Some(session.raw.clone());
    let host = host(store.clone());
    {
        let mut state = host.state();
        state.session = Some(expired);
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    let revision = host.snapshot().revision;
    assert!(host.restore().await.status == Status::ReauthenticationRequired);
    assert!(!host.current(&revision));
    assert!(host.state().session.is_none());
    assert!(store.raw.lock().unwrap().is_none());
}

#[tokio::test]
async fn a_401_recheck_ends_only_a_session_the_adapter_refuses() {
    let (base, server) = adapter_with_status(vec![
        (
            200,
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z"}),
        ),
        (401, serde_json::json!({"error":"session_expired"})),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let host = at_adapter(store.clone(), base);
    let session = record();
    *store.raw.lock().unwrap() = Some(session.raw.clone());
    {
        let mut state = host.state();
        state.snapshot.revision = session.record.revision.clone();
        state.snapshot.status = Status::SignedIn;
        state.session = Some(session.clone());
        state.restored = true;
    }
    let revision = host.snapshot().revision;
    // A stale revision asks nothing.
    host.recheck("stale").await;
    host.recheck(&revision).await;
    assert!(host.current(&revision));
    assert!(host.snapshot().status == Status::SignedIn);
    host.recheck(&revision).await;
    assert!(!host.current(&revision));
    assert!(host.snapshot().status == Status::ReauthenticationRequired);
    assert!(host.state().session.is_none());
    assert!(store.raw.lock().unwrap().is_none());
    let seen = server.await.unwrap();
    assert_eq!(seen.len(), 2);
    assert!(seen
        .iter()
        .all(|wire| wire.target == "GET /mount/v1/session HTTP/1.1"));
}

#[tokio::test]
async fn account_changes_tell_expiry_and_refresh_from_sign_out_and_a_new_account() {
    let store = Arc::new(Memory::default());
    let host = host(store.clone());
    let changes = host.account_changes();
    let sign_in = |email: &str| {
        let mut state = host.state();
        host.signed_in(&mut state, Some(email.into()));
        changes.borrow().clone()
    };
    assert_eq!(sign_in("a@example.com"), Some(SessionChange::Refreshed));
    assert_eq!(sign_in("a@example.com"), Some(SessionChange::Refreshed));
    assert_eq!(
        sign_in("b@example.com"),
        Some(SessionChange::AccountChanged)
    );
    host.sign_out().await;
    assert_eq!(*changes.borrow(), Some(SessionChange::SignedOut));
    assert_eq!(sign_in("b@example.com"), Some(SessionChange::Refreshed));

    let mut expired = record();
    let session = Arc::get_mut(&mut expired).unwrap();
    session.record.expires_at = "2000-01-01T00:00:00Z".into();
    {
        let mut state = host.state();
        state.session = Some(expired);
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    host.restore().await;
    assert_eq!(*changes.borrow(), Some(SessionChange::Expired));
    assert_eq!(host.state().account, Some(Some("b@example.com".into())));
}

#[test]
fn with_session_lends_the_token_only_while_signed_in() {
    let host = host(Arc::new(Memory::default()));
    assert!(host.with_session(|_, _, _| ()).is_none());
    host.state().session = Some(record());
    let revision = host.snapshot().revision;
    let lent = host.with_session(|token, current, _| (token.to_string(), current.to_owned()));
    assert_eq!(lent, Some(("fixture-session-token".into(), revision)));
    assert_ne!(
        host.agent_grant_key("owner", "a"),
        host.agent_grant_key("owner", "b")
    );
}

pub(super) struct Wire {
    pub(super) target: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
}
pub(super) async fn adapter(
    replies: Vec<serde_json::Value>,
) -> (String, tokio::task::JoinHandle<Vec<Wire>>) {
    adapter_with_status(replies.into_iter().map(|reply| (200, reply)).collect()).await
}
pub(super) async fn adapter_with_status(
    replies: Vec<(u16, serde_json::Value)>,
) -> (String, tokio::task::JoinHandle<Vec<Wire>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/mount", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut seen = Vec::new();
        for (status, reply) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            let text = String::from_utf8(head).unwrap();
            let mut lines = text.split("\r\n");
            let target = lines.next().unwrap().to_owned();
            let headers: Vec<_> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
                .collect();
            let size: usize = headers
                .iter()
                .find(|(name, _)| name == "content-length")
                .map_or(0, |(_, value)| value.parse().unwrap());
            let mut body = vec![0; size];
            socket.read_exact(&mut body).await.unwrap();
            seen.push(Wire {
                target,
                headers,
                body,
            });
            let body = reply.to_string();
            let reason = match status {
                200 => "OK",
                401 => "Unauthorized",
                403 => "Forbidden",
                429 => "Too Many Requests",
                503 => "Service Unavailable",
                _ => "Fixture Response",
            };
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
        seen
    });
    (base, task)
}
pub(super) fn at_adapter(store: Arc<Memory>, base: String) -> FederatedIdentity {
    let mut owner = host(store);
    // Plain loopback wire fixture only. Production Config::parse requires HTTPS.
    Arc::get_mut(&mut owner.0)
        .unwrap()
        .config
        .as_mut()
        .unwrap()
        .adapter_base = base;
    owner
}
#[tokio::test]
async fn native_exchange_verification_persistence_and_restart_use_the_standard_contract() {
    let store = Arc::new(Memory::default());
    let (base,server) = adapter(vec![
        serde_json::json!({"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00Z"}),
        serde_json::json!({"expires_at":"2098-12-31T19:00:00-05:00"}),
        serde_json::json!({"expires_at":"2099-01-01T00:00:00Z","email":"a@example.com"}),
    ]).await;
    let owner = at_adapter(store.clone(), base.clone());
    let revision = owner.snapshot().revision;
    owner
        .finish_login(
            "single-use-code",
            "native-handoff-secret",
            &revision,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let signed_in = owner.snapshot();
    assert!(signed_in.status == Status::SignedIn);
    assert!(signed_in.email.is_none());
    assert!(!serde_json::to_string(&signed_in)
        .unwrap()
        .contains("fixture-session-token"));
    let restarted = at_adapter(store, base);
    let restored = restarted.restore().await;
    assert!(restored.status == Status::SignedIn);
    assert_eq!(restored.revision, signed_in.revision);
    assert_eq!(restored.email.as_deref(), Some("a@example.com"));
    let seen = server.await.unwrap();
    assert_eq!(seen[0].target, "POST /mount/v1/login/exchange HTTP/1.1");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&seen[0].body).unwrap(),
        serde_json::json!({"code":"single-use-code","handoff_secret":"native-handoff-secret"})
    );
    assert!(!seen[0]
        .headers
        .iter()
        .any(|(name, _)| name == "authorization"));
    for check in &seen[1..] {
        assert_eq!(check.target, "GET /mount/v1/session HTTP/1.1");
        assert_eq!(
            check
                .headers
                .iter()
                .filter(|(name, _)| name == "authorization")
                .collect::<Vec<_>>(),
            vec![&(
                "authorization".into(),
                "Bearer fixture-session-token".into()
            )]
        );
        assert!(!check
            .headers
            .iter()
            .any(|(name, _)| name == "x-bb-session-credential"));
    }
}
#[tokio::test]
async fn invalid_exchange_and_unequal_fractional_expiry_never_persist() {
    for (exchange, checks) in [
        (
            serde_json::json!({"session_token":"bad\nheader","expires_at":"2099-01-01T00:00:00Z"}),
            vec![],
        ),
        (
            serde_json::json!({"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00.100Z"}),
            vec![serde_json::json!({"expires_at":"2099-01-01T00:00:00.200Z"})],
        ),
        (
            serde_json::json!({"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00Z"}),
            vec![serde_json::json!({"expires_at":"invalid"})],
        ),
    ] {
        let store = Arc::new(Memory::default());
        let (base, server) = adapter(std::iter::once(exchange).chain(checks).collect()).await;
        let owner = at_adapter(store.clone(), base);
        assert!(owner
            .finish_login(
                "code",
                "secret",
                &owner.snapshot().revision,
                &CancellationToken::new()
            )
            .await
            .is_err());
        assert!(store.raw.lock().unwrap().is_none());
        server.await.unwrap();
    }
}
#[tokio::test]
async fn retirement_during_verification_prevents_late_installation() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (started, observed) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    let mut started = Some(started);
    let mut held = Some(held);
    let server = tokio::spawn(async move {
        for n in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            if n == 0 {
                let text = String::from_utf8(head).unwrap();
                let length: usize = text
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|size| size.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                socket.read_exact(&mut body).await.unwrap();
            } else {
                started.take().unwrap().send(()).unwrap();
                let _ = held.take().unwrap().await;
            }
            let body = if n == 0 {
                r#"{"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00Z"}"#
            } else {
                r#"{"expires_at":"2099-01-01T00:00:00Z"}"#
            };
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
            if n == 1 {
                break;
            }
        }
    });
    let store = Arc::new(Memory::default());
    let owner = at_adapter(store.clone(), base);
    let worker = owner.clone();
    let revision = owner.snapshot().revision;
    let cancel = owner.cancellation_for(&revision).unwrap();
    let login = tokio::spawn(async move {
        worker
            .finish_login("code", "secret", &revision, &cancel)
            .await
    });
    observed.await.unwrap();
    owner.sign_out().await;
    let _ = release.send(());
    assert!(login.await.unwrap().is_err());
    assert!(owner.snapshot().status == Status::SignedOut);
    assert!(store.raw.lock().unwrap().is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn concurrent_failed_restores_share_one_attempt_then_recover_after_cooldown() {
    use super::agent::tests::{issuer_gated, settled};
    use futures_util::FutureExt;
    let store = Arc::new(Memory::default());
    *store.raw.lock().unwrap() = Some(record().raw.clone());
    let (held, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let mut replies = vec![(503, serde_json::json!({"error":"unavailable"})); 3];
    replies.push((
        200,
        serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"a@example.com"}),
    ));
    let (base, served) = issuer_gated(replies, 0, Some((held, released))).await;
    let owner = at_adapter(store.clone(), base);
    let first_owner = owner.clone();
    let first = tokio::spawn(async move { first_owner.restore().await });
    reached.await.unwrap();
    let second = owner.restore();
    let third = owner.restore();
    let fourth = owner.restore();
    tokio::pin!(second, third, fourth);
    // Poll each caller while the first verification is held. Each has entered
    // restore admission and is queued on the owner's operation lock.
    assert!(second.as_mut().now_or_never().is_none());
    assert!(third.as_mut().now_or_never().is_none());
    assert!(fourth.as_mut().now_or_never().is_none());
    release.send(()).unwrap();
    let (first, second, third, fourth) = tokio::join!(first, second, third, fourth);
    assert!([first.unwrap(), second, third, fourth]
        .iter()
        .all(|snapshot| snapshot.status == Status::Unavailable));
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    assert!(owner.restore().await.status == Status::Unavailable);
    assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    tokio::time::resume();
    assert!(owner.restore().await.status == Status::SignedIn);
    assert_eq!(store.reads.load(Ordering::SeqCst), 2);
    assert_eq!(
        settled(served).await.len(),
        4,
        "one bounded failed attempt and one recovery verification"
    );
}

#[tokio::test]
async fn sign_out_during_shared_restore_prevents_late_installation() {
    use super::agent::tests::{issuer_gated, settled};
    use futures_util::FutureExt;
    let store = Arc::new(Memory::default());
    *store.raw.lock().unwrap() = Some(record().raw.clone());
    let (held, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let (base, served) = issuer_gated(
        vec![(
            200,
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z", "email":"a@example.com"}),
        )],
        0,
        Some((held, released)),
    )
    .await;
    let owner = at_adapter(store.clone(), base);
    let first_owner = owner.clone();
    let restoring = tokio::spawn(async move { first_owner.restore().await });
    reached.await.unwrap();
    let queued = owner.restore();
    tokio::pin!(queued);
    assert!(queued.as_mut().now_or_never().is_none());
    let retiring = owner.begin_sign_out();
    release.send(()).unwrap();
    let (restored, queued, signed_out) =
        tokio::join!(restoring, queued, owner.finish_sign_out(retiring));
    assert!(restored.unwrap().status == Status::SignedOut);
    assert!(queued.status == Status::SignedOut && signed_out.status == Status::SignedOut);
    assert!(owner.state().session.is_none());
    assert!(store.raw.lock().unwrap().is_none());
    assert_eq!(settled(served).await.len(), 1);
}

#[test]
fn expiry_warning_leads_by_72_hours_or_half_the_lifetime() {
    const HOUR: i64 = 60 * 60;
    let issued = 1_000_000;
    let week = issued + 7 * 24 * HOUR;
    assert_eq!(warning_at(issued, week), week - 72 * HOUR);
    let shift = issued + 8 * HOUR;
    assert_eq!(warning_at(issued, shift), issued + 4 * HOUR);
    // Records saved before issue time was kept warn 72 hours ahead.
    assert_eq!(warning_at(0, week), week - 72 * HOUR);
}

#[test]
fn expiry_watch_follows_the_wall_clock_across_sleep() {
    use std::time::Duration;
    let (warn, expires) = (1_000, 2_000);
    assert_eq!(
        due(0, warn, expires, false),
        Due::Wait(Duration::from_secs(60))
    );
    assert_eq!(
        due(990, warn, expires, false),
        Due::Wait(Duration::from_secs(10))
    );
    assert_eq!(due(warn, warn, expires, false), Due::Warn);
    assert_eq!(
        due(1_990, warn, expires, true),
        Due::Wait(Duration::from_secs(10))
    );
    assert_eq!(due(expires, warn, expires, true), Due::Expire);
    // Waking past both points ends the session without a stale warning.
    assert_eq!(due(5_000, warn, expires, false), Due::Expire);
}

fn signed_in_at(
    store: Arc<Memory>,
    base: String,
    email: &str,
) -> (FederatedIdentity, Arc<Session>) {
    let host = at_adapter(store.clone(), base);
    let mut current = record();
    let session = Arc::get_mut(&mut current).unwrap();
    session.record.email = Some(email.into());
    session.raw = Zeroizing::new(serde_json::to_vec(&session.record).unwrap());
    *store.raw.lock().unwrap() = Some(current.raw.clone());
    {
        let mut state = host.state();
        state.restored = true;
        host.install_session(&mut state, current.clone());
    }
    (host, current)
}

#[tokio::test]
async fn the_expiry_watch_warns_then_ends_the_session_at_expiry() {
    let store = Arc::new(Memory::default());
    let (host, _) = signed_in_at(
        store.clone(),
        "https://identity.example".into(),
        "a@example.com",
    );
    let now = now().unwrap();
    let mut short = record();
    let session = Arc::get_mut(&mut short).unwrap();
    session.issued_at = now - 2;
    session.record.expires_at = chrono::DateTime::from_timestamp(now + 2, 0)
        .unwrap()
        .to_rfc3339();
    session.raw = Zeroizing::new(serde_json::to_vec(&session.record).unwrap());
    *store.raw.lock().unwrap() = Some(short.raw.clone());
    let mut changes = host.0.changes.subscribe();
    {
        let mut state = host.state();
        host.reset(&mut state);
        host.install_session(&mut state, short);
    }
    assert!(!host.snapshot().expiring);
    let warned = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        changes.wait_for(|snapshot| snapshot.expiring),
    )
    .await
    .is_ok();
    assert!(warned);
    assert!(host.snapshot().status == Status::SignedIn);
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        changes.wait_for(|snapshot| snapshot.status == Status::ReauthenticationRequired),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(host.state().session.is_none());
    // The retired record is removed after the retirement is published.
    let _operation = host.0.operation.lock().await;
    assert!(store.raw.lock().unwrap().is_none());
}

#[tokio::test]
async fn signing_in_again_keeps_the_session_until_the_new_one_is_installed() {
    let (base, server) = adapter(vec![
        serde_json::json!({"session_token":"renewed-session-token","expires_at":"2099-02-01T00:00:00Z"}),
        serde_json::json!({"expires_at":"2099-02-01T00:00:00Z","email":"a@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let (host, old) = signed_in_at(store.clone(), base, "a@example.com");
    let changes = host.account_changes();
    let retirements = host.retirements();
    let revision = host.snapshot().revision;
    let cancel = {
        let mut state = host.state();
        let cancel = state.cancellation.child_token();
        state.renewal = Some(cancel.clone());
        cancel
    };
    // The old session still lends its token while the browser flow runs.
    assert_eq!(
        host.with_session(|token, _, _| token.to_string())
            .as_deref(),
        Some("fixture-session-token")
    );
    host.finish_login("code", "secret", &revision, &cancel)
        .await
        .unwrap();
    assert_eq!(host.renewed(&revision, &cancel, Ok(())), Ok(()));
    let snapshot = host.snapshot();
    assert!(snapshot.status == Status::SignedIn);
    assert_ne!(snapshot.revision, revision);
    assert_eq!(snapshot.expires_at.as_deref(), Some("2099-02-01T00:00:00Z"));
    assert!(host.state().renewal.is_none());
    assert_eq!(
        host.with_session(|token, _, _| token.to_string())
            .as_deref(),
        Some("renewed-session-token")
    );
    assert_ne!(store.raw.lock().unwrap().as_deref(), Some(&*old.raw));
    assert_eq!(*changes.borrow(), Some(SessionChange::Refreshed));
    assert_eq!(host.retirements(), retirements);
    server.await.unwrap();
}

#[tokio::test]
async fn a_canceled_or_failed_renewal_leaves_the_session_intact() {
    let (base, server) =
        adapter_with_status(vec![(400, serde_json::json!({"error":"invalid_grant"}))]).await;
    let store = Arc::new(Memory::default());
    let (host, old) = signed_in_at(store.clone(), base, "a@example.com");
    let revision = host.snapshot().revision;
    let renew = || {
        let mut state = host.state();
        let cancel = state.cancellation.child_token();
        state.renewal = Some(cancel.clone());
        cancel
    };

    let canceled = renew();
    host.cancel_sign_in();
    assert!(canceled.is_cancelled());
    let result = host
        .finish_login("code", "secret", &revision, &canceled)
        .await;
    assert_eq!(host.renewed(&revision, &canceled, result), Ok(()));

    let failed = renew();
    let result = host
        .finish_login("code", "secret", &revision, &failed)
        .await;
    assert!(result.is_err());
    // Only the caller hears about it; the snapshot's failure is for others.
    assert!(host.renewed(&revision, &failed, result).is_err());

    let snapshot = host.snapshot();
    assert!(snapshot.status == Status::SignedIn);
    assert_eq!(snapshot.revision, revision);
    assert!(snapshot.failure.is_none());
    assert!(host.state().renewal.is_none());
    assert!(Arc::ptr_eq(host.state().session.as_ref().unwrap(), &old));
    assert_eq!(store.raw.lock().unwrap().as_deref(), Some(&*old.raw));
    server.await.unwrap();
}

#[tokio::test]
async fn a_renewal_into_another_account_retires_derived_state() {
    let (base, server) = adapter(vec![
        serde_json::json!({"session_token":"other-session-token","expires_at":"2099-02-01T00:00:00Z"}),
        serde_json::json!({"expires_at":"2099-02-01T00:00:00Z","email":"b@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let (host, _) = signed_in_at(store, base, "a@example.com");
    let changes = host.account_changes();
    let retirements = host.retirements();
    let revision = host.snapshot().revision;
    let cancel = host.state().cancellation.child_token();
    host.finish_login("code", "secret", &revision, &cancel)
        .await
        .unwrap();
    assert_eq!(*changes.borrow(), Some(SessionChange::AccountChanged));
    assert_eq!(host.retirements(), retirements + 1);
    assert_eq!(host.snapshot().email.as_deref(), Some("b@example.com"));
    server.await.unwrap();
}

/// Holds `host`'s renewal into b@example.com once its record is saved, runs
/// `meanwhile`, then lets it finish.
async fn renewal_held_after_saving(
    meanwhile: impl FnOnce(&FederatedIdentity, &Memory),
) -> (
    FederatedIdentity,
    Arc<Memory>,
    Arc<Session>,
    String,
    Result<(), Failure>,
) {
    let (base, server) = adapter(vec![
        serde_json::json!({"session_token":"other-session-token","expires_at":"2099-02-01T00:00:00Z"}),
        serde_json::json!({"expires_at":"2099-02-01T00:00:00Z","email":"b@example.com"}),
    ])
    .await;
    let store = Arc::new(Memory::default());
    let (host, old) = signed_in_at(store.clone(), base, "a@example.com");
    let revision = host.snapshot().revision;
    let cancel = {
        let mut state = host.state();
        let cancel = state.cancellation.child_token();
        state.renewal = Some(cancel.clone());
        cancel
    };
    let (held, saved) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    *store.compare_gate.lock().unwrap() = Some((held, released));
    let worker = host.clone();
    let (login_revision, login_cancel) = (revision.clone(), cancel.clone());
    let login = tokio::spawn(async move {
        worker
            .finish_login("code", "secret", &login_revision, &login_cancel)
            .await
    });
    tokio::task::spawn_blocking(move || saved.recv().unwrap())
        .await
        .unwrap();
    meanwhile(&host, &store);
    release.send(()).unwrap();
    let result = login.await.unwrap();
    server.await.unwrap();
    (host, store, old, revision, result)
}

#[tokio::test]
async fn a_renewal_past_its_commit_point_ignores_cancel() {
    let (host, store, old, revision, result) =
        renewal_held_after_saving(|host, _| host.cancel_sign_in()).await;
    // Cancel came too late to stop it, so it completes whole.
    assert!(result.is_ok());
    let snapshot = host.snapshot();
    assert!(snapshot.status == Status::SignedIn);
    assert_ne!(snapshot.revision, revision);
    assert_eq!(snapshot.email.as_deref(), Some("b@example.com"));
    let current = host.state().session.clone().unwrap();
    assert!(!Arc::ptr_eq(&current, &old));
    assert_eq!(store.raw.lock().unwrap().as_deref(), Some(&*current.raw));
}

#[tokio::test]
async fn a_renewal_whose_session_ends_while_saving_is_refused_even_if_rollback_fails() {
    let (host, store, old, _, result) = renewal_held_after_saving(|host, store| {
        // The session ends (as sign-out does) and storage starts failing.
        host.retire(Status::SignedOut, None);
        store.denied.store(true, Ordering::SeqCst);
    })
    .await;
    assert!(result.is_err());
    assert!(host.state().session.is_none());
    // The replacement is still stored, but refused before anything else.
    assert_ne!(store.raw.lock().unwrap().as_deref(), Some(&*old.raw));
    store.denied.store(false, Ordering::SeqCst);
    let restarted = at_adapter(store.clone(), "https://identity.example".into());
    assert!(restarted.restore().await.status == Status::SignedOut);
    assert!(store.raw.lock().unwrap().is_none());
}
