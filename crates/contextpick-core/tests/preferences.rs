use contextpick_core::preferences::{
    MAX_PROFILE_NAME_BYTES, MAX_PROFILES_PER_WORKSPACE, Preferences, SavedProfile, SavedWorkspace,
};
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
            profiles: BTreeMap::new(),
            active_profile: None,
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
fn policy_mode_roundtrips_with_stable_serialized_values() {
    use contextpick_core::workspace::IncludeMode;

    let policy = FilterPolicy {
        include_mode: IncludeMode::SelectedExtensions,
        include_extensions: vec![".Rs".into()],
        ..Default::default()
    };
    let value = serde_json::to_value(&policy).unwrap();
    assert_eq!(value["includeMode"], "selectedExtensions");
    assert_eq!(
        serde_json::from_value::<FilterPolicy>(value).unwrap(),
        policy
    );
}

#[test]
fn v3_policy_reset_preserves_intents_and_allowlists_in_workspaces_and_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"version":3,"recentRoot":"root","workspaces":{"root":{"policy":{"gitignore":false,"includeExtensions":[".Rs"],"includePaths":["src/**"],"excludePaths":["vendor/**"]},"intents":{"src":"forceInclude","secret.txt":"exclude"},"generatedOutputs":[],"profiles":{"Rust":{"policy":{"includeExtensions":[".TS"],"includePaths":["**/*.ts"],"excludePaths":["tmp/**"]},"intents":{"docs":"include"}}},"activeProfile":null}}}"#;
    std::fs::write(&path, original).unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(!recovered.saving_blocked);
    let notice = recovered.notice.as_deref().unwrap();
    assert!(notice.contains("custom filter settings"));
    assert_eq!(recovered.preferences.version, 4);
    let saved = &recovered.preferences.workspaces["root"];
    assert_eq!(saved.policy.include_extensions, [".Rs"]);
    assert_eq!(
        saved.policy.include_mode,
        contextpick_core::workspace::IncludeMode::SelectedExtensions
    );
    assert!(saved.policy.include_paths.is_empty());
    assert!(saved.policy.exclude_paths.is_empty());
    assert_eq!(saved.intents["src"], Intent::ForceInclude);
    assert_eq!(saved.intents["secret.txt"], Intent::Exclude);
    let profile = &saved.profiles["Rust"];
    assert_eq!(profile.policy.include_extensions, [".TS"]);
    assert_eq!(
        profile.policy.include_mode,
        contextpick_core::workspace::IncludeMode::SelectedExtensions
    );
    assert!(profile.policy.include_paths.is_empty());
    assert!(profile.policy.exclude_paths.is_empty());
    assert_eq!(profile.intents["docs"], Intent::Include);

    let backup = std::fs::read_dir(dir.path().join("settings-recovery"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(std::fs::read_to_string(backup).unwrap(), original);
    assert!(Preferences::load_with_recovery(&path).notice.is_none());
}

#[test]
fn v2_settings_migrate_once_and_preserve_every_workspace_field() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"version":2,"recentRoot":"root-a","workspaces":{"root-a":{"policy":{"gitignore":false,"includeExtensions":[".rs"],"includePaths":["src/**"],"excludePaths":["target/**"]},"intents":{"src":"forceInclude","README.md":"exclude"},"generatedOutputs":["out/context.md"]},"root-b":{"policy":{},"intents":{"docs":"include"},"generatedOutputs":[]}}}"#;
    std::fs::write(&path, original).unwrap();

    let migrated = Preferences::load_with_recovery(&path);

    assert!(
        migrated
            .notice
            .as_deref()
            .unwrap()
            .contains("custom filter settings")
    );
    assert!(!migrated.saving_blocked);
    assert_eq!(migrated.preferences.version, 4);
    assert_eq!(migrated.preferences.recent_root.as_deref(), Some("root-a"));
    assert_eq!(migrated.preferences.workspaces.len(), 2);
    let first = &migrated.preferences.workspaces["root-a"];
    assert!(!first.policy.gitignore);
    assert_eq!(
        first.policy.include_mode,
        contextpick_core::workspace::IncludeMode::SelectedExtensions
    );
    assert_eq!(first.policy.include_extensions, [".rs"]);
    assert!(first.policy.include_paths.is_empty());
    assert!(first.policy.exclude_paths.is_empty());
    assert_eq!(first.intents["src"], Intent::ForceInclude);
    assert_eq!(first.intents["README.md"], Intent::Exclude);
    assert_eq!(
        first.generated_outputs,
        BTreeSet::from(["out/context.md".into()])
    );
    assert!(first.profiles.is_empty());
    assert!(first.active_profile.is_none());
    assert_eq!(
        migrated.preferences.workspaces["root-b"].intents["docs"],
        Intent::Include
    );
    assert!(
        migrated.preferences.workspaces["root-b"]
            .profiles
            .is_empty()
    );
    assert!(
        migrated.preferences.workspaces["root-b"]
            .active_profile
            .is_none()
    );

    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], 4);
    assert_eq!(
        saved["workspaces"]["root-a"]["generatedOutputs"][0],
        "out/context.md"
    );
    assert_eq!(
        saved["workspaces"]["root-a"]["profiles"],
        serde_json::json!({})
    );
    assert_eq!(
        std::fs::read_dir(dir.path().join("settings-recovery"))
            .unwrap()
            .count(),
        1
    );

    let loaded_again = Preferences::load_with_recovery(&path);
    assert!(loaded_again.notice.is_none());
    assert_eq!(loaded_again.preferences.version, 4);
    assert_eq!(
        std::fs::read_dir(dir.path().join("settings-recovery"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn invalid_v2_settings_are_backed_up_and_block_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"version":2,"recentRoot":"root","workspaces":{"root":{"policy":{"futureField":true}}}}"#;
    std::fs::write(&path, original).unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(recovered.saving_blocked);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    assert!(
        recovered
            .notice
            .unwrap()
            .contains("Version-2 settings migration failed")
    );
    let backups: Vec<_> = std::fs::read_dir(dir.path().join("settings-recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
}

#[test]
fn corrupt_and_noninteger_v2_versions_are_backed_up_and_block_writes() {
    for original in [
        r#"{"version":2,"recentRoot":"root","workspaces":{"root":#"#,
        r#"{"version":"2","recentRoot":"root","workspaces":{}}"#,
        r#"{"version":2.0,"recentRoot":"root","workspaces":{}}"#,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, original).unwrap();

        let recovered = Preferences::load_with_recovery(&path);

        assert!(recovered.saving_blocked, "{original}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(
            recovered
                .notice
                .unwrap()
                .contains("Version-2 settings migration failed")
        );
        let backups: Vec<_> = std::fs::read_dir(dir.path().join("settings-recovery"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
    }
}

#[test]
fn failed_v2_backup_preserves_original_and_blocks_saving() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"version":2,"recentRoot":"root","workspaces":{}}"#;
    std::fs::write(&path, original).unwrap();
    std::fs::write(dir.path().join("settings-recovery"), "blocks backup").unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(recovered.saving_blocked);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    assert!(
        recovered
            .notice
            .unwrap()
            .contains("Version-2 settings migration needs a backup")
    );
}

#[test]
fn v3_profiles_reject_noncanonical_names_and_unrecognized_fields() {
    for original in [
        r#"{"version":3,"recentRoot":"root","workspaces":{"root":{"policy":{},"intents":{},"profiles":{"  Rust  ":{"policy":{},"intents":{}}}}}}"#,
        r#"{"version":3,"recentRoot":"root","workspaces":{"root":{"policy":{},"intents":{},"profiles":{"Rust":{"policy":{},"intents":{},"generatedOutputs":[]}}}}}"#,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, original).unwrap();

        assert!(Preferences::load(&path).is_err(), "{original}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }
}

#[test]
fn workspace_profiles_roundtrip_named_policy_and_intent_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut prefs = Preferences::default();
    let first = prefs.workspaces.entry("root-a".into()).or_default();
    first.policy = FilterPolicy {
        gitignore: false,
        include_mode: contextpick_core::workspace::IncludeMode::SelectedExtensions,
        include_extensions: vec![".rs".into()],
        include_paths: vec!["src/**".into()],
        exclude_paths: vec!["target/**".into()],
    };
    first.intents = BTreeMap::from([
        ("src".into(), Intent::ForceInclude),
        ("README.md".into(), Intent::Exclude),
    ]);
    first.generated_outputs.insert("out/context.md".into());
    first.create_profile("Rust sources").unwrap();
    first.policy = FilterPolicy::default();
    first.intents.clear();
    first.create_profile("Documentation").unwrap();

    let second = prefs.workspaces.entry("root-b".into()).or_default();
    second.policy.gitignore = false;
    second.create_profile("Rust sources").unwrap();

    prefs.save(&path).unwrap();
    let restored = Preferences::load(&path).unwrap();

    let rust = &restored.workspaces["root-a"].profiles["Rust sources"];
    assert_eq!(
        restored.workspaces["root-a"].active_profile.as_deref(),
        Some("Documentation")
    );
    assert_eq!(
        restored.workspaces["root-b"].active_profile.as_deref(),
        Some("Rust sources")
    );
    assert!(!rust.policy.gitignore);
    assert_eq!(rust.policy.include_extensions, [".rs"]);
    assert_eq!(rust.policy.include_paths, ["src/**"]);
    assert_eq!(rust.policy.exclude_paths, ["target/**"]);
    assert_eq!(rust.intents["src"], Intent::ForceInclude);
    assert_eq!(rust.intents["README.md"], Intent::Exclude);
    assert!(
        restored.workspaces["root-a"].profiles["Documentation"]
            .intents
            .is_empty()
    );
    assert!(
        !restored.workspaces["root-b"].profiles["Rust sources"]
            .policy
            .gitignore
    );

    let serialized: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let profile = &serialized["workspaces"]["root-a"]["profiles"]["Rust sources"];
    assert!(profile.get("policy").is_some());
    assert!(profile.get("intents").is_some());
    assert!(profile.get("root").is_none());
    assert!(profile.get("generatedOutputs").is_none());
}

#[test]
fn profile_name_and_capacity_failures_do_not_mutate_workspace() {
    let mut workspace = SavedWorkspace::default();

    for invalid in [
        String::new(),
        "   ".to_string(),
        "x".repeat(MAX_PROFILE_NAME_BYTES + 1),
    ] {
        let before = workspace.clone();
        assert!(workspace.create_profile(&invalid).is_err(), "{invalid:?}");
        assert_eq!(workspace, before);
    }

    workspace.create_profile("Base").unwrap();
    let before_duplicate = workspace.clone();
    assert!(workspace.create_profile(" Base ").is_err());
    assert_eq!(workspace, before_duplicate);

    for index in 1..MAX_PROFILES_PER_WORKSPACE {
        workspace
            .create_profile(&format!("Profile {index}"))
            .unwrap();
    }
    let at_capacity = workspace.clone();
    assert!(workspace.create_profile("One too many").is_err());
    assert_eq!(workspace, at_capacity);
}

#[test]
fn profile_update_rename_and_delete_are_validated_and_scoped() {
    let mut workspace = SavedWorkspace::default();
    workspace.policy.include_extensions = vec![".rs".into()];
    workspace.create_profile("Rust").unwrap();

    workspace.policy.include_extensions = vec![".md".into()];
    workspace.update_profile("Rust").unwrap();
    assert_eq!(
        workspace.profiles["Rust"].policy.include_extensions,
        [".md"]
    );

    workspace.create_profile("Docs").unwrap();
    let before_conflict = workspace.clone();
    assert!(workspace.rename_profile("Rust", " Docs ").is_err());
    assert_eq!(workspace, before_conflict);

    workspace.rename_profile("Rust", "Rust sources").unwrap();
    assert!(!workspace.profiles.contains_key("Rust"));
    assert!(workspace.profiles.contains_key("Rust sources"));
    workspace.rename_profile("Docs", "Guides").unwrap();
    assert_eq!(workspace.active_profile.as_deref(), Some("Guides"));
    workspace.delete_profile("Rust sources").unwrap();
    assert!(!workspace.profiles.contains_key("Rust sources"));
    assert_eq!(workspace.active_profile.as_deref(), Some("Guides"));
    workspace.delete_profile("Guides").unwrap();
    assert!(workspace.active_profile.is_none());
}

#[test]
fn activating_profile_changes_only_policy_and_intents_and_restores_active_name() {
    let mut workspace = SavedWorkspace {
        policy: FilterPolicy {
            gitignore: false,
            include_mode: contextpick_core::workspace::IncludeMode::SelectedExtensions,
            include_extensions: vec![".rs".into()],
            include_paths: vec!["src/**".into()],
            ..Default::default()
        },
        intents: BTreeMap::from([("src".into(), Intent::ForceInclude)]),
        generated_outputs: BTreeSet::from(["old-output.md".into()]),
        ..Default::default()
    };
    workspace.create_profile("Rust sources").unwrap();
    workspace.policy = FilterPolicy::default();
    workspace.intents.clear();
    workspace.generated_outputs.insert("new-output.md".into());

    workspace.activate_profile("Rust sources").unwrap();

    assert!(!workspace.policy.gitignore);
    assert_eq!(workspace.policy.include_extensions, [".rs"]);
    assert_eq!(workspace.policy.include_paths, ["src/**"]);
    assert_eq!(workspace.intents["src"], Intent::ForceInclude);
    assert_eq!(
        workspace.generated_outputs,
        BTreeSet::from(["old-output.md".into(), "new-output.md".into()])
    );
    assert_eq!(workspace.active_profile.as_deref(), Some("Rust sources"));
}

#[test]
fn invalid_profile_policy_is_rejected_without_mutation() {
    let mut workspace = SavedWorkspace {
        policy: FilterPolicy {
            include_paths: vec!["[".into()],
            ..Default::default()
        },
        ..Default::default()
    };
    let before = workspace.clone();

    assert!(workspace.create_profile("Invalid policy").is_err());
    assert_eq!(workspace, before);
}

#[test]
fn invalid_update_policy_keeps_existing_profile_unchanged() {
    let mut workspace = SavedWorkspace::default();
    workspace.policy.include_extensions = vec![".rs".into()];
    workspace.create_profile("Rust").unwrap();
    let before = workspace.clone();
    workspace.policy.include_paths = vec!["[".into()];

    assert!(workspace.update_profile("Rust").is_err());
    assert_eq!(workspace.profiles, before.profiles);
}

#[test]
fn preferences_save_rejects_excess_or_invalid_profiles_without_replacing_settings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    Preferences::default().save(&path).unwrap();
    let original = std::fs::read(&path).unwrap();

    let too_many_profiles = SavedWorkspace {
        profiles: (0..=MAX_PROFILES_PER_WORKSPACE)
            .map(|index| {
                (
                    format!("Profile {index}"),
                    SavedProfile {
                        policy: FilterPolicy::default(),
                        intents: BTreeMap::new(),
                    },
                )
            })
            .collect(),
        ..Default::default()
    };
    let too_many = Preferences {
        workspaces: BTreeMap::from([("root".into(), too_many_profiles)]),
        ..Default::default()
    };
    assert!(too_many.save(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);

    let invalid_profile = SavedWorkspace {
        profiles: BTreeMap::from([(
            "Invalid".into(),
            SavedProfile {
                policy: FilterPolicy {
                    include_paths: vec!["[".into()],
                    ..Default::default()
                },
                intents: BTreeMap::new(),
            },
        )]),
        ..Default::default()
    };
    let invalid = Preferences {
        workspaces: BTreeMap::from([("root".into(), invalid_profile)]),
        ..Default::default()
    };
    assert!(invalid.save(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);

    let mut stale_active = SavedWorkspace::default();
    stale_active.create_profile("Default").unwrap();
    stale_active.policy.gitignore = false;
    let mismatched_active = Preferences {
        workspaces: BTreeMap::from([("root".into(), stale_active)]),
        ..Default::default()
    };
    assert!(mismatched_active.save(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
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

    let restored = Preferences::load_with_recovery(&path).preferences;
    assert!(
        restored.workspaces["legacy-root"]
            .generated_outputs
            .is_empty()
    );
    assert!(restored.workspaces["legacy-root"].profiles.is_empty());
    assert!(restored.workspaces["legacy-root"].active_profile.is_none());
}

#[test]
fn v1_custom_policy_is_reset_transactionally_while_allowlists_and_intents_survive() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"version":1,"recentRoot":"legacy-root","workspaces":{"legacy-root":{"policy":{"gitignore":false,"includeExtensions":[".md"],"excludeExtensions":[".rS","rs","*?[",""],"includePaths":["src/**"],"excludePaths":["vendor/**","file-ext:literal","glob:foo"]},"intents":{"README.md":"include","src/generated":"exclude"},"generatedOutputs":["release/context.md"]}}}"#;
    std::fs::write(&path, original).unwrap();

    let recovered = Preferences::load_with_recovery(&path);
    assert!(
        recovered
            .notice
            .as_deref()
            .unwrap()
            .contains("custom filter settings")
    );
    assert!(!recovered.saving_blocked);
    assert_eq!(recovered.preferences.version, 4);
    assert_eq!(
        recovered.preferences.recent_root.as_deref(),
        Some("legacy-root")
    );
    let saved = &recovered.preferences.workspaces["legacy-root"];
    assert!(saved.profiles.is_empty());
    assert!(saved.active_profile.is_none());
    assert!(!saved.policy.gitignore);
    assert_eq!(
        saved.policy.include_mode,
        contextpick_core::workspace::IncludeMode::SelectedExtensions
    );
    assert_eq!(saved.policy.include_extensions, [".md"]);
    assert!(saved.policy.include_paths.is_empty());
    assert!(saved.policy.exclude_paths.is_empty());
    assert_eq!(saved.intents["README.md"], Intent::Include);
    assert_eq!(saved.intents["src/generated"], Intent::Exclude);
    assert_eq!(
        saved.generated_outputs,
        BTreeSet::from(["release/context.md".into()])
    );

    let persisted = std::fs::read_to_string(&path).unwrap();
    let json: serde_json::Value = serde_json::from_str(&persisted).unwrap();
    assert_eq!(json["version"], 4);
    assert_eq!(
        json["workspaces"]["legacy-root"]["policy"]["includeMode"],
        "selectedExtensions"
    );
    assert_eq!(
        Preferences::load(&path).unwrap().workspaces["legacy-root"]
            .policy
            .exclude_paths,
        saved.policy.exclude_paths
    );
    let backup_count = std::fs::read_dir(dir.path().join("settings-recovery"))
        .unwrap()
        .count();
    assert_eq!(backup_count, 1);
    let _ = Preferences::load_with_recovery(&path);
    assert_eq!(
        std::fs::read_dir(dir.path().join("settings-recovery"))
            .unwrap()
            .count(),
        backup_count
    );
}

#[test]
fn v1_settings_without_or_with_one_exclusion_migrate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    for settings in [
        r#"{"version":1,"recentRoot":"root","workspaces":{"root":{"policy":{}}}}"#,
        r#"{"version":1,"recentRoot":"root","workspaces":{"root":{"policy":{"excludeExtensions":[".lock"]}}}}"#,
    ] {
        std::fs::write(&path, settings).unwrap();
        let recovered = Preferences::load_with_recovery(&path);
        assert!(!recovered.saving_blocked);
        assert_eq!(
            recovered.preferences.workspaces["root"]
                .policy
                .exclude_paths,
            Vec::<String>::new()
        );
        let expected_mode = if settings.contains("includeExtensions") {
            contextpick_core::workspace::IncludeMode::SelectedExtensions
        } else {
            contextpick_core::workspace::IncludeMode::AllText
        };
        assert_eq!(
            recovered.preferences.workspaces["root"].policy.include_mode,
            expected_mode
        );
        assert_eq!(
            recovered.notice.is_some(),
            settings.contains("excludeExtensions")
        );
        assert_eq!(Preferences::load(&path).unwrap().version, 4);
    }
}

#[test]
fn v2_settings_without_removed_filter_rules_do_not_show_reset_notice() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(
        &path,
        r#"{"version":2,"recentRoot":"root","workspaces":{"root":{"policy":{"gitignore":true,"includeExtensions":[]},"intents":{},"generatedOutputs":[]}}}"#,
    )
    .unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(!recovered.saving_blocked);
    assert!(recovered.notice.is_none());
    assert_eq!(recovered.preferences.version, 4);
}

#[test]
fn invalid_legacy_exclusion_is_removed_and_allowlist_policy_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = format!(
        r#"{{"version":1,"recentRoot":null,"workspaces":{{"root":{{"policy":{{"excludeExtensions":["{}"]}},"intents":{{}}}}}}}}"#,
        "*".repeat(1400)
    );
    std::fs::write(&path, &original).unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(!recovered.saving_blocked);
    assert_eq!(recovered.preferences.version, 4);
    assert!(
        recovered.preferences.workspaces["root"]
            .policy
            .exclude_paths
            .is_empty()
    );
    assert!(recovered.notice.unwrap().contains("custom filter settings"));
    assert_eq!(
        std::fs::read_dir(dir.path().join("settings-recovery"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn failed_legacy_backup_preserves_original_and_blocks_saving() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"version":1,"recentRoot":"root","workspaces":{"root":{"policy":{"excludeExtensions":[".rs"]}}}}"#;
    std::fs::write(&path, original).unwrap();
    std::fs::write(dir.path().join("settings-recovery"), "blocks backup").unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(recovered.saving_blocked);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    let notice = recovered.notice.unwrap().to_ascii_lowercase();
    assert!(notice.contains("migration"));
    assert!(notice.contains("backup failed"));
}

#[test]
fn truncated_v1_settings_are_backed_up_and_never_replaced_with_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"version":1,"recentRoot":"root","workspaces":{"root":{"policy":{"excludeExtensions":[".rs"]"#;
    std::fs::write(&path, original).unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(recovered.saving_blocked);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    let notice = recovered.notice.unwrap().to_ascii_lowercase();
    assert!(notice.contains("migration"));
    assert!(notice.contains("backup"));
    assert_eq!(
        std::fs::read_dir(dir.path().join("settings-recovery"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn truncated_v1_with_escaped_version_key_is_backed_up_and_saving_stays_blocked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"ver\u0073ion":1,"recentRoot":"root","workspaces":{"root":{"policy":{"excludeExtensions":[".rs"]}"#;
    std::fs::write(&path, original).unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(recovered.saving_blocked);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    assert!(
        recovered
            .notice
            .unwrap()
            .contains("Version-1 settings migration failed")
    );
    let backups: Vec<_> = std::fs::read_dir(dir.path().join("settings-recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
}

#[test]
fn damaged_v1_without_opening_brace_is_backed_up_and_saving_stays_blocked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#""version":1,"recentRoot":"root","workspaces":{"root":{"policy":{"excludeExtensions":[".rs"]}"#;
    std::fs::write(&path, original).unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(recovered.saving_blocked);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    assert!(
        recovered
            .notice
            .unwrap()
            .contains("Version-1 settings migration failed")
    );
    let backups: Vec<_> = std::fs::read_dir(dir.path().join("settings-recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
}

#[test]
fn v1_version_written_as_a_decimal_is_backed_up_and_saving_stays_blocked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"version":1.0,"recentRoot":"root","workspaces":{"root":{"policy":{"excludeExtensions":[".rs"]}}}}"#;
    std::fs::write(&path, original).unwrap();

    let recovered = Preferences::load_with_recovery(&path);

    assert!(recovered.saving_blocked);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    assert!(
        recovered
            .notice
            .unwrap()
            .contains("Version-1 settings migration failed")
    );
}

#[test]
fn malformed_v1_version_string_and_numeric_prefix_fail_closed() {
    for original in [
        r#"{"version":"1","recentRoot":"root","workspaces":{}}"#,
        r#"{"version":1.,"recentRoot":"root","workspaces":{}}"#,
        r#"{"version":01,"recentRoot":"root","workspaces":{}}"#,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, original).unwrap();

        let recovered = Preferences::load_with_recovery(&path);

        assert!(recovered.saving_blocked, "{original}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(
            recovered
                .notice
                .unwrap()
                .contains("Version-1 settings migration failed")
        );
        let backups: Vec<_> = std::fs::read_dir(dir.path().join("settings-recovery"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
    }
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
        assert_eq!(recovered.preferences.version, 4);
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

    assert_eq!(recovered.preferences.version, 4);
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
    assert_eq!(recovery.preferences.version, 4);
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
