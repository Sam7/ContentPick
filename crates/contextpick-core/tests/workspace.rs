use contextpick_core::selection::Intent;
use contextpick_core::{
    WorkspaceRoot,
    workspace::{FilterPolicy, Workspace},
};
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
fn renaming_a_file_does_not_transfer_its_exact_path_intent() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("src")).unwrap();
    std::fs::write(temp.path().join("src/original.rs"), "fn original() {}\n").unwrap();
    let intents = BTreeMap::from([("src/original.rs".into(), Intent::ForceExclude)]);
    let original = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        intents,
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(
        !original
            .view(1)
            .entries
            .iter()
            .find(|entry| entry.path == "src/original.rs")
            .unwrap()
            .selected
    );

    std::fs::rename(
        temp.path().join("src/original.rs"),
        temp.path().join("src/renamed.rs"),
    )
    .unwrap();
    let rescanned = Workspace::scan_pinned_with_outputs(
        original.root_handle.clone(),
        original.policy.clone(),
        original.intents.clone(),
        original.browsed.clone(),
        original.generated_outputs.clone(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let view = rescanned.view(2);

    assert!(
        !view
            .entries
            .iter()
            .any(|entry| entry.path == "src/original.rs")
    );
    assert!(
        view.entries
            .iter()
            .find(|entry| entry.path == "src/renamed.rs")
            .unwrap()
            .selected,
        "the new path follows normal policy instead of inheriting the old exact-path override"
    );
    assert_eq!(
        rescanned.intents.get("src/original.rs"),
        Some(&Intent::ForceExclude),
        "the path-based saved intent remains attached to the path the user chose"
    );
}

#[test]
fn rescan_rebuilds_gitignore_classification_after_rule_edits() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("src")).unwrap();
    std::fs::write(
        temp.path().join("src/generated.ts"),
        "export const generated = true;\n",
    )
    .unwrap();
    let original = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let generated = |workspace: &Workspace| {
        workspace
            .view(1)
            .entries
            .into_iter()
            .find(|entry| entry.path == "src/generated.ts")
            .unwrap()
    };
    assert!(generated(&original).selected);

    std::fs::write(temp.path().join(".gitignore"), "/src/generated.ts\n").unwrap();
    let rescanned = Workspace::scan_pinned_with_outputs(
        original.root_handle.clone(),
        original.policy.clone(),
        original.intents.clone(),
        original.browsed.clone(),
        original.generated_outputs.clone(),
        &AtomicBool::new(false),
    )
    .unwrap();

    assert!(!generated(&rescanned).selected);
    assert!(generated(&rescanned).git_ignored);
}

#[test]
fn git_ignore_view_classification_tracks_intent_changes_without_rescanning() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join(".gitignore"), "ignored.ts\n").unwrap();
    std::fs::write(temp.path().join("ignored.ts"), "ignored source").unwrap();
    let mut workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::from([("ignored.ts".into(), Intent::ForceInclude)]),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();

    let entry = |workspace: &Workspace| {
        workspace
            .view(1)
            .entries
            .into_iter()
            .find(|entry| entry.path == "ignored.ts")
            .unwrap()
    };
    assert!(entry(&workspace).selected);
    assert!(!entry(&workspace).git_ignored);

    workspace.intents.remove("ignored.ts");
    assert!(!entry(&workspace).selected);
    assert!(entry(&workspace).git_ignored);

    workspace
        .intents
        .insert("ignored.ts".into(), Intent::Exclude);
    assert_eq!(
        entry(&workspace).reason.as_deref(),
        Some("excluded by user")
    );
    assert!(!entry(&workspace).git_ignored);

    workspace
        .intents
        .insert("ignored.ts".into(), Intent::Include);
    assert!(
        entry(&workspace).git_ignored,
        "ordinary Include does not override Git-ignore"
    );
}

#[test]
fn git_ignore_view_classification_tracks_inherited_folder_intents_without_rescanning() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("dist/deep")).unwrap();
    std::fs::write(temp.path().join(".gitignore"), "dist/\n").unwrap();
    std::fs::write(temp.path().join("dist/deep/generated.ts"), "ignored source").unwrap();
    let mut workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::from([("dist".into(), Intent::ForceInclude)]),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();

    let entry = |workspace: &Workspace, path: &str| {
        workspace
            .view(1)
            .entries
            .into_iter()
            .find(|entry| entry.path == path)
            .unwrap()
    };
    assert!(entry(&workspace, "dist/deep/generated.ts").selected);
    assert!(!entry(&workspace, "dist/deep/generated.ts").git_ignored);

    workspace.intents.remove("dist");
    assert!(!entry(&workspace, "dist/deep/generated.ts").selected);
    assert!(entry(&workspace, "dist").git_ignored);
    assert!(entry(&workspace, "dist/deep/generated.ts").git_ignored);

    workspace
        .intents
        .insert("dist".into(), Intent::ForceExclude);
    assert!(!entry(&workspace, "dist").git_ignored);
    assert!(!entry(&workspace, "dist/deep/generated.ts").git_ignored);
}

#[test]
fn newly_reserved_hard_output_is_removed_from_git_ignore_view_without_rescan() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join(".gitignore"), "artifact.ts\n").unwrap();
    std::fs::write(temp.path().join("artifact.ts"), "ignored source").unwrap();
    let mut workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();

    assert!(
        workspace
            .view(1)
            .entries
            .iter()
            .find(|entry| entry.path == "artifact.ts")
            .unwrap()
            .git_ignored
    );
    workspace.generated_outputs.insert("artifact.ts".into());
    let artifact = workspace
        .view(2)
        .entries
        .into_iter()
        .find(|entry| entry.path == "artifact.ts")
        .unwrap();
    assert_eq!(artifact.kind, "blocked");
    assert!(!artifact.git_ignored);
    workspace.generated_outputs.remove("artifact.ts");
    assert!(
        workspace
            .view(3)
            .entries
            .iter()
            .find(|entry| entry.path == "artifact.ts")
            .unwrap()
            .git_ignored
    );
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

#[test]
fn newly_reserved_output_guard_applies_to_the_existing_index() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("context.md"), "old indexed text").unwrap();
    let mut workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    workspace.generated_outputs.insert("context.md".into());
    workspace
        .intents
        .insert("context.md".into(), Intent::ForceInclude);
    assert!(workspace.manifest().is_empty());
    let view = workspace.view(1);
    assert!(!view.entries[0].selected);
    assert!(
        view.entries[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("generated output")
    );
}

#[test]
fn registered_outputs_and_export_leftovers_are_hard_excluded_even_when_forced() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("src/main.rs");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, b"fn main() {}\n").unwrap();
    std::fs::write(temp.path().join("release.md"), b"generated payload\0").unwrap();
    std::fs::write(
        temp.path().join(".contextpick-export-temp-123.md"),
        b"partial\0",
    )
    .unwrap();
    std::fs::write(
        temp.path().join(".contextpick-export-crash-old.tmp"),
        b"leftover\0",
    )
    .unwrap();
    let generated = BTreeSet::from(["release.md".to_owned()]);
    let intents = BTreeMap::from([
        ("release.md".into(), Intent::ForceInclude),
        (
            ".contextpick-export-temp-123.md".into(),
            Intent::ForceInclude,
        ),
        (
            ".contextpick-export-crash-old.tmp".into(),
            Intent::ForceInclude,
        ),
    ]);

    for generation in 1..=2 {
        let workspace = if generation == 1 {
            Workspace::scan_with_outputs(
                temp.path(),
                FilterPolicy::default(),
                intents.clone(),
                BTreeSet::new(),
                generated.clone(),
                &AtomicBool::new(false),
            )
        } else {
            Workspace::scan_pinned_with_outputs(
                WorkspaceRoot::open(temp.path()).unwrap(),
                FilterPolicy::default(),
                intents.clone(),
                BTreeSet::new(),
                generated.clone(),
                &AtomicBool::new(false),
            )
        }
        .unwrap();
        assert_eq!(workspace.generated_outputs, generated);
        let view = workspace.view(generation);
        for path in [
            "release.md",
            ".contextpick-export-temp-123.md",
            ".contextpick-export-crash-old.tmp",
        ] {
            let entry = view
                .entries
                .iter()
                .find(|entry| entry.path == path)
                .unwrap();
            assert!(!entry.selected, "generated output selected at {path}");
            assert_eq!(entry.kind, "blocked");
            assert_eq!(
                entry.reason.as_deref(),
                Some("generated output is excluded from source context")
            );
        }
        assert_eq!(
            workspace
                .manifest()
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/main.rs"]
        );
    }

    assert_eq!(std::fs::read(&source).unwrap(), b"fn main() {}\n");
}

#[test]
fn malformed_ignore_diagnostics_have_a_bounded_summary() {
    let temp = tempfile::tempdir().unwrap();
    let malformed = std::iter::repeat_n("bad\\", 2_000)
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(temp.path().join(".gitignore"), malformed).unwrap();

    let workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let diagnostics = workspace.view(1).diagnostics;

    assert!(diagnostics.len() <= 64);
    assert!(diagnostics.iter().map(String::len).sum::<usize>() <= 16 * 1024);
    assert!(
        diagnostics
            .iter()
            .any(|message| message.contains("omitted"))
    );
}

#[test]
fn complex_glob_is_rejected_without_panicking_or_changing_the_current_workspace() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
    let current = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let original_manifest = current
        .manifest()
        .into_iter()
        .map(|entry| entry.path)
        .collect::<Vec<_>>();
    let original_view = current.view(7);
    let oversized_glob = "*a".repeat(100_000);
    let candidate = FilterPolicy {
        include_paths: vec![oversized_glob],
        ..FilterPolicy::default()
    };

    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Workspace::scan(
            temp.path(),
            candidate,
            BTreeMap::new(),
            BTreeSet::new(),
            &AtomicBool::new(false),
        )
    }));

    assert!(attempt.is_ok(), "invalid candidate policy must never panic");
    let error = attempt
        .unwrap()
        .err()
        .expect("oversized candidate should be rejected");
    assert!(error.to_string().contains("filter policy"));
    assert_eq!(
        current
            .manifest()
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>(),
        original_manifest
    );
    assert_eq!(current.view(7).selected_count, original_view.selected_count);
    assert_eq!(
        current.view(7).policy.include_paths,
        original_view.policy.include_paths
    );
}

#[test]
fn policy_rule_count_and_total_bytes_have_explicit_limits() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();

    let too_many = FilterPolicy {
        include_paths: (0..257).map(|index| format!("file-{index}.rs")).collect(),
        ..FilterPolicy::default()
    };
    let error = Workspace::scan(
        temp.path(),
        too_many,
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .err()
    .expect("too many rules should be rejected");
    assert!(error.to_string().contains("256 total rules"));

    let too_many_bytes = FilterPolicy {
        include_paths: vec!["a".repeat(4_097)],
        ..FilterPolicy::default()
    };
    let error = Workspace::scan(
        temp.path(),
        too_many_bytes,
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .err()
    .expect("oversized rule should be rejected");
    assert!(error.to_string().contains("4 KiB per rule"));

    let too_much_text = FilterPolicy {
        include_paths: (0..17).map(|_| "a".repeat(4_000)).collect(),
        ..FilterPolicy::default()
    };
    let error = Workspace::scan(
        temp.path(),
        too_much_text,
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .err()
    .expect("too much total rule text should be rejected");
    assert!(error.to_string().contains("64 KiB of total rule text"));
}

#[test]
fn invalid_gitignore_path_is_reported_and_does_not_hide_siblings() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join(".gitignore")).unwrap();
    std::fs::write(temp.path().join("main.ts"), "readable sibling").unwrap();

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
        view.incomplete,
        "invalid ignore path must mark the scan incomplete"
    );
    assert!(
        view.diagnostics
            .iter()
            .any(|message| message.contains(".gitignore")),
        "invalid ignore path should have an actionable diagnostic"
    );
    assert!(
        view.entries
            .iter()
            .any(|entry| entry.path == "main.ts" && entry.selected)
    );
}

#[test]
fn depth_limited_branch_does_not_hide_readable_siblings() {
    let temp = tempfile::tempdir().unwrap();
    let mut deep = temp.path().join("a");
    for _ in 0..128 {
        deep = deep.join("d");
    }
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(temp.path().join("z.ts"), "readable sibling").unwrap();
    let workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let view = workspace.view(1);
    assert!(view.incomplete);
    assert!(
        view.diagnostics
            .iter()
            .any(|message| message.contains("depth limit"))
    );
    assert!(
        workspace
            .manifest()
            .iter()
            .any(|entry| entry.path == "z.ts")
    );
    assert!(
        !view
            .entries
            .iter()
            .find(|entry| entry.path == "a")
            .unwrap()
            .enumerated
    );
}

// APFS rejects malformed UTF-8 names before the scanner can observe them.
#[cfg(target_os = "linux")]
#[test]
fn invalid_filename_marks_ancestors_incomplete_without_hiding_readable_siblings() {
    use std::os::unix::ffi::OsStringExt;
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join("a/inner")).unwrap();
    std::fs::write(
        temp.path()
            .join("a/inner")
            .join(std::ffi::OsString::from_vec(vec![0xff])),
        "unrepresentable",
    )
    .unwrap();
    std::fs::write(temp.path().join("a/inner/visible.ts"), "visible").unwrap();
    std::fs::write(temp.path().join("z.ts"), "sibling").unwrap();
    let workspace = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let view = workspace.view(1);
    for path in ["a", "a/inner"] {
        assert!(
            !view
                .entries
                .iter()
                .find(|entry| entry.path == path)
                .unwrap()
                .enumerated
        );
    }
    let manifest = workspace.manifest();
    assert!(
        manifest
            .iter()
            .any(|entry| entry.path == "a/inner/visible.ts")
    );
    assert!(manifest.iter().any(|entry| entry.path == "z.ts"));
}
