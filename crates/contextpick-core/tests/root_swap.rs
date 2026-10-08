#![cfg(windows)]

use contextpick_core::{ManifestEntry, WorkspaceRoot, content, export, modified_ns};
use std::{fs, process::Command, sync::atomic::AtomicBool};
use tempfile::tempdir;

#[test]
fn replacing_workspace_path_with_junction_never_redirects_preview_or_export() {
    let temp = tempdir().unwrap();
    let workspace_path = temp.path().join("workspace");
    let moved_workspace = temp.path().join("workspace-original");
    let outside_path = temp.path().join("outside");
    fs::create_dir(&workspace_path).unwrap();
    fs::create_dir(&outside_path).unwrap();
    fs::write(workspace_path.join("note.txt"), "inside workspace").unwrap();
    fs::write(outside_path.join("note.txt"), "outside secret").unwrap();

    let root = WorkspaceRoot::open(&workspace_path).unwrap();
    let metadata = fs::metadata(workspace_path.join("note.txt")).unwrap();
    let manifest = [ManifestEntry {
        path: "note.txt".into(),
        size: metadata.len(),
        modified_ns: modified_ns(&metadata),
    }];

    // Windows may deny the move because the pinned directory handle does not
    // share delete access. If it permits the move, exercise the junction swap.
    let replaced = match fs::rename(&workspace_path, &moved_workspace) {
        Ok(()) => {
            let status = Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(&workspace_path)
                .arg(&outside_path)
                .status()
                .unwrap();
            assert!(status.success(), "could not create test junction");
            true
        }
        Err(error) => {
            assert_eq!(
                error.raw_os_error(),
                Some(32),
                "unexpected rename error: {error}"
            );
            false
        }
    };

    let preview = content::preview(&root, "note.txt", 100).unwrap();
    assert_eq!(preview.text, "inside workspace");
    assert!(!preview.text.contains("outside secret"));

    let destination = temp.path().join("export.md");
    let result = export::export_to(
        &root,
        &manifest,
        &destination,
        false,
        &AtomicBool::new(false),
    );
    if replaced {
        assert!(result.is_err());
        assert!(!destination.exists());
    } else {
        result.unwrap();
        let exported = fs::read_to_string(&destination).unwrap();
        assert!(exported.contains("inside workspace"));
        assert!(!exported.contains("outside secret"));
    }
}
