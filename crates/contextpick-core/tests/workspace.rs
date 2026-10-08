use contextpick_core::selection::Intent;
use contextpick_core::workspace::{FilterPolicy, Workspace};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::AtomicBool;

#[test]
fn prunes_ignored_subtree_but_keeps_explainable_placeholder() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("dist/deep")).unwrap();
    std::fs::write(temp.path().join(".gitignore"), "dist/\n").unwrap();
    std::fs::write(temp.path().join("dist/deep/generated.ts"), "secret fixture").unwrap();
    std::fs::write(temp.path().join("main.ts"), "hello").unwrap();
    let workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let view = workspace.view(1);
    assert!(
        view.entries
            .iter()
            .any(|e| e.path == "main.ts" && e.selected)
    );
    let ignored = view.entries.iter().find(|e| e.path == "dist").unwrap();
    assert!(!ignored.enumerated);
    assert!(ignored.reason.as_deref().unwrap().contains("dist/"));
    assert!(!view.entries.iter().any(|e| e.path.contains("generated")));
    assert_eq!(workspace.enumerated_entries, 3);
    assert!(view.incomplete);
}

#[test]
fn nested_gitignore_and_toggle_preserve_explicit_intent() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("src")).unwrap();
    std::fs::write(
        temp.path().join("src/.gitignore"),
        "*.generated.ts\n!keep.generated.ts\n",
    )
    .unwrap();
    for name in ["a.generated.ts", "keep.generated.ts", "normal.ts"] {
        std::fs::write(temp.path().join("src").join(name), "text").unwrap();
    }
    let intents = BTreeMap::from([("src/normal.ts".into(), Intent::Exclude)]);
    let w = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        intents.clone(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let view = w.view(2);
    assert!(
        !view
            .entries
            .iter()
            .find(|e| e.path == "src/a.generated.ts")
            .unwrap()
            .selected
    );
    assert!(
        view.entries
            .iter()
            .find(|e| e.path == "src/keep.generated.ts")
            .unwrap()
            .selected
    );
    let policy = FilterPolicy {
        gitignore: false,
        ..Default::default()
    };
    let w = Workspace::scan(
        temp.path(),
        policy,
        intents.clone(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(w.intents, intents);
    assert!(
        w.view(3)
            .entries
            .iter()
            .find(|e| e.path == "src/a.generated.ts")
            .unwrap()
            .selected
    );
    assert!(
        !w.view(3)
            .entries
            .iter()
            .find(|e| e.path == "src/normal.ts")
            .unwrap()
            .selected
    );
}

#[test]
fn force_include_discovers_only_required_ignored_ancestors() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("dist/nested")).unwrap();
    std::fs::create_dir_all(temp.path().join("dist/unrelated/deep")).unwrap();
    std::fs::write(temp.path().join(".gitignore"), "dist/\n").unwrap();
    std::fs::write(temp.path().join("dist/nested/one.ts"), "text").unwrap();
    std::fs::write(temp.path().join("dist/unrelated/deep/two.ts"), "text").unwrap();
    let intents = BTreeMap::from([("dist/nested/one.ts".into(), Intent::ForceInclude)]);
    let w = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        intents,
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        w.manifest()
            .iter()
            .filter(|e| e.path.contains("dist"))
            .map(|e| e.path.as_str())
            .collect::<Vec<_>>(),
        vec!["dist/nested/one.ts"]
    );
    assert!(!w.view(1).entries.iter().any(|e| e.path.contains("two.ts")));
    let view = w.view(1);
    let directory = view.entries.iter().find(|e| e.path == "dist").unwrap();
    assert!(!directory.enumerated);
    assert!(directory.partial);
}

#[test]
fn custom_exclusion_wins_include_and_force_respects_binary_guard() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("main.ts"), "text").unwrap();
    std::fs::write(temp.path().join("image.png"), [0, 1, 2]).unwrap();
    let policy = FilterPolicy {
        include_paths: vec!["**/*.ts".into()],
        exclude_paths: vec!["main.ts".into()],
        ..Default::default()
    };
    let mut w = Workspace::scan(
        temp.path(),
        policy,
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(w.view(1).selected_count, 0);
    w.intents.insert("main.ts".into(), Intent::ForceInclude);
    w.intents.insert("image.png".into(), Intent::ForceInclude);
    assert_eq!(w.manifest().len(), 1);
    assert_eq!(w.manifest()[0].path, "main.ts");
}

#[test]
fn forced_exception_does_not_unfilter_its_siblings() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("dist")).unwrap();
    std::fs::write(temp.path().join("dist/one.ts"), "one").unwrap();
    std::fs::write(temp.path().join("dist/two.ts"), "two").unwrap();
    let policy = FilterPolicy {
        exclude_paths: vec!["dist".into()],
        ..Default::default()
    };
    let intents = BTreeMap::from([("dist/one.ts".into(), Intent::ForceInclude)]);
    let w = Workspace::scan(
        temp.path(),
        policy,
        intents,
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        w.manifest()
            .iter()
            .map(|e| e.path.as_str())
            .collect::<Vec<_>>(),
        vec!["dist/one.ts"]
    );
}

#[test]
fn view_presents_a_hierarchical_folder_first_tree_but_manifest_stays_lexical() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("zeta/inner")).unwrap();
    std::fs::create_dir(temp.path().join("alpha")).unwrap();
    for path in [
        "zeta/inner/leaf.ts",
        "zeta/root.ts",
        "alpha/item.ts",
        "beta.ts",
        "aardvark.ts",
    ] {
        std::fs::write(temp.path().join(path), "text").unwrap();
    }

    let workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();

    assert_eq!(
        workspace
            .view(1)
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "alpha",
            "alpha/item.ts",
            "zeta",
            "zeta/inner",
            "zeta/inner/leaf.ts",
            "zeta/root.ts",
            "aardvark.ts",
            "beta.ts",
        ]
    );
    assert_eq!(
        workspace
            .manifest()
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "aardvark.ts",
            "alpha/item.ts",
            "beta.ts",
            "zeta/inner/leaf.ts",
            "zeta/root.ts",
        ]
    );
}

#[test]
fn soft_exclusion_defers_unknown_extension_sampling_until_force_include() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("payload.opaque"),
        b"text\0with binary marker",
    )
    .unwrap();
    let policy = FilterPolicy {
        exclude_paths: vec!["**/*.opaque".into()],
        ..Default::default()
    };

    let excluded = Workspace::scan(
        temp.path(),
        policy.clone(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let entry = excluded
        .view(1)
        .entries
        .into_iter()
        .find(|entry| entry.path == "payload.opaque")
        .unwrap();
    assert_eq!(entry.kind, "file");
    assert_eq!(entry.reason.as_deref(), Some("custom exclude: **/*.opaque"));

    let forced = Workspace::scan(
        temp.path(),
        policy,
        BTreeMap::from([("payload.opaque".into(), Intent::ForceInclude)]),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let entry = forced
        .view(2)
        .entries
        .into_iter()
        .find(|entry| entry.path == "payload.opaque")
        .unwrap();
    assert_eq!(entry.kind, "blocked");
    assert_eq!(
        entry.reason.as_deref(),
        Some("binary or unsupported encoding")
    );
}
