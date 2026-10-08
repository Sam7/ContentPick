use contextpick_core::{
    ManifestEntry, content, export,
    selection::Intent,
    workspace::{FilterPolicy, Workspace},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::AtomicBool,
};

#[cfg(unix)]
fn create_directory_link(link: &std::path::Path, target: &std::path::Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(windows)]
fn create_directory_link(link: &std::path::Path, target: &std::path::Path) {
    use std::process::Command;

    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            link.to_str().expect("junction path must be Unicode"),
            target.to_str().expect("junction target must be Unicode"),
        ])
        .status()
        .expect("could not launch cmd to create a junction");
    assert!(status.success(), "mklink /J failed with {status}");
}

#[test]
fn child_links_outside_workspace_and_cycles_are_never_traversed_or_opened() {
    let outside = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("main.rs"), "fn main() {}\n").unwrap();
    let sentinel = outside.path().join("sentinel.rs");
    std::fs::write(&sentinel, "outside secret sentinel\n").unwrap();

    let outside_link = root.path().join("outside");
    let cycle_link = root.path().join("cycle");
    create_directory_link(&outside_link, outside.path());
    create_directory_link(&cycle_link, root.path());

    let workspace = Workspace::scan(
        root.path(),
        FilterPolicy::default(),
        BTreeMap::from([
            ("outside/sentinel.rs".into(), Intent::ForceInclude),
            ("cycle/main.rs".into(), Intent::ForceInclude),
        ]),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let view = workspace.view(1);

    for link in ["outside", "cycle"] {
        let entry = view
            .entries
            .iter()
            .find(|entry| entry.path == link)
            .unwrap_or_else(|| panic!("missing link entry {link}"));
        assert_eq!(entry.kind, "blocked", "{link} should be blocked");
        assert!(
            entry
                .reason
                .as_deref()
                .unwrap_or_default()
                .contains("link/reparse point"),
            "{link} should explain why traversal is disabled"
        );
    }
    assert_eq!(
        view.entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["cycle", "main.rs", "outside"],
        "scan should stay bounded to the workspace's direct children"
    );
    assert_eq!(
        workspace
            .manifest()
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["main.rs"]
    );
    assert!(content::preview(&workspace.root_handle, "outside/sentinel.rs", 1024).is_err());
    assert!(content::preview(&workspace.root_handle, "cycle/main.rs", 1024).is_err());

    let outside_metadata = std::fs::metadata(&sentinel).unwrap();
    let forged_frozen_manifest = [ManifestEntry {
        path: "outside/sentinel.rs".into(),
        size: outside_metadata.len(),
        modified_ns: contextpick_core::modified_ns(&outside_metadata),
    }];
    let output = root.path().join("context.md");
    let error = export::export_to(
        &workspace.root_handle,
        &forged_frozen_manifest,
        &output,
        false,
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert!(error.to_string().contains("link or reparse point"));
    assert!(
        !output.exists(),
        "failed linked export must publish no output"
    );
    assert_eq!(
        std::fs::read_to_string(&sentinel).unwrap(),
        "outside secret sentinel\n"
    );

    #[cfg(windows)]
    {
        // Remove the junctions themselves before TempDir cleanup so Windows
        // never attempts to recursively clean up a junction target.
        std::fs::remove_dir(&cycle_link).unwrap();
        std::fs::remove_dir(&outside_link).unwrap();
    }
}
