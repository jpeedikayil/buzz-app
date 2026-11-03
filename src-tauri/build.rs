#[path = "../crates/build_env.rs"]
mod build_env;
#[path = "src/build_resources.rs"]
mod build_resources;
#[path = "src/enterprise_adapter_url.rs"]
mod enterprise_adapter_url;
#[path = "src/enterprise_auth_build.rs"]
mod enterprise_auth_build;
#[path = "src/enterprise_relay_url.rs"]
mod enterprise_relay_url;
#[path = "src/federated_identity/config.rs"]
#[allow(dead_code)]
mod federated_identity_config;
#[path = "src/nsec_backup_config.rs"]
mod nsec_backup_config;

fn main() {
    configure_nsec_backup();
    configure_federated_identity();
    configure_enterprise_auth();
    // Release builds enable the updater only when both values are supplied; its
    // `plugins.updater` config comes from the same values via `tauri build --config`.
    println!("cargo:rerun-if-env-changed=BUZZ_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=BUZZ_UPDATER_ENDPOINT");
    println!("cargo:rustc-check-cfg=cfg(buzz_updater_enabled)");
    let configured = |name| std::env::var(name).is_ok_and(|value| !value.trim().is_empty());
    if configured("BUZZ_UPDATER_PUBLIC_KEY") && configured("BUZZ_UPDATER_ENDPOINT") {
        println!("cargo:rustc-cfg=buzz_updater_enabled");
    }
    // tauri-build watches only the resource files present when it ran, so watch
    // the directory too: the ordinary goose-acp is staged after a first `cargo check`.
    println!("cargo:rerun-if-changed=resources/bin");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_resources::prepare_executables(
            std::path::Path::new("resources/bin"),
            &std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR")),
        )
        .expect("Could not prepare executable resources");
    }
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri's resource linker covers bin targets, not the lib unit-test EXE.
        // Link the same manifest into both without changing icons/version resources.
        // https://github.com/tauri-apps/tauri/issues/13419
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(
        attributes.app_manifest(tauri_build::AppManifest::new().commands(&[
            "huddle_window_reset_incoming",
            "huddle_window_open",
            "huddle_window_update",
            "huddle_window_watch",
            "huddle_window_action",
            "huddle_open",
            "huddle_close",
            "huddle_pcm",
            "huddle_touch",
            "pairing_account",
            "pairing_start",
            "pairing_status",
            "pairing_confirm",
            "pairing_deny",
            "pairing_cancel",
            "identity_restore",
            "identity_import",
            "identity_legacy_available",
            "identity_import_legacy",
            "identity_create",
            "onboarding_preserve_window",
            "identity_export",
            "nsec_backup_available",
            "nsec_backup_session",
            "nsec_backup_retry",
            "nsec_backup_state",
            "nsec_backup_watch",
            "nsec_restore_begin",
            "nsec_restore_wait",
            "nsec_restore_install",
            "nsec_restore_cancel",
            "nsec_backup_choice",
            "nsec_backup_set_choice",
            "sign_out",
            "sign_out_wipe_refusal",
            "identity_prepare_remote_agent_authorization",
            "identity_sign_builderlab_binding",
            "federated_identity_snapshot",
            "federated_identity_sign_in",
            "federated_identity_cancel_sign_in",
            "federated_identity_sign_out",
            "federated_identity_register",
            "federated_identity_unregister",
            "federated_identity_request",
            "relay_socket_connect",
            "relay_socket_start",
            "relay_socket_send",
            "relay_socket_close",
            "relay_sign",
            "relay_decode_read_state",
            "relay_sign_read_state",
            "relay_publish_read_state",
            "relay_http",
            "relay_http_cancel",
            "relay_verify_signatures",
            "relay_workflow_runs",
            "relay_admin_discover",
            "relay_admin_request",
            "relay_admin_attachment",
            "relay_admin_save_attachment",
            "relay_project_git",
            "relay_project_git_cancel",
            "relay_channel_sign",
            "relay_channel_publish",
            "relay_kit_sign",
            "relay_kit_prepare",
            "relay_kit_decode",
            "relay_direct_message",
            "relay_decode_sidebar",
            "relay_sign_sidebar",
            "relay_decode_reminders",
            "relay_sign_reminder",
            "relay_agent_resolve",
            "relay_git_authorization",
            "relay_agent_log_proof",
            "relay_agent_observer",
            "relay_archive",
            "relay_agent_memories_read",
            "relay_agent_library",
            "relay_upload_begin",
            "relay_upload_chunk",
            "relay_upload",
            "relay_upload_cancel",
            "media_download",
            "file_download",
            "media_copy_image",
            "clipboard_write_text",
            "media_stream_base",
            "get_os_idle_seconds",
            "workspace_pick_folder",
            "repositories_folder_validate",
            "legacy_communities",
            "plugin_import_folder",
            "plugin_update_check",
            "plugin_update_preview",
            "plugin_import_git",
            "plugin_import_install",
            "plugin_import_discard",
            "plugin_catalog",
            "plugin_change",
            "plugin_reload",
            "plugin_module",
            "plugin_recover",
            "plugin_host_run_command",
            "plugin_host_call_context",
            "plugin_host_request",
            "plugin_host_request_bytes",
            "plugin_host_upload_bytes_once",
            "plugin_host_save_bytes",
            "plugin_host_delete_managed_file",
            "plugin_host_upload",
            "plugin_host_process_spawn",
            "plugin_host_process_write",
            "plugin_host_process_kill",
            "plugin_host_mcp_serve",
            "plugin_host_mcp_authorize",
            "plugin_host_mcp_reply",
            "plugin_host_mcp_close",
            "plugin_host_read_file",
            "plugin_host_resolve_directory",
            "oauth_callback_begin",
            "oauth_callback_wait",
            "oauth_callback_cancel",
            "oauth_callback_complete",
            "app_agent_list",
            "app_agent_set_protection",
            "app_agent_protection_defaults",
            "app_agent_set_protection_defaults",
            "app_agent_create",
            "app_agent_portable",
            "app_agent_port",
            "app_agent_rename",
            "app_agent_set_picture",
            "app_agent_set_type",
            "app_agent_delete",
            "app_agent_begin_delete",
            "app_agent_begin_leave",
            "app_agent_hold_removal",
            "app_agent_release_removal",
            "app_agent_join",
            "app_agent_forget",
            "app_agent_publish",
            "app_agent_publish_profile",
            "app_agent_query",
            "app_agent_search_profiles",
            "app_agent_upload",
            "app_agent_media",
            "app_agent_git_auth",
            "app_agent_remember",
            "app_agent_claim",
            "app_agent_release",
            "jev_classifier_status",
            "jev_classifier_set_key",
            "jev_classifier_clear_key",
            "app_agent_state_load",
            "app_agent_state_set",
            "decide",
            "title_bar_double_click",
            "notification_show",
            "notification_permission_state",
            "request_notification_access",
            "dock_permission",
            "unread_indicator_set",
            "keep_awake_set",
            "deep_link_take",
            "deep_link_watch",
            "terminal_create_owner",
            "terminal_spawn",
            "terminal_read",
            "terminal_write",
            "terminal_resize",
            "terminal_close",
            "terminal_close_owner",
            "update_restart",
            "browser_attach",
            "browser_set_bounds",
            "browser_detach",
            "browser_navigate",
            "browser_action",
            "browser_status",
        ])),
    )
    .expect("Could not build Tauri resources")
}

fn configure_nsec_backup() {
    const SERVICE: &str = "BUZZ_NSEC_BACKUP_SERVICE_URL";
    const NAMESPACE: &str = "BUZZ_NSEC_BACKUP_NAMESPACE";
    println!("cargo:rerun-if-env-changed={SERVICE}");
    println!("cargo:rerun-if-env-changed={NAMESPACE}");
    let service = std::env::var(SERVICE).ok();
    let namespace = std::env::var(NAMESPACE).ok();
    if let Some(config) = nsec_backup_config::configured(service.as_deref(), namespace.as_deref())
        .unwrap_or_else(|error| panic!("{error}"))
    {
        println!("cargo:rustc-env={SERVICE}={}", config.service_url);
        println!("cargo:rustc-env={NAMESPACE}={}", config.namespace);
    }
}

fn configure_enterprise_auth() {
    const RELAYS: &str = "BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS";
    const ADAPTER: &str = "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL";
    println!("cargo:rerun-if-env-changed={RELAYS}");
    println!("cargo:rerun-if-env-changed={ADAPTER}");

    let relays = std::env::var(RELAYS).ok();
    let adapter = std::env::var(ADAPTER).ok();
    let configured = enterprise_auth_build::validate_enterprise_auth_build_config(
        relays.as_deref(),
        adapter.as_deref(),
    )
    .unwrap_or_else(|error| panic!("{error}"));

    if let Some(relays) = configured.relays.as_deref() {
        println!("cargo:rustc-env={RELAYS}={relays}");
    }
    if let Some(adapter) = configured.adapter.as_deref() {
        println!("cargo:rustc-env={ADAPTER}={adapter}");
    }
}

fn configure_federated_identity() {
    const NAME: &str = "BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG";
    const BUILDERLAB_URL: &str = "BUZZ_BUILDERLAB_URL";
    println!("cargo:rerun-if-env-changed={NAME}");
    println!("cargo:rerun-if-env-changed={BUILDERLAB_URL}");
    let local = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../.env.local");
    println!("cargo:rerun-if-changed={}", local.display());
    let added = std::env::var(NAME).ok();
    if added.as_deref().is_some_and(|raw| !raw.is_empty()) {
        for legacy in [
            BUILDERLAB_URL,
            "BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS",
            "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL",
        ] {
            if std::env::var(legacy).is_ok_and(|value| !value.is_empty()) {
                panic!("{legacy} must be removed when {NAME} is configured");
            }
        }
    }
    // The Builderlab URL is read as the plugin manager reads it, .env.local included.
    let builderlab_url = build_env::load(&local, &[BUILDERLAB_URL], |key| std::env::var(key).ok())
        .unwrap_or_else(|error| panic!("{error}"))
        .remove(BUILDERLAB_URL);
    let servers = federated_identity_config::compiled(added.as_deref(), builderlab_url.as_deref())
        .unwrap_or_else(|error| panic!("{error}"));
    if !servers.is_empty() {
        println!(
            "cargo:rustc-env={NAME}={}",
            serde_json::to_string(&servers).expect("public descriptors")
        );
    }
}
