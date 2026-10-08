use contextpick_core::{
    destination::Destination,
    export,
    preferences::{Preferences, SavedWorkspace},
    workspace::{FilterPolicy, Workspace},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::AtomicBool,
};

#[test]
fn repeated_in_root_exports_are_excluded_after_settings_reload() {
    let root = tempfile::tempdir().unwrap();
    let config = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(root.path().join("README.md"), "# Context\n").unwrap();
    let original = std::fs::read(root.path().join("main.rs")).unwrap();
    let cancel = AtomicBool::new(false);
    let mut registry = BTreeSet::new();
    let settings = config.path().join("settings.json");
    let key = std::fs::canonicalize(root.path())
        .unwrap()
        .display()
        .to_string();
    let mut exported = vec![];
    for name in ["context.md", "context-2.md"] {
        let workspace = Workspace::scan_with_outputs(
            root.path(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            registry.clone(),
            &cancel,
        )
        .unwrap();
        let manifest = workspace.manifest();
        assert_eq!(
            manifest
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["README.md", "main.rs"]
        );
        let output = root.path().join(name);
        let prepared = Destination::prepare(&workspace.root_handle, &output, false).unwrap();
        registry.insert(prepared.relative_path().unwrap().to_owned());
        let preferences = Preferences {
            recent_root: Some(key.clone()),
            workspaces: BTreeMap::from([(
                key.clone(),
                SavedWorkspace {
                    generated_outputs: registry.clone(),
                    ..Default::default()
                },
            )]),
            ..Default::default()
        };
        preferences.save(&settings).unwrap();
        let result =
            export::export_prepared(&workspace.root_handle, &manifest, prepared, &cancel).unwrap();
        let bytes = std::fs::read(&output).unwrap();
        assert_eq!(result.bytes, bytes.len() as u64);
        assert_eq!(result.files, 2);
        exported.push(bytes);
        registry = Preferences::load(&settings).unwrap().workspaces[&key]
            .generated_outputs
            .clone();
    }
    assert_eq!(exported[0], exported[1]);
    assert_eq!(
        std::fs::read(root.path().join("main.rs")).unwrap(),
        original
    );
    let restored = Workspace::scan_with_outputs(
        root.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        registry,
        &cancel,
    )
    .unwrap();
    assert_eq!(restored.manifest().len(), 2);
    assert!(
        restored
            .view(1)
            .entries
            .iter()
            .filter(|entry| entry.path.starts_with("context"))
            .all(|entry| !entry.selected
                && entry
                    .reason
                    .as_deref()
                    .unwrap()
                    .contains("generated output"))
    );
}

#[test]
fn deleted_input_and_cancelled_export_publish_no_output_or_temporary_sibling() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("main.rs"), "fn main() {}\n").unwrap();
    let workspace = Workspace::scan(
        root.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let manifest = workspace.manifest();
    let output = root.path().join("context.md");
    assert!(
        export::export_to(
            &workspace.root_handle,
            &manifest,
            &output,
            false,
            &AtomicBool::new(true)
        )
        .is_err()
    );
    assert!(!output.exists());
    std::fs::remove_file(root.path().join("main.rs")).unwrap();
    let error = export::export_to(
        &workspace.root_handle,
        &manifest,
        &output,
        false,
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert!(error.to_string().contains("main.rs"));
    assert!(!output.exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn outside_destination_hard_link_does_not_modify_source_content() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source = root.path().join("main.rs");
    let output = outside.path().join("context.md");
    std::fs::write(&source, "fn main() {}\n").unwrap();
    std::fs::hard_link(&source, &output).unwrap();
    let workspace = Workspace::scan(
        root.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    export::export_to(
        &workspace.root_handle,
        &workspace.manifest(),
        &output,
        true,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(source).unwrap(), "fn main() {}\n");
    assert!(
        std::fs::read_to_string(output)
            .unwrap()
            .starts_with("# ContextPick export")
    );
}
