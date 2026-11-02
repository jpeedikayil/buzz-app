//! Packaged human relay access. Credentials stay with IdentityHost; redirects never carry auth.
pub(crate) mod agent;
mod huddle;
use crate::federated_identity::{
    assertion::{Authorization, HEADER},
    FederatedIdentity,
};
use crate::identity::{EventTemplate, IdentityHost};
pub(crate) use agent::{
    relay_agent_library, relay_agent_log_proof, relay_agent_memories_read, relay_agent_observer,
    relay_agent_resolve,
};
use base64::{engine::general_purpose::STANDARD, Engine};
pub(crate) use huddle::{huddle_close, huddle_open, huddle_pcm, huddle_touch, Huddles};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use url::Url;

mod catalog;
mod channel_writes;
mod kit;
pub(crate) use channel_writes::{
    relay_channel_publish, relay_channel_sign, relay_direct_message, relay_kit_decode,
    relay_kit_prepare,
};
pub(crate) use kit::relay_kit_sign;
mod media_blocks;
mod media_preparation;
mod media_spool;
mod reminders;
pub(crate) use reminders::{relay_decode_reminders, relay_sign_reminder};
mod upload_spool;
pub(crate) use upload_spool::Spools;
mod media_stream;
pub(crate) use media_stream::{media_stream_base, MediaStream};
mod project_git;
pub(crate) use project_git::{relay_project_git, relay_project_git_cancel};
type Result<T> = std::result::Result<T, String>;
const MAX_BODY: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;

fn hex_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn template(event: &serde_json::Value, error: &str) -> Result<EventTemplate> {
    serde_json::from_value(serde_json::json!({
        "kind": event.get("kind"), "created_at": event.get("created_at"),
        "tags": event.get("tags"), "content": event.get("content"),
    }))
    .map_err(|_| error.into())
}

pub(crate) fn origin(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "Invalid relay origin")?;
    if value.len() > 2048
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Relay access requires an HTTPS origin without credentials or a path".into());
    }
    Ok(url)
}

fn request_url(community: &str, path: &str, method: &str) -> Result<Url> {
    let allowed = match method {
        "GET" => matches!(path, "/" | "/api/join-policy"),
        "POST" => matches!(
            path,
            "/query"
                | "/events"
                | "/api/invites"
                | "/api/invites/claim"
                | "/api/invites/accept-policy"
                | "/gifs/search"
                | "/profiles/search"
        ),
        _ => false,
    };
    if !allowed {
        return Err("Unsupported relay request".into());
    }
    origin(community)?
        .join(path)
        .map_err(|_| "Invalid relay path".into())
}

fn workflow_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
        && value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_workflow_time(value: &str) -> bool {
    // Timestamp syntax is bounded here; relay owns interpretation of the cursor.
    value.bytes().all(|byte| {
        byte.is_ascii_digit() || matches!(byte, b'-' | b'T' | b':' | b'.' | b'Z' | b'+')
    })
}

fn workflow_runs_url(community: &str, id: &str, cursor: Option<&WorkflowCursor>) -> Result<Url> {
    if !workflow_uuid(id)
        || cursor.is_some_and(|c| {
            !workflow_uuid(&c.before_id)
                || c.before.len() > 40
                || !c.before.as_bytes().get(0..10).is_some_and(|prefix| {
                    prefix.iter().enumerate().all(|(i, b)| {
                        if i == 4 || i == 7 {
                            *b == b'-'
                        } else {
                            b.is_ascii_digit()
                        }
                    })
                })
                || c.before.as_bytes().get(10) != Some(&b'T')
                || !valid_workflow_time(&c.before)
        })
    {
        return Err("Invalid workflow read".into());
    }
    let mut url = origin(community)?
        .join(&format!("/workflows/{id}/runs"))
        .map_err(|_| "Invalid workflow read")?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("limit", "20");
        if let Some(cursor) = cursor {
            query.append_pair("before", &cursor.before);
            query.append_pair("before_id", &cursor.before_id);
        }
    }
    Ok(url)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowCursor {
    before: String,
    before_id: String,
}

#[tauri::command]
pub(crate) async fn relay_workflow_runs(
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    id: String,
    cursor: Option<WorkflowCursor>,
) -> Result<RelayResponse> {
    let url = workflow_runs_url(&community, &id, cursor.as_ref())?;
    send(
        host.inner(),
        Some(fi.inner()),
        url,
        "GET",
        None,
        true,
        1024 * 1024,
    )
    .await
}

/// A Buzz git repository on this community: `<origin>/git/<owner hex>/<name>`.
pub(crate) fn git_repository(community: &str, repository: &str) -> Result<Url> {
    let origin = origin(community)?;
    let url = Url::parse(repository).map_err(|_| "Not a repository in this community")?;
    let segments: Vec<_> = url.path().split('/').skip(1).collect();
    // The relay's rule: strip one optional `.git`, then 1–64 of [A-Za-z0-9._-],
    // no leading dot and no "..".
    let name = |value: &str| {
        let value = value.strip_suffix(".git").unwrap_or(value);
        !value.is_empty()
            && value.len() <= 64
            && !value.starts_with('.')
            && !value.contains("..")
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    if url.as_str() != repository
        || url.origin() != origin.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || segments.len() != 3
        || segments[0] != "git"
        || !hex_key(segments[1])
        || !name(segments[2])
    {
        return Err("Not a repository in this community".into());
    }
    Ok(url)
}

/// NIP-98 for one repository URL. The relay accepts it for 60 seconds on every Git route
/// of that repository, so one clone reuses it. Returns the token after `Authorization: Nostr `;
/// never a general signing capability.
#[tauri::command]
pub(crate) async fn relay_git_authorization(
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    repository: String,
) -> Result<String> {
    let url = git_repository(&community, &repository)?;
    let assertion = evidence(host.inner(), Some(fi.inner()), &url).await?;
    let proof = git_authorization(host.inner(), &url).await?;
    admit(host.inner(), Some(fi.inner()), assertion.as_ref()).await?;
    Ok(proof)
}

pub(crate) async fn git_authorization(host: &IdentityHost, url: &Url) -> Result<String> {
    let auth = host
        .sign(EventTemplate {
            kind: 27235,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock is unavailable")?
                .as_secs(),
            content: String::new(),
            tags: vec![
                vec!["u".into(), url.to_string()],
                vec!["method".into(), "GET".into()],
            ],
        })
        .await?;
    Ok(STANDARD.encode(
        serde_json::to_vec(&auth).map_err(|_| "Could not encode repository authorization")?,
    ))
}

/// The largest complete signed NIP-AR artifact the relay takes: its default
/// 512 KiB WebSocket frame (`DEFAULT_MAX_FRAME_BYTES`) less the `["EVENT",…]`
/// wrapper. A 131,072-byte config snapshot plus the relay's 65,536 tag bytes
/// fits even fully escaped. Mirrors `ARTIFACT_MAX_EVENT_BYTES` in
/// `agent-config-artifacts.ts`.
const ARTIFACT_MAX_EVENT_BYTES: usize = 512 * 1024 - 16;

/// Kinds whose events may exceed the default 64 KiB signing bound.
fn signing_limit(kind: u16) -> Option<usize> {
    if catalog::is_catalog(kind) {
        Some(catalog::MAX_EVENT_BYTES)
    } else if kind == 45010 {
        Some(ARTIFACT_MAX_EVENT_BYTES)
    } else {
        None
    }
}

#[tauri::command]
pub(crate) async fn relay_sign(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    event: EventTemplate,
) -> Result<serde_json::Value> {
    validate_event(&community, &event)?;
    if event.kind == 9007 && !channel_creation_supported(&community).await? {
        return Err("Channel creation is unavailable".into());
    }
    if event.kind == 30078 {
        return Err("Channel recipe or Canvas rejected".into());
    }
    let coordinate_delete = if event.kind == 5 {
        event
            .tags
            .iter()
            .find(|tag| tag[0] == "a")
            .map(|tag| tag[1].clone())
    } else {
        None
    };
    let artifact = event.kind == 45010;
    let signed = match signing_limit(event.kind) {
        Some(limit) => host.sign_bounded(event, limit).await?,
        None => host.sign(event).await?,
    };
    // The commitment bound above omits id, pubkey key and sig; the relay
    // limits the whole event.
    if artifact && serde_json::to_vec(&signed).map_or(true, |b| b.len() > ARTIFACT_MAX_EVENT_BYTES)
    {
        return Err("Relay event is too large".into());
    }
    if coordinate_delete
        .is_some_and(|coordinate| coordinate.split(':').nth(1) != signed["pubkey"].as_str())
    {
        return Err("Only the author can delete this event".into());
    }
    Ok(signed)
}

fn validate_event(community: &str, event: &EventTemplate) -> Result<()> {
    let mut relay = origin(community)?;
    if event.kind == 22242 {
        relay.set_scheme("wss").map_err(|_| "Invalid relay")?;
        let relay_tags: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("relay"))
            .collect();
        let challenges: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("challenge"))
            .collect();
        if !event.content.is_empty()
            || event.tags.len() != 2
            || relay_tags.len() != 1
            || relay_tags[0].len() != 2
            || Url::parse(&relay_tags[0][1]).ok().as_ref() != Some(&relay)
            || challenges.len() != 1
            || challenges[0].len() != 2
            || challenges[0][1].is_empty()
            || challenges[0][1].len() > 4096
        {
            return Err("Relay authentication does not match this community".into());
        }
    } else if event.kind == 5 {
        if !valid_message_deletion(event) && !valid_managed_agent_deletion(event) {
            validate_workflow_template(event)?;
        }
    } else if matches!(event.kind, 30620 | 46020) {
        validate_workflow_template(event)?;
    } else if event.kind == 9007 {
        if !channel_writes::creation(event) {
            return Err("Agent enrollment or channel operation unavailable or invalid".into());
        }
    } else if matches!(event.kind, 30175 | 30178) {
        if !catalog::valid(event) {
            return Err("Malformed catalog publication".into());
        }
    } else if event.kind == 40100 {
        if !valid_canvas(event) {
            return Err("Malformed Canvas save".into());
        }
    } else if event.kind == 28936 {
        // A NIP-43 leave request revokes the signer's own membership: empty
        // content and exactly the NIP-70 protected tag, nothing else.
        if !event.content.is_empty() || event.tags != vec![vec!["-".to_string()]] {
            return Err("A leave request carries no content or other tags".into());
        }
    } else if event.kind == 20002 {
        let channel = |tag: &[String]| {
            matches!(tag, [name, id] if name == "h" && !id.is_empty()
                && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'))
        };
        let reference = |tag: &[String], marker: &str| {
            matches!(tag, [name, id, relay, role]
                if name == "e" && hex_key(id) && relay.is_empty() && role == marker)
        };
        let scoped = match event.tags.as_slice() {
            [h] => channel(h),
            [h, reply] => channel(h) && reference(reply, "reply"),
            [h, root, reply] => channel(h) && reference(root, "root") && reference(reply, "reply"),
            _ => false,
        };
        if !event.content.is_empty() || !scoped {
            return Err("Invalid typing indicator".into());
        }
    } else if event.kind == 20003 {
        // Owner presence for agents: a status and one `p` tag per agent; the
        // relay keeps only the agents the signer owns.
        if !matches!(event.content.as_str(), "online" | "offline")
            || event.tags.is_empty()
            || event.tags.len() > 256
            || !event
                .tags
                .iter()
                .all(|tag| matches!(tag.as_slice(), [name, key] if name == "p" && hex_key(key)))
        {
            return Err("Invalid agent presence".into());
        }
    } else if matches!(event.kind, 9030..=9032) {
        if !valid_member_command(event) {
            return Err("Invalid member change".into());
        }
    } else if !matches!(
        event.kind,
        0 | 7 | 9 | 1984 | 9000 | 9001 | 20001 | 30030 | 30177 | 30315 | 40003 | 42000 | 45010
    ) {
        return Err("This event is not supported by the packaged relay connection".into());
    }
    Ok(())
}

/** Match the broker's NIP-43 member command shape (`memberCommand` in
 * `src/features/communities/admin-protocol.ts`); the relay decides authority. */
fn valid_member_command(event: &EventTemplate) -> bool {
    let target = |tag: &[String]| matches!(tag, [name, key] if name == "p" && hex_key(key));
    let role = |tag: &[String]| matches!(tag, [name, role] if name == "role" && (role == "admin" || role == "member"));
    event.content.is_empty()
        && match (event.kind, event.tags.as_slice()) {
            (9031, [p]) => target(p),
            (9030 | 9032, [p, r]) => target(p) && role(r),
            _ => false,
        }
}

// Match the broker's purpose-bound Canvas admission, including legacy untagged retries.
fn valid_canvas(event: &EventTemplate) -> bool {
    event.content.len() <= 24 * 1024
        && event
            .tags
            .iter()
            .filter(|tag| tag.first().map(String::as_str) == Some("h"))
            .count()
            == 1
        && event
            .tags
            .iter()
            .filter(|tag| tag.first().map(String::as_str) == Some("expected-revision"))
            .count()
            <= 1
        && event.tags.iter().all(|tag| {
            if tag.len() != 2 {
                return false;
            }
            match tag[0].as_str() {
                "h" => channel_writes::uuid(&tag[1]),
                "client-id" => tag[1].encode_utf16().count() <= 128,
                "expected-revision" => {
                    tag[1] == "none"
                        || (tag[1].len() == 64
                            && tag[1]
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
                }
                _ => false,
            }
        })
}

/** Only the owner's managed-agent coordinate may use this global kind-5 shape. */
fn valid_managed_agent_deletion(event: &EventTemplate) -> bool {
    if !event.content.is_empty()
        // Signed events return to JavaScript; timestamps must fit Number.MAX_SAFE_INTEGER.
        || event.created_at > 9_007_199_254_740_991
        || event.tags.iter().any(|tag| {
            tag.len() != 2
                || tag[1].len() > 256
                || !matches!(tag[0].as_str(), "a" | "k" | "client-id")
        })
        || event
            .tags
            .iter()
            .enumerate()
            .any(|(i, tag)| event.tags[..i].iter().any(|prior| prior[0] == tag[0]))
        || event
            .tags
            .iter()
            .any(|tag| tag[0] == "k" && tag[1] != "30177")
    {
        return false;
    }
    let Some(coordinate) = event.tags.iter().find(|tag| tag[0] == "a") else {
        return false;
    };
    let mut parts = coordinate[1].split(':');
    parts.next() == Some("30177")
        && parts.next().is_some_and(hex_key)
        && parts.next().is_some_and(hex_key)
        && parts.next().is_none()
}

/** Keep the shared kind-5 writer aligned with the broker's channel-local deletion shape. */
fn valid_message_deletion(event: &EventTemplate) -> bool {
    if event.kind != 5
        || event.created_at > 9_007_199_254_740_991
        || !event.content.is_empty()
        || event.tags.len() > 106
        || event
            .tags
            .iter()
            .any(|tag| tag.len() != 2 || !matches!(tag[0].as_str(), "h" | "e" | "k" | "client-id"))
    {
        return false;
    }
    let channels: Vec<_> = event.tags.iter().filter(|tag| tag[0] == "h").collect();
    let targets: Vec<_> = event.tags.iter().filter(|tag| tag[0] == "e").collect();
    let kinds: Vec<_> = event.tags.iter().filter(|tag| tag[0] == "k").collect();
    channels.len() == 1
        && !channels[0][1].is_empty()
        && channels[0][1].encode_utf16().count() <= 256
        && (1..=100).contains(&targets.len())
        && targets.iter().all(|tag| {
            tag[1].len() == 64
                && tag[1]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        && targets
            .iter()
            .enumerate()
            .all(|(i, tag)| targets[..i].iter().all(|prior| prior[1] != tag[1]))
        && (1..=3).contains(&kinds.len())
        && kinds
            .iter()
            .all(|tag| matches!(tag[1].as_str(), "7" | "9" | "40002"))
}

fn validate_workflow_template(event: &EventTemplate) -> Result<()> {
    let expected = if event.kind == 5 { "a" } else { "d" };
    if event.tags.len() > 8
        || event.content.len() > 24_000
        || (event.kind != 30620 && !event.content.is_empty())
        || event.tags.iter().any(|tag| {
            tag.len() != 2
                || tag.iter().any(|value| value.len() > 256)
                || !matches!(
                    tag[0].as_str(),
                    "h" | "d" | "a" | "expected-revision" | "client-id"
                )
        })
        || event.tags.iter().filter(|tag| tag[0] == "h").count() != 1
        || event.tags.iter().filter(|tag| tag[0] == expected).count() != 1
        || event.tags.iter().any(|tag| {
            (tag[0] == "d" && expected != "d")
                || (tag[0] == "a" && expected != "a")
                || (tag[0] == "expected-revision" && event.kind != 30620)
        })
        || event
            .tags
            .iter()
            .enumerate()
            .any(|(i, tag)| event.tags[..i].iter().any(|prior| prior[0] == tag[0]))
    {
        return Err("Malformed workflow command".into());
    }
    let coordinate = &event.tags.iter().find(|tag| tag[0] == expected).unwrap()[1];
    let id = if event.kind == 5 {
        let Some(("30620", owner, id)) = coordinate
            .split_once(':')
            .and_then(|(kind, rest)| rest.split_once(':').map(|(owner, id)| (kind, owner, id)))
        else {
            return Err("Malformed workflow command".into());
        };
        if owner.len() != 64
            || !owner
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Malformed workflow command".into());
        }
        id
    } else {
        coordinate.as_str()
    };
    if !workflow_uuid(id)
        || !workflow_uuid(&event.tags.iter().find(|tag| tag[0] == "h").unwrap()[1])
        || event.tags.iter().any(|tag| {
            tag[0] == "expected-revision"
                && (tag[1].len() != 64
                    || !tag[1]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        })
    {
        return Err("Malformed workflow command".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn relay_decode_sidebar(
    host: tauri::State<'_, IdentityHost>,
    events: Vec<serde_json::Value>,
) -> Result<serde_json::Value> {
    host.decode_sidebar(events).await
}

#[tauri::command]
pub(crate) async fn relay_sign_sidebar(
    host: tauri::State<'_, IdentityHost>,
    coordinate: String,
    payload: serde_json::Value,
    created_at: u64,
) -> Result<serde_json::Value> {
    host.sign_sidebar(coordinate, payload, created_at).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadStateIntent {
    slot: String,
    created_at: u64,
    blob: serde_json::Value,
}

#[tauri::command]
pub(crate) async fn relay_decode_read_state(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    events: Vec<serde_json::Value>,
) -> Result<serde_json::Value> {
    origin(&community)?;
    host.decode_read_state(events).await
}

#[tauri::command]
pub(crate) async fn relay_sign_read_state(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    intent: ReadStateIntent,
) -> Result<serde_json::Value> {
    origin(&community)?;
    host.sign_read_state(intent.slot, intent.created_at, intent.blob)
        .await
}

/// Publication cannot be routed through the general event writer: it must verify
/// the exact own, encrypted read-state coordinate before forwarding signed bytes.
#[tauri::command]
pub(crate) async fn relay_publish_read_state(
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    event: serde_json::Value,
) -> Result<RelayResponse> {
    let url = request_url(&community, "/events", "POST")?;
    let body = serde_json::to_string(&event).map_err(|_| "Invalid read-state event")?;
    if body.len() > 64 * 1024 {
        return Err("Invalid read-state event".into());
    }
    host.decode_read_state(vec![event]).await?;
    send(
        host.inner(),
        Some(fi.inner()),
        url,
        "POST",
        Some(body),
        true,
        MAX_RESPONSE,
    )
    .await
}

#[derive(Serialize)]
pub(crate) struct RelayResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

async fn verify_owned_event(host: &IdentityHost, event: &serde_json::Value) -> Result<()> {
    if event.get("pubkey").and_then(serde_json::Value::as_str)
        != Some(host.viewer().await?.as_str())
    {
        return Err("Invalid outgoing signature".into());
    }
    verify_signature(event)
}

async fn admit_app_data(
    host: &IdentityHost,
    event: &serde_json::Value,
    community: &str,
) -> Result<()> {
    verify_owned_event(host, event).await?;
    // Sidebar preferences and channel recipes share kind 30078; the `d` coordinate selects the contract.
    let sidebar = event["tags"].as_array().is_some_and(|tags| {
        tags.iter().any(|tag| {
            tag[0] == "d"
                && tag[1]
                    .as_str()
                    .is_some_and(crate::identity::sidebar_coordinate)
        })
    });
    if sidebar {
        return host.admit_sidebar(event.clone()).await;
    }
    kit::validate_ciphertext(host, event, community).await?;
    Ok(())
}

/// An incoming event's signature claim: the webview checks shape and that `id`
/// hashes the event, then asks libsecp256k1 whether `sig` signs `id` for `pubkey`.
#[derive(serde::Deserialize)]
pub(crate) struct SignatureClaim {
    id: String,
    pubkey: String,
    sig: String,
}

/// BIP-340 checks off the webview's main thread; one result per claim, in order.
#[tauri::command]
pub(crate) async fn relay_verify_signatures(claims: Vec<SignatureClaim>) -> Result<Vec<bool>> {
    tauri::async_runtime::spawn_blocking(move || {
        let secp = secp256k1::Secp256k1::verification_only();
        claims.iter().map(|claim| signs(&secp, claim)).collect()
    })
    .await
    .map_err(|_| "Signature verification could not complete".into())
}

fn signs(secp: &secp256k1::Secp256k1<secp256k1::VerifyOnly>, claim: &SignatureClaim) -> bool {
    let (Ok(id), Ok(pubkey), Ok(sig)) = (
        nostr::event::EventId::from_hex(&claim.id),
        claim.pubkey.parse::<secp256k1::XOnlyPublicKey>(),
        claim.sig.parse::<secp256k1::schnorr::Signature>(),
    ) else {
        return false;
    };
    secp.verify_schnorr(&sig, id.as_bytes(), &pubkey).is_ok()
}

fn verify_signature(event: &serde_json::Value) -> Result<()> {
    let parsed: nostr::event::Event =
        serde_json::from_value(event.clone()).map_err(|_| "Invalid outgoing signature")?;
    parsed
        .verify()
        .map_err(|_| "Invalid outgoing signature".into())
}

async fn channel_creation_supported(community: &str) -> Result<bool> {
    let info = relay_info(community).await?;
    Ok(info
        .get("self")
        .and_then(serde_json::Value::as_str)
        .is_some_and(hex_key)
        && info
            .get("supported_nips")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|nips| nips.contains(&serde_json::Value::from(29))))
}

/// The community's unsigned NIP-11 document.
pub(crate) async fn relay_info(community: &str) -> Result<serde_json::Value> {
    let url = request_url(community, "/", "GET")?;
    let mut response = client()?
        .get(url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|_| "Community discovery failed")?;
    if !response.status().is_success() {
        return Err("Community discovery failed".into());
    }
    let body = read_bounded(
        &mut response,
        MAX_BODY,
        "Community discovery failed",
        "Invalid community information",
    )
    .await?;
    serde_json::from_slice(&body).map_err(|_| "Invalid community information".into())
}

static USER_AGENT: OnceLock<String> = OnceLock::new();

/// Records the app version native relay requests report, once at startup.
pub(crate) fn set_user_agent(version: impl std::fmt::Display) {
    let _ = USER_AGENT.set(format!("Buzz/{version}"));
}

/// `User-Agent` for native relay HTTP and WebSocket requests.
pub(crate) fn user_agent() -> &'static str {
    USER_AGENT.get().map_or("Buzz", String::as_str)
}

fn client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let builder = reqwest::Client::builder()
                .user_agent(user_agent())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30));
            // Tests' loopback communities use one self-signed root.
            #[cfg(test)]
            let builder =
                builder.tls_certs_only([crate::federated_identity::testing::trusted_root()]);
            builder.build()
        })
        .as_ref()
        .map_err(|_| "Relay network client is unavailable".into())
}

/// Status of a read the renderer abandoned; the renderer has stopped listening.
const CANCELLED_READ: u16 = 499;

/// Searches and reads the renderer may abandon. A dispatched write may already
/// have reached the relay, so it is never cancelled. Mirrors `nativeRelayRequest`.
fn cancellable_read(method: &str, path: &str) -> bool {
    method == "POST" && matches!(path, "/query" | "/profiles/search" | "/gifs/search")
}

/// The upload registry's semantics: a cancel may overtake its read IPC.
fn read_cancels() -> &'static Uploads {
    static CANCELS: OnceLock<Uploads> = OnceLock::new();
    CANCELS.get_or_init(Uploads::default)
}

#[tauri::command]
pub(crate) async fn relay_http(
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    path: String,
    method: String,
    body: Option<String>,
    id: Option<String>,
) -> Result<RelayResponse> {
    let url = request_url(&community, &path, &method)?;
    if body.as_ref().is_some_and(|b| b.len() > MAX_BODY)
        || (method == "GET" && body.is_some())
        || (method == "POST" && body.is_none())
    {
        return Err("Invalid relay request body".into());
    }
    if path == "/events" {
        let event: serde_json::Value =
            serde_json::from_str(body.as_deref().ok_or("Invalid relay request body")?)
                .map_err(|_| "Invalid relay request body")?;
        let kind = event.get("kind").and_then(serde_json::Value::as_u64);
        if matches!(kind, Some(41010)) {
            return Err("Choose between one and eight other people.".into());
        }
        if kind == Some(30078) {
            admit_app_data(host.inner(), &event, &community).await?;
        }
        if kind == Some(30300) {
            reminders::admit_reminder(host.inner(), &event).await?;
        }
        if kind == Some(9007) {
            verify_owned_event(host.inner(), &event).await?;
            let template = template(
                &event,
                "Agent enrollment or channel operation unavailable or invalid",
            )?;
            if !channel_writes::creation(&template) {
                return Err("Agent enrollment or channel operation unavailable or invalid".into());
            }
        }
        if matches!(kind, Some(9002 | 9008 | 9021 | 9022 | 41012 | 9035 | 9036)) {
            return Err("Invalid outgoing signature".into());
        }
    }
    let request = send(
        host.inner(),
        Some(fi.inner()),
        url,
        &method,
        body,
        method == "POST",
        MAX_RESPONSE,
    );
    cancellable(id.as_deref(), &method, &path, request).await
}

/// Runs `request`, or for a read with an `id`, until `relay_http_cancel` names it.
async fn cancellable(
    id: Option<&str>,
    method: &str,
    path: &str,
    request: impl std::future::Future<Output = Result<RelayResponse>>,
) -> Result<RelayResponse> {
    let Some(id) = id else {
        return request.await;
    };
    if !cancellable_read(method, path) {
        return Err("Relay writes cannot be cancelled".into());
    }
    let id = upload_id(Some(id)).map_err(|_| "Invalid relay read")?;
    let Some(cancelled) = read_cancels()
        .start(id)
        .map_err(|_| "Relay reads are busy")?
    else {
        return Ok(cancelled_read());
    };
    // Dropping the request future closes its connection.
    let result = tokio::select! {
        biased;
        _ = cancelled => Ok(cancelled_read()),
        result = request => result,
    };
    read_cancels().finish(id);
    result
}

#[tauri::command]
pub(crate) fn relay_http_cancel(id: String) -> Result<()> {
    read_cancels().cancel(upload_id(Some(&id)).map_err(|_| "Invalid relay read")?);
    Ok(())
}

fn cancelled_read() -> RelayResponse {
    RelayResponse {
        status: CANCELLED_READ,
        headers: BTreeMap::new(),
        body: String::new(),
    }
}

async fn evidence(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    url: &Url,
) -> Result<Option<Authorization>> {
    match fi {
        Some(fi) => fi.assertion_for_relay(host, url).await.map(Some),
        None => Ok(None),
    }
}
#[derive(Clone, Copy)]
struct AuthorizationContext<'a> {
    fi: Option<&'a FederatedIdentity>,
    assertion: Option<&'a Authorization>,
}
async fn admit(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    assertion: Option<&Authorization>,
) -> Result<()> {
    if let (Some(fi), Some(assertion)) = (fi, assertion) {
        fi.admit_authorization(host, assertion).await?;
    }
    Ok(())
}

async fn send(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    url: Url,
    method: &str,
    body: Option<String>,
    authenticated: bool,
    response_limit: usize,
) -> Result<RelayResponse> {
    let assertion = if authenticated {
        evidence(host, fi, &url).await?
    } else {
        None
    };
    send_authorized(
        host,
        AuthorizationContext {
            fi,
            assertion: assertion.as_ref(),
        },
        url,
        method,
        body,
        authenticated,
        response_limit,
    )
    .await
}

async fn send_authorized(
    host: &IdentityHost,
    authorization: AuthorizationContext<'_>,
    url: Url,
    method: &str,
    body: Option<String>,
    authenticated: bool,
    response_limit: usize,
) -> Result<RelayResponse> {
    let mut request = client()?.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid relay method")?,
        url.clone(),
    );
    if authenticated {
        let payload = body
            .as_ref()
            .map(|body| format!("{:x}", Sha256::digest(body.as_bytes())));
        let auth = host
            .sign(EventTemplate {
                kind: 27235,
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "System clock is unavailable")?
                    .as_secs(),
                content: String::new(),
                tags: [
                    vec![
                        vec!["u".into(), url.to_string()],
                        vec!["method".into(), method.into()],
                    ],
                    payload
                        .map(|hash| vec![vec!["payload".into(), hash]])
                        .unwrap_or_default(),
                    vec![vec!["nonce".into(), uuid::Uuid::new_v4().to_string()]],
                ]
                .concat(),
            })
            .await?;
        request = request
            .header(
                "Authorization",
                format!(
                    "Nostr {}",
                    STANDARD.encode(
                        serde_json::to_vec(&auth)
                            .map_err(|_| "Could not encode relay authentication")?
                    )
                ),
            )
            .header("Content-Type", "application/json");
        if let Some(body) = body {
            request = request.body(body);
        }
    } else {
        request = request.header("Accept", "application/nostr+json");
    }
    if let Some(header) = authorization.assertion.and_then(Authorization::header) {
        request = request.header(HEADER, header);
    }
    let mutation = method != "GET" && !matches!(url.path(), "/query" | "/gifs/search");
    // Never replay a write after a transport error: it may already have reached the relay.
    let operation = async {
        let response = request
            .send()
            .await
            .map_err(|_| "Relay request could not be confirmed")?;
        if response.status() == 401 {
            if let (Some(fi), Some(assertion)) = (
                authorization.fi,
                authorization
                    .assertion
                    .and_then(|authorization| authorization.assertion.as_ref()),
            ) {
                fi.reject_assertion(assertion).await;
            }
        }
        if let Some(reason) = authorization
            .assertion
            .and_then(|authorization| authorization.refusal(response.status().as_u16()))
        {
            return Err(reason.into());
        }
        read_response(response, response_limit).await
    };
    if let (Some(fi), Some(assertion)) = (authorization.fi, authorization.assertion) {
        fi.during_admitted_operation(host, assertion, mutation, operation)
            .await?
    } else {
        operation.await
    }
}

async fn read_response(mut response: reqwest::Response, limit: usize) -> Result<RelayResponse> {
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    for name in ["content-type", "retry-after", "server-timing"] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            headers.insert(name.into(), value.into());
        }
    }

    let bytes = read_bounded(
        &mut response,
        limit,
        "Relay response was interrupted",
        "Relay response is too large",
    )
    .await?;

    let body = String::from_utf8(bytes).map_err(|_| "Relay response is not UTF-8")?;
    Ok(RelayResponse {
        status,
        headers,
        body,
    })
}

async fn read_bounded(
    response: &mut reqwest::Response,
    limit: usize,
    interrupted: &str,
    oversized: &str,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(oversized.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| interrupted)? {
        if chunk.len() > limit - bytes.len() {
            return Err(oversized.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
/// The relay's largest accepted upload (videos).
const MAX_UPLOAD: usize = 500 * 1024 * 1024;

/// A Blossom `Authorization` value. JS never signs these: `relay_sign` rejects
/// kind 24242, so a script cannot mint a reusable read or a `delete` proof.
async fn blossom_auth(
    host: &IdentityHost,
    url: &Url,
    verb: &str,
    content: &str,
    mut tags: Vec<Vec<String>>,
) -> Result<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock is unavailable")?
        .as_secs();
    // `server` matches the dev broker's `URL.host` (host plus any explicit port).
    let server = &url[url::Position::BeforeHost..url::Position::AfterPort];
    tags.extend([
        vec!["t".into(), verb.into()],
        vec!["server".into(), server.into()],
        // The relay's strict NIP-FI window is 60 seconds.
        vec!["expiration".into(), (now + 60).to_string()],
    ]);
    let event = host
        .sign(EventTemplate {
            kind: 24242,
            created_at: now,
            content: content.into(),
            tags,
        })
        .await?;
    Ok(format!(
        "Nostr {}",
        STANDARD.encode(
            serde_json::to_vec(&event).map_err(|_| "Could not encode media authentication")?
        )
    ))
}

/// A cancel may overtake its upload IPC. Pending IDs expire because a cancel
/// can also arrive after completion or after an upload was rejected before start.
const PENDING_CANCEL_LIFETIME: Duration = Duration::from_secs(60);
#[derive(Default)]
struct UploadState {
    active: HashMap<String, oneshot::Sender<()>>,
    pending: HashMap<String, Instant>,
}
#[derive(Default)]
pub(crate) struct Uploads(std::sync::Mutex<UploadState>);

impl Uploads {
    fn lock(&self) -> std::sync::MutexGuard<'_, UploadState> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Registers `id`, or returns `None` when it was already cancelled.
    fn start(&self, id: &str) -> Result<Option<oneshot::Receiver<()>>> {
        let mut uploads = self.lock();
        if uploads.pending.remove(id).is_some() {
            return Ok(None);
        }
        if uploads.active.contains_key(id) {
            return Err("Upload is already in progress".into());
        }
        if uploads.active.len() >= 64 {
            return Err("Uploads are busy".into());
        }
        let (sender, receiver) = oneshot::channel();
        uploads.active.insert(id.into(), sender);
        Ok(Some(receiver))
    }

    fn cancel(&self, id: &str) {
        let mut uploads = self.lock();
        if let Some(sender) = uploads.active.remove(id) {
            let _ = sender.send(());
            return;
        }
        let now = Instant::now();
        uploads
            .pending
            .retain(|_, inserted| now.duration_since(*inserted) < PENDING_CANCEL_LIFETIME);
        if uploads.pending.contains_key(id) {
            uploads.pending.insert(id.into(), now);
            return;
        }
        if uploads.pending.len() >= 64 {
            // With independent IPC calls we cannot distinguish an old cancel
            // from one that overtook its upload. Retire an arbitrary old pending
            // ID so a new cancellation still has a bounded chance to win.
            if let Some(old) = uploads.pending.keys().next().cloned() {
                uploads.pending.remove(&old);
            }
        }
        uploads.pending.insert(id.into(), now);
    }

    pub(crate) fn cancel_all(&self) {
        for (_, sender) in self.lock().active.drain() {
            let _ = sender.send(());
        }
    }

    fn finish(&self, id: &str) {
        self.lock().active.remove(id);
    }
}

fn upload_id(value: Option<&str>) -> Result<&str> {
    value
        .filter(|id| {
            (1..=64).contains(&id.len())
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .ok_or_else(|| "Invalid upload ID".into())
}

/// Allocate only host-owned storage; callers never supply filesystem paths.
#[tauri::command]
pub(crate) async fn relay_upload_begin<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    size: usize,
) -> Result<()> {
    use tauri::Manager as _;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Spools>()
            .begin(&app.state::<Uploads>(), &id, size)
    })
    .await
    .map_err(|_| "Upload receiving could not complete")?
}

/// One acknowledged IPC chunk at a time. Bound and validate in the host too.
#[tauri::command]
pub(crate) async fn relay_upload_chunk<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<()> {
    use tauri::Manager as _;
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let id = upload_id(header("x-buzz-upload-id"))?.to_owned();
    let chunk: Result<_> = (|| {
        let offset = header("x-buzz-upload-offset")
            .and_then(|v| v.parse::<usize>().ok())
            .ok_or("Invalid upload chunk")?;
        let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
            return Err("Upload body must be raw bytes".into());
        };
        if body.is_empty() || body.len() > UPLOAD_CHUNK {
            return Err("Invalid upload chunk".into());
        }
        Ok((offset, body.clone()))
    })();
    tauri::async_runtime::spawn_blocking(move || {
        let spools = app.state::<Spools>();
        let uploads = app.state::<Uploads>();
        let result = chunk.and_then(|(offset, bytes)| spools.append(&id, offset, &bytes));
        if result.is_err() {
            spools.cancel(&uploads, &id);
        }
        result
    })
    .await
    .map_err(|_| "Upload receiving could not complete")?
}

/// Finalize the received spool, convert on disk when requested, and stream it.
#[tauri::command]
pub(crate) async fn relay_upload<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    fi: tauri::State<'_, FederatedIdentity>,
    host: tauri::State<'_, IdentityHost>,
    uploads: tauri::State<'_, Uploads>,
    spools: tauri::State<'_, Spools>,
    request: tauri::ipc::Request<'_>,
) -> Result<RelayResponse> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let id = upload_id(header("x-buzz-upload-id"))?;
    let result = async {
        let progress = header("x-buzz-upload-progress")
            .map(|value| {
                value
                    .parse::<tauri::ipc::JavaScriptChannelId>()
                    .map(|channel| channel.channel_on(webview))
                    .map_err(|_| "Invalid upload progress channel".to_string())
            })
            .transpose()?;
        let url = origin(header("x-buzz-community").unwrap_or_default())?
            .join("/upload")
            .map_err(|_| "Invalid relay path")?;
        let (spool, mut cancelled) = spools.take(id)?;
        process_spool(
            host.inner(),
            Some(fi.inner()),
            url,
            spool,
            (header("x-buzz-content-type"), header("x-buzz-preparation")),
            progress,
            &mut cancelled,
        )
        .await
    }
    .await;
    spools.discard(id);
    uploads.finish(id);
    result
}

async fn process_spool(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    url: Url,
    spool: upload_spool::Spool,
    (kind, preparation): (Option<&str>, Option<&str>),
    progress: Option<UploadProgress>,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<RelayResponse> {
    if cancelled.try_recv().is_ok() {
        return Err("Upload cancelled".into());
    }
    let (path, kind) = if let Some(mode) = preparation {
        match media_preparation::prepare_file(
            &spool.source(),
            spool.size,
            spool.directory.path(),
            mode,
            cancelled,
        )
        .await
        {
            Ok(value) => (value.0, Some(value.1)),
            Err(media_preparation::PreparationError::Cancelled) => {
                return Err("Upload cancelled".into())
            }
            Err(error) => {
                return Ok(RelayResponse {
                    status: error.status(),
                    headers: BTreeMap::new(),
                    body: serde_json::json!({"code": error.code()}).to_string(),
                })
            }
        }
    } else {
        (spool.source(), kind)
    };
    let hash = if path == spool.source() {
        (spool.size, spool.hash.clone())
    } else {
        // Hash in bounded blocks; the spool remains owned until it settles.
        let path = path.clone();
        tokio::task::spawn_blocking(move || upload_spool::hash_file(&path))
            .await
            .map_err(|_| "Upload hashing could not complete")??
    };
    tokio::select! {
        result = upload_file(host, fi, url, kind, path, hash, progress) => result,
        _ = &mut *cancelled => Err("Upload cancelled".into()),
    }
}

#[tauri::command]
pub(crate) fn relay_upload_cancel(
    uploads: tauri::State<'_, Uploads>,
    spools: tauri::State<'_, Spools>,
    id: String,
) -> Result<()> {
    let id = upload_id(Some(&id))?;
    // Never free a processing slot until the running future has stopped.
    spools.cancel(&uploads, id);
    Ok(())
}

fn validate_upload_size(size: usize) -> Result<()> {
    if size == 0 || size > MAX_UPLOAD {
        return Err("File exceeds the supported upload limit".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct UploadSent {
    sent: u64,
    total: u64,
}
type UploadProgress = tauri::ipc::Channel<UploadSent>;
const UPLOAD_CHUNK: usize = 64 * 1024;

fn file_chunks(
    file: std::fs::File,
    total: u64,
    report: impl Fn(UploadSent) + Send + Sync + 'static,
) -> impl futures_util::Stream<Item = std::io::Result<bytes::Bytes>> + Send {
    use std::io::Read;
    let report = std::sync::Arc::new(report);
    futures_util::stream::try_unfold((file, 0u64, None), move |(mut file, sent, reported)| {
        let mut buffer = vec![0; UPLOAD_CHUNK];
        let report = report.clone();
        async move {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                if sent != total {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "Upload spool was truncated",
                    ));
                }
                return Ok(None);
            }
            let sent = sent + read as u64;
            if sent > total {
                return Err(std::io::Error::other("Upload spool changed"));
            }
            let percent = sent * 100 / total;
            if reported != Some(percent) {
                report(UploadSent { sent, total });
            }
            buffer.truncate(read);
            Ok(Some((
                bytes::Bytes::from(buffer),
                (file, sent, Some(percent)),
            )))
        }
    })
}

async fn upload_file(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    url: Url,
    kind: Option<&str>,
    path: std::path::PathBuf,
    (size, hash): (usize, String),
    progress: Option<UploadProgress>,
) -> Result<RelayResponse> {
    let assertion = evidence(host, fi, &url).await?;
    upload_file_authorized(
        host,
        AuthorizationContext {
            fi,
            assertion: assertion.as_ref(),
        },
        url,
        kind,
        path,
        (size, hash),
        progress,
    )
    .await
}

async fn upload_file_authorized(
    host: &IdentityHost,
    authorization: AuthorizationContext<'_>,
    url: Url,
    kind: Option<&str>,
    path: std::path::PathBuf,
    (size, hash): (usize, String),
    progress: Option<UploadProgress>,
) -> Result<RelayResponse> {
    validate_upload_size(size)?;
    let kind = kind
        .filter(|kind| valid_type(kind))
        .unwrap_or("application/octet-stream");
    let file = std::fs::File::open(path)
        .map_err(|_| "Media preparation could not access temporary storage")?;
    let auth = blossom_auth(
        host,
        &url,
        "upload",
        "Upload attachment",
        vec![vec!["x".into(), hash.clone()]],
    )
    .await?;
    let mut request = client()?.put(url);
    if let Some(header) = authorization.assertion.and_then(Authorization::header) {
        request = request.header(HEADER, header);
    }
    let operation = async {
        let response = request
            .timeout(Duration::from_secs(600))
            .header("Authorization", auth)
            .header("Content-Type", kind)
            .header("X-SHA-256", hash)
            .header(reqwest::header::CONTENT_LENGTH, size)
            .body(reqwest::Body::wrap_stream(file_chunks(
                file,
                size as u64,
                move |sent| {
                    if let Some(channel) = &progress {
                        let _ = channel.send(sent);
                    }
                },
            )))
            .send()
            .await
            .map_err(|_| "Upload did not finish")?;
        if response.status() == 401 {
            if let (Some(fi), Some(assertion)) = (
                authorization.fi,
                authorization
                    .assertion
                    .and_then(|authorization| authorization.assertion.as_ref()),
            ) {
                fi.reject_assertion(assertion).await;
            }
        }
        if let Some(reason) = authorization
            .assertion
            .and_then(|authorization| authorization.refusal(response.status().as_u16()))
        {
            return Err(reason.into());
        }
        read_response(response, 8192).await
    };
    if let (Some(fi), Some(assertion)) = (authorization.fi, authorization.assertion) {
        fi.during_admitted_operation(host, assertion, true, operation)
            .await?
    } else {
        operation.await
    }
}

/// Largest whole-file media response buffered in memory: the relay's document
/// limit, which also covers images. Video is read by `Range`; an origin that
/// ignores it is spooled to disk up to `WHOLE_VIDEO_MAX` instead.
const MAX_MEDIA: usize = 100 * 1024 * 1024;
/// Largest file the app may save for itself: an agent snapshot PNG.
const FILE_DOWNLOAD_MAX: usize = 10 * 1024 * 1024;
/// Largest video an origin that ignores `Range` may send whole: 500 MiB, the
/// development broker's video limit. A video of exactly this size plays; a
/// larger `Content-Length` gets 413 before any download, and a response
/// without one is stopped and rejected with 413 once it passes this size.
/// On macOS it also bounds a download from the native media menu. Edit this
/// value to change the limit; it is compiled into the binary.
pub(crate) const WHOLE_VIDEO_MAX: u64 = 500 * 1024 * 1024;
/// Open-ended ranges are shortened so playback starts after one small chunk;
/// the media element requests the next range itself.
const MEDIA_CHUNK: u64 = 4 * 1024 * 1024;
/// Only `media_blocks` sends `Range`, always for one block, so a 206 is never
/// buffered past it.
const MAX_MEDIA_RANGE: usize = media_blocks::BLOCK as usize;

/// `buzz-media://` serves relay `GET /media/*` to `<img>`, `<video>` and
/// `<audio>`, which cannot send the required Blossom `Authorization` header.
/// Each request gets a fresh `get` token and forwards only the player's
/// `Range`, so playback streams and seeks. Which URLs use it is decided in
/// shared TypeScript (`mediaUrl`); this checks only the relay-blob URL shape,
/// not saved-community membership (Rust keeps no community list).
pub(crate) fn media_protocol<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::Manager as _;
    let host = ctx.app_handle().state::<IdentityHost>().inner().clone();
    // Like Tauri's asset protocol, let the requesting window (only) read the
    // bytes, e.g. to sample avatar colors; `<img>` display never needed it.
    let origin = ctx
        .app_handle()
        .get_webview_window(ctx.webview_label())
        .and_then(|webview| webview.url().ok())
        .and_then(|url| window_origin(&url));
    let fi = ctx
        .app_handle()
        .state::<FederatedIdentity>()
        .inner()
        .clone();
    tauri::async_runtime::spawn(async move {
        let response = match media_request(&request) {
            Ok((url, Some((start, end)))) => {
                media_blocks::read(&host, Some(&fi), &url, start, end, WHOLE_VIDEO_MAX).await
            }
            Ok((url, None)) => fetch_media(&host, Some(&fi), url, None).await,
            Err(status) => Err(status),
        };
        let mut response = response.unwrap_or_else(|status| {
            tauri::http::Response::builder()
                .status(status)
                .body(Vec::new())
                .expect("static response")
        });
        if let Some(origin) = origin {
            response
                .headers_mut()
                .insert("Access-Control-Allow-Origin", origin);
        }
        responder.respond(response);
    });
}

/// The serialized origin of a window's page (`tauri://localhost`,
/// `http://tauri.localhost`, or the dev server). Pages without a host get none.
fn window_origin(url: &Url) -> Option<tauri::http::HeaderValue> {
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    tauri::http::HeaderValue::from_str(&format!("{}://{host}{port}", url.scheme())).ok()
}

/// Decode only the custom scheme URLs emitted by convertFileSrc. The media URL
/// is independently checked before any authenticated request is made.
pub(crate) fn download_target(source: &str) -> Option<Url> {
    let url = Url::parse(source).ok()?;
    let host_ok = match url.scheme() {
        "buzz-media" => url.host_str() == Some("localhost"),
        "http" => url.host_str() == Some("buzz-media.localhost"),
        _ => false,
    };
    if !host_ok
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let target = percent_encoding::percent_decode_str(url.path().strip_prefix('/')?)
        .decode_utf8()
        .ok()?;
    media_url(&target)
}

/// Never interpret untrusted attachment names as paths. A missing or invalid name
/// falls back to the validated blob's basename.
pub(crate) fn download_name<'a>(name: &'a str, url: &'a Url) -> &'a str {
    if safe_download_name(name) {
        name
    } else {
        url.path().rsplit('/').next().unwrap_or("media")
    }
}

/// A plain file name on every desktop platform, never a path.
fn safe_download_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("");
    let reserved = stem.trim_end_matches(' ').to_ascii_uppercase();
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !matches!(
            reserved.as_str(),
            "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
        && !name.chars().any(|c| {
            c.is_control()
                || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                    | '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}')
        })
}

/// Fail closed if the OS cannot mark the file as untrusted internet content.
#[cfg(target_os = "macos")]
pub(crate) fn mark_download(file: &std::fs::File, _path: &std::path::Path) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_secs();
    let value = format!("0081;{timestamp:x};Buzz;");
    let result = unsafe {
        libc::fsetxattr(
            file.as_raw_fd(),
            c"com.apple.quarantine".as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn mark_download(_file: &std::fs::File, path: &std::path::Path) -> std::io::Result<()> {
    // Alternate data streams are attached to the same NTFS file, not a sibling.
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    std::fs::write(stream, b"[ZoneTransfer]\r\nZoneId=3\r\n")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn mark_download(_file: &std::fs::File, _path: &std::path::Path) -> std::io::Result<()> {
    Ok(())
}

/// `filename`, then `stem (1).ext` up to `stem (999).ext`: the names a
/// download tries in turn while each is taken. `Ada.agent.png` counts as
/// `Ada (1).agent.png`, which still reads as a snapshot by its suffix.
pub(crate) fn download_names(filename: &str) -> impl Iterator<Item = String> + '_ {
    let (stem, ext) = filename
        .find(".agent.")
        .or_else(|| filename.rfind('.'))
        .filter(|&at| at > 0)
        .map_or((filename, ""), |at| (&filename[..at], &filename[at + 1..]));
    (0..1000).map(move |index| {
        if index == 0 {
            filename.to_owned()
        } else if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        }
    })
}

fn save_download(
    directory: &std::path::Path,
    filename: &str,
    body: &[u8],
) -> Result<std::path::PathBuf> {
    use std::io::Write as _;
    for candidate in download_names(filename) {
        let path = directory.join(candidate);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = mark_download(&file, &path)
                    .and_then(|_| file.write_all(body))
                    .and_then(|_| file.sync_all())
                {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("Could not save media: {error}"));
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not save media: {error}")),
        }
    }
    Err("Too many files with this name".into())
}

/// `image` bounds the WebP canvas but its VP8 decoder allocates Y/U/V planes
/// from the embedded frame header before comparing that frame to the canvas.
/// Inspect every embedded lossy frame (including ANMF subchunks) before decode.
fn check_webp_vp8_frames(bytes: &[u8], max_bytes: usize) -> Result<()> {
    fn chunks(
        mut bytes: &[u8],
        max_bytes: usize,
        animated_frame: bool,
        mut expected: Option<(usize, usize)>,
    ) -> Result<()> {
        let mut alpha_successor = false;
        let mut frame_chunk_seen = false;
        while !bytes.is_empty() {
            let header = bytes.get(..8).ok_or("Could not decode image")?;
            let size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            let end = 8usize.checked_add(size).ok_or("Could not decode image")?;
            let next = end.checked_add(size & 1).ok_or("Could not decode image")?;
            let payload = bytes.get(8..end).ok_or("Could not decode image")?;
            if bytes.get(..next).is_none() {
                return Err("Could not decode image".into());
            }
            if animated_frame && alpha_successor && &header[..4] != b"VP8 " {
                return Err("Could not decode image".into());
            }
            if animated_frame && frame_chunk_seen {
                return Err("Could not decode image".into());
            }
            if animated_frame
                && !alpha_successor
                && &header[..4] != b"ALPH"
                && &header[..4] != b"VP8 "
                && &header[..4] != b"VP8L"
            {
                return Err("Could not decode image".into());
            }
            match &header[..4] {
                b"VP8 " => {
                    let frame = payload.get(..10).ok_or("Could not decode image")?;
                    if frame[0] & 1 != 0 || &frame[3..6] != b"\x9d\x01\x2a" {
                        return Err("Could not decode image".into());
                    }
                    let width = usize::from(u16::from_le_bytes([frame[6], frame[7]]) & 0x3fff);
                    let height = usize::from(u16::from_le_bytes([frame[8], frame[9]]) & 0x3fff);
                    // The locked VP8 decoder allocates three padded Y/U/V planes
                    // before comparing the embedded frame with its canvas.
                    let plane_bytes = width
                        .div_ceil(16)
                        .checked_mul(height.div_ceil(16))
                        .and_then(|blocks| blocks.checked_mul(16 * 16 + 2 * 8 * 8))
                        .ok_or("Image too large to copy")?;
                    if width == 0 || height == 0 || plane_bytes > max_bytes {
                        return Err("Image too large to copy".into());
                    }
                    if expected.is_some_and(|dimensions| dimensions != (width, height)) {
                        return Err("Could not decode image".into());
                    }
                    frame_chunk_seen = true;
                }
                b"VP8L" if animated_frame => {
                    frame_chunk_seen = true;
                }
                b"ALPH" if animated_frame => {
                    // `image-webp` decodes the successor payload as VP8 even when
                    // its chunk tag is not VP8; require the tag we validated.
                    alpha_successor = true;
                    if bytes.len().saturating_sub(next) < 8 {
                        return Err("Could not decode image".into());
                    }
                }
                b"VP8X" if !animated_frame => {
                    let canvas = payload.get(..10).ok_or("Could not decode image")?;
                    let width = usize::from(canvas[4])
                        | (usize::from(canvas[5]) << 8)
                        | (usize::from(canvas[6]) << 16);
                    let height = usize::from(canvas[7])
                        | (usize::from(canvas[8]) << 8)
                        | (usize::from(canvas[9]) << 16);
                    expected = Some((width + 1, height + 1));
                }
                b"ANMF" if !animated_frame => {
                    let frame = payload.get(..16).ok_or("Could not decode image")?;
                    let width = usize::from(frame[6])
                        | (usize::from(frame[7]) << 8)
                        | (usize::from(frame[8]) << 16);
                    let height = usize::from(frame[9])
                        | (usize::from(frame[10]) << 8)
                        | (usize::from(frame[11]) << 16);
                    chunks(
                        &payload[16..],
                        max_bytes,
                        true,
                        Some((width + 1, height + 1)),
                    )?;
                }
                _ => {}
            }
            bytes = &bytes[next..];
        }
        if animated_frame && !frame_chunk_seen {
            return Err("Could not decode image".into());
        }
        Ok(())
    }

    let header = bytes.get(..12).ok_or("Could not decode image")?;
    if &header[..4] != b"RIFF" || &header[8..12] != b"WEBP" {
        return Err("Could not decode image".into());
    }
    let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
    let end = riff_size.checked_add(8).ok_or("Could not decode image")?;
    if end != bytes.len() {
        return Err("Could not decode image".into());
    }
    let body = bytes.get(12..end).ok_or("Could not decode image")?;
    chunks(body, max_bytes, false, None)
}

/// Decode only formats the gallery can paste, with a bound on both encoded and
/// expanded bytes. The URL extension and remote Content-Type are not evidence.
fn clipboard_pixels(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>)> {
    const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image too large to copy".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "Could not decode image")?;
    if format == image::ImageFormat::WebP {
        check_webp_vp8_frames(bytes, MAX_IMAGE_BYTES)?;
    }
    if !matches!(
        format,
        image::ImageFormat::Png
            | image::ImageFormat::Jpeg
            | image::ImageFormat::WebP
            | image::ImageFormat::Gif
    ) {
        return Err("Could not decode image".into());
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_IMAGE_BYTES as u64);
    reader.limits(limits);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "Could not decode image")?;
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .filter(|size| *size <= MAX_IMAGE_BYTES)
        .ok_or("Image too large to copy")?;
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_IMAGE_BYTES as u64);
    reader.limits(limits);
    let rgba = reader
        .decode()
        .map_err(|_| "Could not decode image")?
        .to_rgba8()
        .into_raw();
    if rgba.len() != pixels {
        return Err("Could not decode image".into());
    }
    Ok((width as usize, height as usize, rgba))
}

/// The host owns authenticated media access and the OS clipboard. Never hand
/// bearer tokens or privileged fetch capability to the webview.
#[tauri::command]
pub(crate) async fn media_copy_image<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    source: String,
) -> Result<()> {
    let url = download_target(&source).ok_or("Invalid media URL")?;
    let response = fetch_media(host.inner(), Some(fi.inner()), url, None)
        .await
        .map_err(|_| "Could not fetch image")?;
    if !response
        .headers()
        .get("Content-Type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|kind| kind.starts_with("image/") && kind != "image/svg+xml")
    {
        return Err("Could not decode image".into());
    }
    let pixels = tauri::async_runtime::spawn_blocking(move || clipboard_pixels(response.body()))
        .await
        .map_err(|_| "Could not decode image".to_owned())??;
    crate::clipboard::write_image(&app, pixels.0, pixels.1, pixels.2).await
}

/// Persist an authenticated bounded response without replacing an existing file.
/// The host, not the webview, owns the save path and collision policy.
#[tauri::command]
pub(crate) async fn media_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    source: String,
    name: String,
) -> Result<()> {
    use tauri::Manager as _;
    let allowed = match webview.label() {
        "main" => true,
        "huddle" => app
            .try_state::<crate::huddle_window::HuddleWindow>()
            .is_some_and(|host| host.permits_download(&source, &name)),
        _ => false,
    };
    if !allowed {
        return Err("This attachment is no longer available in this window".into());
    }
    let url = download_target(&source).ok_or("Invalid media URL")?;
    let filename = download_name(&name, &url).to_owned();
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "Downloads unavailable")?;
    let response = fetch_media(host.inner(), Some(fi.inner()), url, None)
        .await
        .map_err(|_| "Media download failed")?;
    let body = response.into_body();
    tauri::async_runtime::spawn_blocking(move || save_download(&directory, &filename, &body))
        .await
        .map_err(|_| "Media download interrupted".to_owned())??;
    Ok(())
}

/// Saves an agent snapshot the app built to Downloads as media is saved, and
/// returns where. WKWebView cannot save a `blob:` link without a sandbox failure.
#[tauri::command]
pub(crate) async fn file_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<String> {
    use tauri::Manager as _;
    let filename = request
        .headers()
        .get("x-buzz-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .ok()
        })
        .filter(|name| {
            safe_download_name(name)
                && (name.ends_with(".agent.png") || name.ends_with(".agent.json"))
        })
        .ok_or("Invalid file name")?
        .into_owned();
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("File body must be raw bytes".into());
    };
    if body.is_empty() || body.len() > FILE_DOWNLOAD_MAX {
        return Err("Invalid file".into());
    }
    let body = body.clone();
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "Downloads unavailable")?;
    let path =
        tauri::async_runtime::spawn_blocking(move || save_download(&directory, &filename, &body))
            .await
            .map_err(|_| "Download interrupted".to_owned())??;
    Ok(path.to_string_lossy().into_owned())
}

/// `buzz-media://localhost/<percent-encoded relay media URL>`, the shape of
/// `convertFileSrc(url, "buzz-media")` on every desktop platform.
fn media_request(
    request: &tauri::http::Request<Vec<u8>>,
) -> std::result::Result<(Url, Option<(u64, u64)>), u16> {
    if request.method() != tauri::http::Method::GET {
        return Err(405);
    }
    let encoded = request.uri().path().strip_prefix('/').ok_or(400u16)?;
    let target = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| 400u16)?;
    let url = media_url(&target).ok_or(403u16)?;
    let range = match request.headers().get("range") {
        None => None,
        Some(value) => Some(media_range(value.to_str().map_err(|_| 416u16)?).ok_or(416u16)?),
    };
    Ok((url, range))
}

/// Only relay-hosted blobs on an HTTPS origin; never an arbitrary URL.
fn media_url(target: &str) -> Option<Url> {
    let url = Url::parse(target).ok()?;
    let name = url.path().strip_prefix("/media/")?;
    let (hash, extension) = name.split_once('.').unwrap_or((name, ""));
    let extension_ok = extension.is_empty()
        || extension == "thumb.jpg"
        || (extension.len() <= 8
            && extension
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    let mut base = url.clone();
    base.set_path("/");
    (origin(base.as_str()).is_ok()
        && url.query().is_none()
        && url.fragment().is_none()
        && hash.len() == 64
        && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && extension_ok)
        .then_some(url)
}

/// One `bytes=START-[END]` range, bounded so a response fits one buffer.
fn media_range(value: &str) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let last = start.checked_add(MEDIA_CHUNK - 1)?;
    let end = if end.is_empty() {
        last
    } else {
        end.parse::<u64>().ok()?.min(last)
    };
    (end >= start).then_some((start, end))
}

async fn fetch_media(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    url: Url,
    range: Option<String>,
) -> std::result::Result<tauri::http::Response<Vec<u8>>, u16> {
    fetch_media_bounded(host, fi, url, range, MAX_MEDIA).await
}

async fn fetch_media_bounded(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    url: Url,
    range: Option<String>,
    max_bytes: usize,
) -> std::result::Result<tauri::http::Response<Vec<u8>>, u16> {
    let assertion = evidence(host, fi, &url).await.map_err(|_| 401u16)?;
    let operation = async {
        buffer_media(
            send_media(host, fi, assertion.as_ref(), url, range.as_deref()).await?,
            max_bytes,
        )
        .await
    };
    if let (Some(fi), Some(assertion)) = (fi, assertion.as_ref()) {
        fi.during_admitted_operation(host, assertion, false, operation)
            .await
            .map_err(|_| 401u16)?
    } else {
        operation.await
    }
}

/// One freshly signed upstream GET; only a 200 or 206 is returned.
async fn send_media(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    assertion: Option<&Authorization>,
    url: Url,
    range: Option<&str>,
) -> std::result::Result<reqwest::Response, u16> {
    let auth = blossom_auth(host, &url, "get", "Get buzz-media", Vec::new())
        .await
        .map_err(|_| 401u16)?;
    let mut request = client()
        .map_err(|_| 502u16)?
        .get(url)
        // Match the broker's whole-media deadline; large documents may take minutes.
        .timeout(Duration::from_secs(600))
        .header("Authorization", auth);
    if let Some(range) = range {
        request = request.header("Range", range);
    }
    admit(host, fi, assertion).await.map_err(|_| 401u16)?;
    if let Some(header) = assertion.and_then(Authorization::header) {
        request = request.header(HEADER, header);
    }
    let upstream = request.send().await.map_err(|_| 502u16)?;
    let status = upstream.status().as_u16();
    if status == 401 {
        if let (Some(fi), Some(assertion)) = (
            fi,
            assertion.and_then(|authorization| authorization.assertion.as_ref()),
        ) {
            fi.reject_assertion(assertion).await;
        }
    }
    if !matches!(status, 200 | 206) {
        return Err(status);
    }
    Ok(upstream)
}

/// The response type of an upstream media response, as `media_type` decides it.
fn upstream_type(upstream: &reqwest::Response) -> (String, bool) {
    media_type(
        upstream
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
    )
}

/// Headers every `buzz-media` response carries, for an upstream `Content-Type`.
fn media_headers(kind: String, disposition: bool) -> tauri::http::response::Builder {
    let response = tauri::http::Response::builder()
        .header("Content-Type", kind)
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "private, max-age=3600")
        .header("X-Content-Type-Options", "nosniff");
    if disposition {
        response.header("Content-Disposition", "attachment")
    } else {
        response
    }
}

async fn buffer_media(
    mut upstream: reqwest::Response,
    max_bytes: usize,
) -> std::result::Result<tauri::http::Response<Vec<u8>>, u16> {
    let status = upstream.status().as_u16();
    let limit = if status == 206 {
        MAX_MEDIA_RANGE.min(max_bytes)
    } else {
        max_bytes
    };
    if upstream
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(413);
    }
    let (kind, disposition) = upstream_type(&upstream);
    let mut response = media_headers(kind, disposition).status(status);
    if let Some(value) = upstream
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
    {
        response = response.header("Content-Range", value);
    }
    let mut body = Vec::new();
    while let Some(chunk) = upstream.chunk().await.map_err(|_| 502u16)? {
        if body.len() + chunk.len() > limit {
            return Err(413);
        }
        body.extend_from_slice(&chunk);
    }
    response.body(body).map_err(|_| 502)
}

fn valid_type(kind: &str) -> bool {
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    kind.split_once('/')
        .is_some_and(|(a, b)| token(a) && token(b))
}

/// Mirrors the dev broker's `/api/relay/media`: render images (never SVG),
/// video and audio; everything else is a download.
fn media_type(value: Option<&str>) -> (String, bool) {
    let kind = value
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let inline = valid_type(&kind)
        && ((kind.starts_with("image/") && kind != "image/svg+xml")
            || kind.starts_with("video/")
            || kind.starts_with("audio/"));
    if inline {
        (kind, false)
    } else {
        ("application/octet-stream".into(), true)
    }
}
#[cfg(test)]
mod tests;
