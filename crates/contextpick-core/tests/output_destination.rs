use contextpick_core::{WorkspaceRoot, destination::Destination};
use std::{
    fs,
    io::Write,
    sync::atomic::{AtomicBool, Ordering},
};

#[test]
fn new_in_root_output_is_published_without_replacing_any_existing_path() {
    let root_dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::open(root_dir.path()).unwrap();
    let path = root_dir.path().join("context.md");
    let destination = Destination::prepare(&root, &path, false).unwrap();
    assert_eq!(destination.relative_path(), Some("context.md"));
    let mut transaction = destination.create_temp().unwrap();
    transaction.file_mut().write_all(b"literal export").unwrap();
    transaction.commit(&AtomicBool::new(false)).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"literal export");
    assert!(Destination::prepare(&root, &path, true).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"literal export");
    assert_eq!(fs::read_dir(root_dir.path()).unwrap().count(), 1);
}

#[test]
fn destination_created_during_export_survives_no_clobber_publication() {
    let root_dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::open(root_dir.path()).unwrap();
    let path = root_dir.path().join("context.md");
    let mut transaction = Destination::prepare(&root, &path, false)
        .unwrap()
        .create_temp()
        .unwrap();
    transaction.file_mut().write_all(b"export").unwrap();
    fs::write(&path, b"new source created by editor").unwrap();
    assert!(transaction.commit(&AtomicBool::new(false)).is_err());
    assert_eq!(fs::read(path).unwrap(), b"new source created by editor");
    assert_eq!(fs::read_dir(root_dir.path()).unwrap().count(), 1);
}

#[test]
fn dropping_failed_transaction_removes_temporary_sibling() {
    let root_dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::open(root_dir.path()).unwrap();
    let path = root_dir.path().join("context.md");
    {
        let mut transaction = Destination::prepare(&root, &path, false)
            .unwrap()
            .create_temp()
            .unwrap();
        transaction.file_mut().write_all(b"partial").unwrap();
        assert_eq!(fs::read_dir(root_dir.path()).unwrap().count(), 1);
    }
    assert!(!path.exists());
    assert_eq!(fs::read_dir(root_dir.path()).unwrap().count(), 0);
}

#[test]
fn confirmed_outside_overwrite_is_transactional() {
    let root_dir = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::open(root_dir.path()).unwrap();
    let path = output.path().join("context.md");
    fs::write(&path, b"old export").unwrap();
    assert!(Destination::prepare(&root, &path, false).is_err());
    let mut transaction = Destination::prepare(&root, &path, true)
        .unwrap()
        .create_temp()
        .unwrap();
    transaction.file_mut().write_all(b"new export").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"old export");
    transaction.commit(&AtomicBool::new(false)).unwrap();
    assert_eq!(fs::read(path).unwrap(), b"new export");
}

#[test]
fn cancelling_after_body_write_preserves_existing_destination_and_cleans_temp() {
    let root_dir = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::open(root_dir.path()).unwrap();
    let path = output.path().join("context.md");
    fs::write(&path, b"old export").unwrap();
    let mut transaction = Destination::prepare(&root, &path, true)
        .unwrap()
        .create_temp()
        .unwrap();
    transaction
        .file_mut()
        .write_all(&vec![b'x'; 128 * 1024])
        .unwrap();
    let cancel = AtomicBool::new(false);
    cancel.store(true, Ordering::Relaxed);
    assert!(
        transaction
            .commit(&cancel)
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
    assert_eq!(fs::read(path).unwrap(), b"old export");
    assert_eq!(fs::read_dir(output.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn case_alias_uses_canonical_registry_spelling_and_still_rejects_junctions() {
    let root_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(root_dir.path().join("src")).unwrap();
    let root = WorkspaceRoot::open(root_dir.path()).unwrap();
    let alias =
        std::path::PathBuf::from(root_dir.path().to_str().unwrap().to_uppercase()).join("SRC");
    if !alias.exists() {
        // A case-sensitive fixture filesystem has no alias to bypass the guard.
        assert!(Destination::prepare(&root, &alias.join("context.md"), false).is_err());
        return;
    }
    let prepared = Destination::prepare(&root, &alias.join("context.md"), false).unwrap();
    assert_eq!(prepared.relative_path(), Some("src/context.md"));
    let link = root_dir.path().join("linked");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "junction fixture prerequisite failed"
    );
    let link_alias = std::path::PathBuf::from(root_dir.path().to_str().unwrap().to_uppercase())
        .join("linked/context.md");
    assert!(Destination::prepare(&root, &link_alias, false).is_err());
    assert!(!outside.path().join("context.md").exists());
    fs::remove_dir(link).unwrap();
}

#[cfg(windows)]
#[test]
fn in_root_junction_parent_is_rejected() {
    let root_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::open(root_dir.path()).unwrap();
    let link = root_dir.path().join("linked");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "junction fixture prerequisite failed"
    );
    assert!(Destination::prepare(&root, &link.join("context.md"), false).is_err());
    assert!(!outside.path().join("context.md").exists());
    fs::remove_dir(link).unwrap();
}

#[cfg(unix)]
#[test]
fn in_root_symlink_parent_is_rejected() {
    let root_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::open(root_dir.path()).unwrap();
    let link = root_dir.path().join("linked");
    std::os::unix::fs::symlink(outside.path(), &link).unwrap();
    assert!(Destination::prepare(&root, &link.join("context.md"), false).is_err());
    assert!(!outside.path().join("context.md").exists());
}
