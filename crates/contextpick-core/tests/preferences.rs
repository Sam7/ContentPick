use contextpick_core::preferences::{Preferences, SavedWorkspace};
use contextpick_core::{selection::Intent, workspace::FilterPolicy};
use std::collections::BTreeMap;

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
fn missing_settings_use_defaults_and_oversized_settings_fail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    assert!(Preferences::load(&path).unwrap().recent_root.is_none());
    std::fs::write(&path, vec![b' '; 4 * 1024 * 1024 + 1]).unwrap();
    assert!(Preferences::load(&path).is_err());
}
