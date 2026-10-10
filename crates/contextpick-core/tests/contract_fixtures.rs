use contextpick_core::{ManifestEntry, export};
use contextpick_core::{
    selection::Intent,
    workspace::{FilterPolicy, Workspace},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    process::Command,
    sync::atomic::AtomicBool,
};
use tempfile::tempdir;

fn scan(root: &Path, policy: FilterPolicy) -> Workspace {
    Workspace::scan(
        root,
        policy,
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )
    .unwrap()
}

fn selected(workspace: &Workspace, path: &str) -> bool {
    workspace
        .view(1)
        .entries
        .iter()
        .find(|entry| entry.path == path)
        .unwrap_or_else(|| panic!("missing entry {path}"))
        .selected
}

fn require_git() {
    let result = Command::new("git")
        .arg("--version")
        .output()
        .expect("Git is a required prerequisite for Git parity fixture tests");
    assert!(
        result.status.success(),
        "Git is a required prerequisite for Git parity fixture tests"
    );
}

fn git_check_ignored(root: &Path, path: &str) -> bool {
    let result = Command::new("git")
        .args([
            "-C",
            root.to_str().expect("temporary fixture path must be UTF-8"),
            "-c",
            "core.excludesfile=",
            "check-ignore",
            "--no-index",
            "--quiet",
            "--",
            path,
        ])
        .output()
        .expect("Git is a required prerequisite for Git parity fixture tests");
    match result.status.code() {
        Some(0) => true,
        Some(1) => false,
        _ => panic!(
            "git check-ignore failed for {path}: {}",
            String::from_utf8_lossy(&result.stderr)
        ),
    }
}

fn git_check_ignored_including_config(root: &Path, path: &str) -> bool {
    let result = Command::new("git")
        .args([
            "-C",
            root.to_str().expect("temporary fixture path must be UTF-8"),
            "check-ignore",
            "--no-index",
            "--quiet",
            "--",
            path,
        ])
        .output()
        .expect("Git is a required prerequisite for Git parity fixture tests");
    match result.status.code() {
        Some(0) => true,
        Some(1) => false,
        _ => panic!(
            "git check-ignore failed for {path}: {}",
            String::from_utf8_lossy(&result.stderr)
        ),
    }
}

#[test]
fn gitignore_anchors_and_parent_negation_match_git_check_ignore() {
    require_git();
    let temp = tempdir().unwrap();
    fs::create_dir_all(temp.path().join("nested/deeper")).unwrap();
    fs::write(
        temp.path().join(".gitignore"),
        "/root-only.tmp\n*.log\n!keep.log\nnested/*.cache\n",
    )
    .unwrap();
    fs::write(temp.path().join("nested/.gitignore"), "/anchored.tmp\n").unwrap();
    for path in [
        "root-only.tmp",
        "nested/root-only.tmp",
        "nested/anchored.tmp",
        "nested/deeper/anchored.tmp",
        "drop.log",
        "keep.log",
        "nested/drop.log",
        "nested/keep.log",
        "nested/drop.cache",
        "nested/deeper/drop.cache",
    ] {
        fs::write(temp.path().join(path), "text").unwrap();
    }

    let git_init = Command::new("git")
        .args(["-C", temp.path().to_str().unwrap(), "init", "--quiet"])
        .status()
        .expect("Git is a required prerequisite for Git parity fixture tests");
    assert!(
        git_init.success(),
        "git init must succeed for parity fixture"
    );

    let workspace = scan(temp.path(), FilterPolicy::default());
    for path in [
        "root-only.tmp",
        "nested/root-only.tmp",
        "nested/anchored.tmp",
        "nested/deeper/anchored.tmp",
        "drop.log",
        "keep.log",
        "nested/drop.log",
        "nested/keep.log",
        "nested/drop.cache",
        "nested/deeper/drop.cache",
    ] {
        let expected_ignored = git_check_ignored(temp.path(), path);
        assert_eq!(
            selected(&workspace, path),
            !expected_ignored,
            "workspace/Git disagreement for {path}"
        );
    }
}

#[test]
fn ignored_parent_stays_ignored_until_gitignore_unignores_the_parent() {
    require_git();
    let temp = tempdir().unwrap();
    fs::create_dir_all(temp.path().join("dist")).unwrap();
    fs::write(temp.path().join("dist/keep.ts"), "keep").unwrap();
    fs::write(temp.path().join("dist/drop.ts"), "drop").unwrap();
    fs::write(temp.path().join(".gitignore"), "dist/\n!dist/keep.ts\n").unwrap();
    let git_init = Command::new("git")
        .args(["-C", temp.path().to_str().unwrap(), "init", "--quiet"])
        .status()
        .expect("Git is a required prerequisite for Git parity fixture tests");
    assert!(
        git_init.success(),
        "git init must succeed for parity fixture"
    );

    // A child negation cannot re-include a file under an ignored parent.
    for path in ["dist/keep.ts", "dist/drop.ts"] {
        assert!(
            git_check_ignored(temp.path(), path),
            "Git unexpectedly unignored {path}"
        );
    }
    let ignored_parent = scan(temp.path(), FilterPolicy::default());
    let placeholder = ignored_parent
        .view(1)
        .entries
        .into_iter()
        .find(|entry| entry.path == "dist")
        .unwrap();
    assert!(!placeholder.enumerated);
    assert!(
        !ignored_parent
            .view(1)
            .entries
            .iter()
            .any(|entry| entry.path == "dist/keep.ts")
    );

    // Unignore the parent first, then selectively unignore one child.
    fs::write(
        temp.path().join(".gitignore"),
        "dist/\n!dist/\ndist/*\n!dist/keep.ts\n",
    )
    .unwrap();
    assert!(!git_check_ignored(temp.path(), "dist/keep.ts"));
    assert!(git_check_ignored(temp.path(), "dist/drop.ts"));
    let parent_reincluded = scan(temp.path(), FilterPolicy::default());
    for path in ["dist/keep.ts", "dist/drop.ts"] {
        let expected_selected = !git_check_ignored(temp.path(), path);
        assert_eq!(
            selected(&parent_reincluded, path),
            expected_selected,
            "workspace/Git disagreement for {path}"
        );
    }
}

#[test]
fn browsing_ignored_parent_does_not_select_children_without_force_override() {
    let temp = tempdir().unwrap();
    fs::create_dir_all(temp.path().join("dist/nested")).unwrap();
    fs::write(temp.path().join(".gitignore"), "dist/\n").unwrap();
    fs::write(temp.path().join("dist/nested/keep.ts"), "text").unwrap();
    let browsed = BTreeSet::from(["dist".to_owned(), "dist/nested".to_owned()]);

    let inspected = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        browsed.clone(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let entry = inspected
        .view(1)
        .entries
        .into_iter()
        .find(|entry| entry.path == "dist/nested/keep.ts")
        .unwrap();
    assert!(!entry.selected);
    assert!(
        entry
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("gitignore"))
    );
    assert!(
        inspected
            .manifest()
            .iter()
            .all(|manifest_entry| !manifest_entry.path.starts_with("dist/"))
    );

    let forced = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::from([("dist/nested/keep.ts".into(), Intent::ForceInclude)]),
        browsed,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        forced
            .manifest()
            .iter()
            .filter(|manifest_entry| manifest_entry.path.starts_with("dist/"))
            .map(|manifest_entry| manifest_entry.path.as_str())
            .collect::<Vec<_>>(),
        ["dist/nested/keep.ts"]
    );
}

#[test]
fn ignore_files_and_git_global_excludes_are_disabled_by_default() {
    require_git();
    // The core opts into .gitignore through its policy; `.ignore` and
    // Git's core.excludesfile remain disabled because there is no UI toggle.
    let temp = tempdir().unwrap();
    fs::write(temp.path().join(".ignore"), "from-ignore.txt\n").unwrap();
    fs::write(temp.path().join("from-ignore.txt"), "text").unwrap();
    fs::write(temp.path().join("from-global.txt"), "text").unwrap();
    fs::write(temp.path().join("global-excludes"), "from-global.txt\n").unwrap();

    let git_init = Command::new("git")
        .args(["-C", temp.path().to_str().unwrap(), "init", "--quiet"])
        .status()
        .expect("Git is a required prerequisite for Git parity fixture tests");
    assert!(
        git_init.success(),
        "git init must succeed for parity fixture"
    );
    let config = Command::new("git")
        .args([
            "-C",
            temp.path().to_str().unwrap(),
            "config",
            "core.excludesfile",
        ])
        .arg(temp.path().join("global-excludes"))
        .status()
        .expect("Git is a required prerequisite for Git parity fixture tests");
    assert!(config.success());
    assert!(git_check_ignored_including_config(
        temp.path(),
        "from-global.txt"
    ));

    let workspace = scan(temp.path(), FilterPolicy::default());
    assert!(selected(&workspace, "from-ignore.txt"));
    assert!(selected(&workspace, "from-global.txt"));
}

#[test]
fn hidden_extensionless_and_env_text_files_follow_extension_filters_case_insensitively() {
    let temp = tempdir().unwrap();
    for name in [".hidden.rs", ".env", "Makefile", "MiXeD.Rs"] {
        fs::write(temp.path().join(name), "text").unwrap();
    }

    let default_workspace = scan(temp.path(), FilterPolicy::default());
    for name in [".hidden.rs", ".env", "Makefile", "MiXeD.Rs"] {
        assert!(selected(&default_workspace, name), "default omitted {name}");
    }

    let filtered = scan(
        temp.path(),
        FilterPolicy {
            include_mode: contextpick_core::workspace::IncludeMode::SelectedExtensions,
            include_extensions: vec![".rS".into()],
            ..FilterPolicy::default()
        },
    );
    assert!(selected(&filtered, ".hidden.rs"));
    assert!(selected(&filtered, "MiXeD.Rs"));
    assert!(!selected(&filtered, ".env"));
    assert!(!selected(&filtered, "Makefile"));
}

#[test]
fn migrated_file_extension_path_rules_match_files_only_and_support_extensionless_names() {
    let temp = tempdir().unwrap();
    fs::write(temp.path().join("Makefile"), "text").unwrap();
    fs::write(temp.path().join(".env"), "text").unwrap();
    fs::write(temp.path().join("MiXeD.Rs"), "text").unwrap();
    fs::write(temp.path().join(".hidden.rs"), "text").unwrap();
    fs::create_dir(temp.path().join("vendor.rs")).unwrap();
    fs::write(temp.path().join("vendor.rs/child.rs"), "text").unwrap();

    let workspace = scan(
        temp.path(),
        FilterPolicy {
            exclude_paths: vec!["file-ext:rs".into(), "file-ext:<none>".into()],
            ..FilterPolicy::default()
        },
    );

    assert!(!selected(&workspace, "Makefile"));
    assert!(!selected(&workspace, "MiXeD.Rs"));
    assert!(!selected(&workspace, ".hidden.rs"));
    assert!(selected(&workspace, ".env"));
    let view = workspace.view(0);
    let directory = view
        .entries
        .iter()
        .find(|entry| entry.path == "vendor.rs")
        .unwrap();
    assert_eq!(directory.kind, "directory");
    assert!(
        directory.enumerated,
        "file-targeted rules must not prune same-named directories"
    );
    assert!(
        view.entries
            .iter()
            .any(|entry| entry.path == "vendor.rs/child.rs")
    );
    assert!(!selected(&workspace, "vendor.rs/child.rs"));
}

#[test]
fn more_specific_legacy_path_exclusion_keeps_its_explanation_after_migration() {
    let temp = tempdir().unwrap();
    fs::create_dir_all(temp.path().join("src")).unwrap();
    fs::write(temp.path().join("src/generated.rs"), "generated").unwrap();

    let workspace = scan(
        temp.path(),
        FilterPolicy {
            exclude_paths: vec!["file-ext:rs".into(), "src/**".into()],
            ..FilterPolicy::default()
        },
    );

    let entry = workspace
        .view(1)
        .entries
        .into_iter()
        .find(|entry| entry.path == "src/generated.rs")
        .unwrap();
    assert_eq!(entry.reason.as_deref(), Some("custom exclude: src/**"));
}

#[test]
fn cancellation_and_invalid_roots_return_errors() {
    let missing = tempdir().unwrap().path().join("does-not-exist");
    assert!(
        Workspace::scan(
            &missing,
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            &AtomicBool::new(false),
        )
        .is_err()
    );

    let temp = tempdir().unwrap();
    let error = Workspace::scan(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(true),
    )
    .err()
    .expect("pre-cancelled scan should return an error");
    assert!(error.to_string().contains("scan cancelled"));
}

#[test]
fn repeated_exports_are_byte_identical_and_leave_sources_unchanged() {
    let temp = tempdir().unwrap();
    let workspace_path = temp.path().join("workspace");
    fs::create_dir_all(workspace_path.join("src")).unwrap();
    let source = workspace_path.join("src/main.rs");
    let original = b"fn main() {\r\n    println!(\"hello\");\r\n}\r\n";
    fs::write(&source, original).unwrap();
    let workspace = scan(&workspace_path, FilterPolicy::default());
    let manifest: Vec<ManifestEntry> = workspace.manifest();

    let first = temp.path().join("first.md");
    let second = temp.path().join("second.md");
    export::export_to(
        &workspace.root_handle,
        &manifest,
        &first,
        false,
        &AtomicBool::new(false),
    )
    .unwrap();
    export::export_to(
        &workspace.root_handle,
        &manifest,
        &second,
        false,
        &AtomicBool::new(false),
    )
    .unwrap();

    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    assert_eq!(fs::read(&source).unwrap(), original);
}

#[test]
fn binary_renamed_to_text_is_refused_without_publishing_output() {
    let temp = tempdir().unwrap();
    let workspace_path = temp.path().join("workspace");
    fs::create_dir(&workspace_path).unwrap();
    fs::write(
        workspace_path.join("misleading.txt"),
        b"\x89PNG\r\n\x1a\n\0payload",
    )
    .unwrap();
    let workspace = scan(&workspace_path, FilterPolicy::default());
    let manifest: Vec<ManifestEntry> = workspace.manifest();
    let destination = temp.path().join("binary-export.md");

    assert!(
        export::export_to(
            &workspace.root_handle,
            &manifest,
            &destination,
            false,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    assert!(!destination.exists());
}
