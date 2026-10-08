use contextpick_core::workspace::{FilterPolicy, Workspace};
use contextpick_core::{ManifestEntry, export};
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

fn git_check_ignored(root: &Path, path: &str) -> Option<bool> {
    let result = Command::new("git")
        .args([
            "-C",
            root.to_str()?,
            "-c",
            "core.excludesfile=",
            "check-ignore",
            "--no-index",
            "--quiet",
            "--",
            path,
        ])
        .status()
        .ok()?;
    Some(result.success())
}

fn git_check_ignored_including_config(root: &Path, path: &str) -> Option<bool> {
    let result = Command::new("git")
        .args([
            "-C",
            root.to_str()?,
            "check-ignore",
            "--no-index",
            "--quiet",
            "--",
            path,
        ])
        .status()
        .ok()?;
    Some(result.success())
}

#[test]
fn gitignore_anchors_and_parent_negation_match_git_check_ignore() {
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
        .status();
    if git_init.is_err() {
        return;
    }
    assert!(git_init.unwrap().success());

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
        let expected_ignored = git_check_ignored(temp.path(), path).unwrap();
        assert_eq!(
            selected(&workspace, path),
            !expected_ignored,
            "workspace/Git disagreement for {path}"
        );
    }
}

#[test]
fn ignore_files_and_git_global_excludes_are_disabled_by_default() {
    // The core opts into .gitignore through its policy; `.ignore` and
    // Git's core.excludesfile remain disabled because there is no UI toggle.
    let temp = tempdir().unwrap();
    fs::write(temp.path().join(".ignore"), "from-ignore.txt\n").unwrap();
    fs::write(temp.path().join("from-ignore.txt"), "text").unwrap();
    fs::write(temp.path().join("from-global.txt"), "text").unwrap();
    fs::write(temp.path().join("global-excludes"), "from-global.txt\n").unwrap();

    let git_init = Command::new("git")
        .args(["-C", temp.path().to_str().unwrap(), "init", "--quiet"])
        .status();
    if let Ok(status) = git_init {
        assert!(status.success());
        let config = Command::new("git")
            .args([
                "-C",
                temp.path().to_str().unwrap(),
                "config",
                "core.excludesfile",
            ])
            .arg(temp.path().join("global-excludes"))
            .status()
            .unwrap();
        assert!(config.success());
        assert_eq!(
            git_check_ignored_including_config(temp.path(), "from-global.txt"),
            Some(true)
        );
    }

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
