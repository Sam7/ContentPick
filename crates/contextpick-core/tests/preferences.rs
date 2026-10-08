use contextpick_core::preferences::{Preferences, SavedWorkspace};
use contextpick_core::{selection::Intent, workspace::FilterPolicy};
use std::collections::{BTreeMap, BTreeSet};

#[test]
fn preferences_roundtrip_preserves_policy_and_intents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut prefs = Preferences {
        recent_root: Some("synthetic-root".into()),
        ..Default::default()
    };
    prefs.workspaces.insert(
        "synthetic-root".into(),
        SavedWorkspace {
            policy: FilterPolicy {
                gitignore: false,
                ..Default::default()
            },
            intents: BTreeMap::from([("src".into(), Intent::Exclude)]),
            generated_outputs: BTreeSet::from(["release/context.md".into()]),
        },
    );
    prefs.save(&path).unwrap();
    let restored = Preferences::load(&path).unwrap();
    assert_eq!(restored.recent_root, prefs.recent_root);
    assert!(!restored.workspaces["synthetic-root"].policy.gitignore);
    assert_eq!(
        restored.workspaces["synthetic-root"].intents["src"],
        Intent::Exclude
    );
    assert_eq!(
        restored.workspaces["synthetic-root"].generated_outputs,
        BTreeSet::from(["release/context.md".into()])
    );
}

#[test]
fn saved_workspace_without_generated_outputs_loads_as_empty_registry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(
        &path,
        r#"{"version":1,"recentRoot":"legacy-root","workspaces":{"legacy-root":{"policy":{"gitignore":true,"includeExtensions":[],"excludeExtensions":[],"includePaths":[],"excludePaths":[]},"intents":{}}}}"#,
    )
    .unwrap();

    let restored = Preferences::load(&path).unwrap();
    assert!(
        restored.workspaces["legacy-root"]
            .generated_outputs
            .is_empty()
    );
}

#[test]
fn corrupt_or_future_settings_are_rejected_and_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    for text in [
        "{invalid",
        "{\"version\":999,\"recentRoot\":null,\"workspaces\":{}}",
    ] {
        std::fs::write(&path, text).unwrap();
        assert!(Preferences::load(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }
}

#[test]
fn recovery_backs_up_corrupt_and_future_settings_before_starting_with_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let invalid_settings = [
        "{invalid",
        r#"{"version":999,"recentRoot":null,"workspaces":{}}"#,
    ];
    let mut backups = Vec::new();

    for text in invalid_settings {
        std::fs::write(&path, text).unwrap();
        let recovered = Preferences::load_with_recovery(&path);
        assert_eq!(recovered.preferences.version, 1);
        assert!(recovered.preferences.recent_root.is_none());
        assert!(recovered.preferences.workspaces.is_empty());
        assert!(!recovered.saving_blocked);
        assert!(recovered.notice.as_deref().unwrap().contains("backup"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);

        let backup_dir = dir.path().join("settings-recovery");
        let backup = std::fs::read_dir(backup_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|backup| !backups.contains(backup))
            .expect("recovery should create a new unique backup");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), text);
        backups.push(backup);
    }

    assert_ne!(backups[0], backups[1]);
}

#[test]
fn backup_failure_returns_defaults_with_actionable_notice_and_blocks_saving() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = "{corrupt but readable";
    std::fs::write(&path, original).unwrap();
    std::fs::write(
        dir.path().join("settings-recovery"),
        "prevents backup directory",
    )
    .unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert_eq!(recovered.preferences.version, 1);
    assert!(recovered.preferences.recent_root.is_none());
    assert!(recovered.preferences.workspaces.is_empty());
    assert!(recovered.saving_blocked);
    let notice = recovered.notice.unwrap().to_ascii_lowercase();
    assert!(notice.contains("backup"));
    assert!(notice.contains("saving"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn missing_settings_use_defaults_and_oversized_settings_fail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    assert!(Preferences::load(&path).unwrap().recent_root.is_none());
    let recovery = Preferences::load_with_recovery(&path);
    assert_eq!(recovery.preferences.version, 1);
    assert!(recovery.preferences.recent_root.is_none());
    assert!(recovery.preferences.workspaces.is_empty());
    assert!(recovery.notice.is_none());
    assert!(!recovery.saving_blocked);
    let oversized = vec![b' '; 4 * 1024 * 1024 + 1];
    std::fs::write(&path, &oversized).unwrap();
    assert!(Preferences::load(&path).is_err());
    let recovery = Preferences::load_with_recovery(&path);
    assert!(recovery.saving_blocked);
    assert!(
        recovery
            .notice
            .unwrap()
            .contains("Saving settings is disabled")
    );
    assert_eq!(std::fs::read(&path).unwrap(), oversized);
    assert!(!dir.path().join("settings-recovery").exists());
}

#[test]
fn oversized_save_preserves_previous_settings_and_removes_temporary_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    Preferences::default().save(&path).unwrap();
    let previous = std::fs::read(&path).unwrap();

    let oversized = Preferences {
        workspaces: BTreeMap::from([(
            "large-root".into(),
            SavedWorkspace {
                policy: FilterPolicy {
                    include_paths: vec!["x".repeat(4 * 1024 * 1024 + 1)],
                    ..Default::default()
                },
                ..Default::default()
            },
        )]),
        ..Default::default()
    };

    assert!(oversized.save(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), previous);
    let remaining = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(remaining, vec![std::ffi::OsString::from("settings.json")]);
}
