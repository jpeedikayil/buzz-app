use std::path::{Path, PathBuf};

#[path = "../build_env.rs"]
mod build_env;

#[path = "../../src-tauri/src/federated_identity/config.rs"]
#[allow(dead_code)]
mod federated_identity_config;

const BUILDERLAB_URL_KEY: &str = "BUZZ_BUILDERLAB_URL";
const BUILDERLAB_APPS_DOMAIN_KEY: &str = "BUZZ_BUILDERLAB_APPS_DOMAIN";
const BUILDERLAB_API_BASE_PATH_KEY: &str = "BUZZ_BUILDERLAB_API_BASE_PATH";

fn builderlab_target(
    local: &Path,
    process: Option<String>,
) -> Result<(String, String), &'static str> {
    let values = build_env::load(local, &[BUILDERLAB_URL_KEY], |_| process.clone())?;
    let raw = values
        .get(BUILDERLAB_URL_KEY)
        .map(String::as_str)
        .unwrap_or("https://app.builderlab.xyz");
    if raw.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let url = url::Url::parse(raw).map_err(|_| "Invalid Builderlab build URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Builderlab build URL must use HTTPS without credentials, query, or fragment");
    }
    // Native backup handoff trusts Builderlab credentials only for this API
    // path, and decisions call under it. Drop one terminal slash, exactly as
    // sign-in's `oauthTarget` does, so all three share the same path.
    let path = url.path();
    let api_base_path = format!("{}/api/goose/", path.strip_suffix('/').unwrap_or(path));
    Ok((url.origin().ascii_serialization(), api_base_path))
}

fn builderlab_apps_domain(
    local: &Path,
    origin: &str,
    process: Option<String>,
) -> Result<String, &'static str> {
    let values = build_env::load(local, &[BUILDERLAB_APPS_DOMAIN_KEY], |_| process.clone())?;
    let domain = values
        .get(BUILDERLAB_APPS_DOMAIN_KEY)
        .map(String::as_str)
        .unwrap_or(if origin == "https://app.builderlab.xyz" {
            "apps.builderlab.xyz"
        } else {
            ""
        });
    if domain.is_empty() {
        return Ok(String::new());
    }
    let url = url::Url::parse(&format!("https://{domain}"))
        .map_err(|_| "Invalid Builderlab Apps build domain")?;
    if origin.is_empty()
        || !domain.contains('.')
        || domain.len() > 253
        || url.domain() != Some(domain)
        || domain.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return Err("Builderlab Apps build domain must be an exact DNS domain with a login origin");
    }
    Ok(domain.into())
}

#[cfg_attr(test, allow(dead_code))]
fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let local = root.join(".env.local");
    println!("cargo:rerun-if-changed={}", local.display());
    println!("cargo:rerun-if-env-changed={BUILDERLAB_URL_KEY}");
    println!("cargo:rerun-if-env-changed={BUILDERLAB_APPS_DOMAIN_KEY}");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("crates/build_env.rs").display()
    );
    let process = |key| match std::env::var(key) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("Native build inputs must be UTF-8"),
    };
    const FI: &str = "BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG";
    println!("cargo:rerun-if-env-changed={FI}");
    let added = process(FI);
    let builderlab_url = build_env::load(&local, &[BUILDERLAB_URL_KEY], |_| {
        process(BUILDERLAB_URL_KEY)
    })
    .expect("Invalid Builderlab build configuration")
    .remove(BUILDERLAB_URL_KEY);
    if added.as_deref().is_some_and(|raw| !raw.is_empty())
        && builderlab_url.as_deref().is_some_and(|url| !url.is_empty())
    {
        panic!("BUZZ_BUILDERLAB_URL must be removed when FI is configured");
    }
    // The build's Builderlab is its first sign-in server, when it has one.
    let fi = federated_identity_config::compiled(added.as_deref(), builderlab_url.as_deref())
        .expect("Invalid FI deployment descriptor")
        .into_iter()
        .next();
    println!(
        "cargo:rustc-env={FI}={}",
        fi.as_ref()
            .map(|config| serde_json::to_string(config).expect("public FI descriptor"))
            .unwrap_or_default()
    );
    // An FI build signs in to Builderlab through its NIP-FI identity origin.
    let (origin, api_base_path) = match &fi {
        Some(config) => (config.identity_origin.clone(), config.api_base_path.clone()),
        None => builderlab_target(&local, process(BUILDERLAB_URL_KEY))
            .expect("Invalid Builderlab build configuration"),
    };
    let apps_domain = builderlab_apps_domain(&local, &origin, process(BUILDERLAB_APPS_DOMAIN_KEY))
        .expect("Invalid Builderlab Apps build configuration");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_ORIGIN={origin}");
    println!("cargo:rustc-env={BUILDERLAB_API_BASE_PATH_KEY}={api_base_path}");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_APPS_DOMAIN={apps_domain}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_apps_domain_uses_trusted_build_input_and_public_default() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_apps_domain(&local, "https://app.builderlab.xyz", None).unwrap(),
            "apps.builderlab.xyz"
        );
        assert_eq!(
            builderlab_apps_domain(&local, "https://login.example", None).unwrap(),
            ""
        );
        std::fs::write(&local, "BUZZ_BUILDERLAB_APPS_DOMAIN=apps.example\n").unwrap();
        assert_eq!(
            builderlab_apps_domain(&local, "https://login.example", None).unwrap(),
            "apps.example"
        );
        assert_eq!(
            builderlab_apps_domain(
                &local,
                "https://login.example",
                Some("apps.other.example".into())
            )
            .unwrap(),
            "apps.other.example"
        );
        assert_eq!(
            builderlab_apps_domain(&local, "https://app.builderlab.xyz", Some(String::new()))
                .unwrap(),
            ""
        );
        for domain in [
            "com",
            "https://apps.example",
            "apps.example:443",
            "apps.example/path",
            "apps.example?query",
            "apps.example#part",
            "user@apps.example",
            "127.0.0.1",
            ".apps.example",
        ] {
            assert!(
                builderlab_apps_domain(&local, "https://login.example", Some(domain.into()))
                    .is_err()
            );
        }
        assert!(builderlab_apps_domain(&local, "", Some("apps.example".into())).is_err());
    }

    #[test]
    fn defaults_to_production_unless_explicitly_disabled() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            ("https://app.builderlab.xyz".into(), "/api/goose/".into())
        );
        assert_eq!(
            builderlab_apps_domain(&local, &builderlab_target(&local, None).unwrap().0, None)
                .unwrap(),
            "apps.builderlab.xyz"
        );
        assert_eq!(
            builderlab_target(&local, Some(String::new())).unwrap(),
            (String::new(), String::new())
        );
        std::fs::write(&local, "BUZZ_BUILDERLAB_URL=\n").unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            (String::new(), String::new())
        );
        assert_eq!(
            builderlab_apps_domain(&local, &builderlab_target(&local, None).unwrap().0, None)
                .unwrap(),
            ""
        );
    }

    #[test]
    fn local_url_and_process_overrides_produce_an_exact_origin_and_api_path() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            ("https://app.builderlab.xyz".into(), "/api/goose/".into())
        );
        std::fs::write(
            &local,
            "\u{feff}export BUZZ_BUILDERLAB_URL=\"https://OVERRIDE.EXAMPLE:443/deployment/\" # comment\n",
        )
        .unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            (
                "https://override.example".into(),
                "/deployment/api/goose/".into()
            )
        );
        assert_eq!(
            builderlab_target(&local, Some("https://login.example:8443/path/".into())).unwrap(),
            (
                "https://login.example:8443".into(),
                "/path/api/goose/".into()
            )
        );
        // Only one slash goes, as in sign-in, so an empty segment is kept.
        assert_eq!(
            builderlab_target(
                &local,
                Some("https://login.example:8443/deployment//".into())
            )
            .unwrap(),
            (
                "https://login.example:8443".into(),
                "/deployment//api/goose/".into()
            )
        );
        assert_eq!(
            builderlab_target(&local, Some(String::new())).unwrap(),
            (String::new(), String::new())
        );
    }

    #[test]
    fn invalid_configuration_fails_without_echoing_its_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        for configured in [
            "http://localhost:4318",
            "https://user:secret@login.example",
            "https://login.example?",
            "https://login.example#",
            "invalid",
        ] {
            let error = builderlab_target(&local, Some(configured.into())).unwrap_err();
            assert!(!error.contains(configured));
        }
        std::fs::write(&local, "BUZZ_BUILDERLAB_URL='unterminated").unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap_err(),
            "Invalid native build .env.local"
        );
        // Explicit process input also overrides malformed same-key assignments.
        assert_eq!(
            builderlab_target(&local, Some(String::new())).unwrap(),
            (String::new(), String::new())
        );
    }

    #[test]
    fn unrelated_syntax_is_ignored_without_promoting_multiline_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        std::fs::write(&local, "PRIVATE_VALUE='unterminated").unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            ("https://app.builderlab.xyz".into(), "/api/goose/".into())
        );

        for quote in ["'", "\"", "`"] {
            std::fs::write(
                &local,
                format!(
                    "PRIVATE_VALUE={quote}multiline\nBUZZ_BUILDERLAB_URL=https://hidden.example\n{quote}\nINVALID=unquoted value\nexport BUZZ_BUILDERLAB_URL=https://after-multiline.example/\nTRAILING='unfinished\n"
                ),
            )
            .unwrap();
            assert_eq!(
                builderlab_target(&local, None).unwrap(),
                (
                    "https://after-multiline.example".into(),
                    "/api/goose/".into()
                )
            );
        }
        for quote in ["'", "\""] {
            std::fs::write(
                &local,
                format!(
                    "PRIVATE_VALUE={quote}unfinished\nBUZZ_BUILDERLAB_URL=https://hidden.example\n"
                ),
            )
            .unwrap();
            assert_eq!(
                builderlab_target(&local, None).unwrap(),
                ("https://app.builderlab.xyz".into(), "/api/goose/".into())
            );
        }
    }
}
