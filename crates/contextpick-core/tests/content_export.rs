use contextpick_core::{ManifestEntry, WorkspaceRoot, content, export, modified_ns};
use std::fs;
use std::sync::atomic::AtomicBool;
use tempfile::tempdir;

fn entry(root: &std::path::Path, path: &str) -> ManifestEntry {
    let metadata = fs::metadata(root.join(path)).unwrap();
    ManifestEntry {
        path: path.to_owned(),
        size: metadata.len(),
        modified_ns: modified_ns(&metadata),
    }
}

#[test]
fn classification_recognizes_text_and_binary_content() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::write(tmp.path().join("notes.png"), b"ordinary utf8 text\n").unwrap();
    fs::write(
        tmp.path().join("renamed.txt"),
        b"\x89PNG\r\n\x1a\n\0payload",
    )
    .unwrap();
    fs::write(tmp.path().join("utf16.txt"), [0xff, 0xfe, b'h', 0, b'i', 0]).unwrap();
    assert!(content::classify(&root, "notes.png").unwrap());
    assert!(!content::classify(&root, "renamed.txt").unwrap());
    assert!(content::classify(&root, "utf16.txt").unwrap());
}

#[test]
fn classification_ignores_an_incomplete_utf8_codepoint_at_sample_boundary() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    let mut bytes = vec![b'a'; 16 * 1024 - 1];
    bytes.push(0xe2); // the following bytes are beyond the bounded sample
    bytes.extend_from_slice(&[0x82, 0xac]);
    fs::write(tmp.path().join("edge.txt"), bytes).unwrap();
    assert!(content::classify(&root, "edge.txt").unwrap());
}

#[test]
fn classification_rejects_incomplete_utf8_at_eof_but_tolerates_split_utf16_at_sample_boundary() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::write(tmp.path().join("bad-eof.txt"), [b'a', 0xe2]).unwrap();
    assert!(!content::classify(&root, "bad-eof.txt").unwrap());

    let mut utf16 = vec![0xff, 0xfe];
    for _ in 0..8190 {
        utf16.extend_from_slice(&('a' as u16).to_le_bytes());
    }
    utf16.extend_from_slice(&0xd83du16.to_le_bytes());
    utf16.extend_from_slice(&0xde00u16.to_le_bytes());
    fs::write(tmp.path().join("split-utf16.txt"), utf16).unwrap();
    assert!(content::classify(&root, "split-utf16.txt").unwrap());
}

#[test]
fn preview_decodes_boms_and_reports_truncation_without_losing_crlf() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::write(tmp.path().join("utf8.txt"), b"\xef\xbb\xbfhello\r\nworld").unwrap();
    fs::write(tmp.path().join("utf16.txt"), [0xff, 0xfe, b'h', 0, b'i', 0]).unwrap();
    let p = content::preview(&root, "utf8.txt", 7).unwrap();
    assert_eq!(p.text, "hello\r\n");
    assert!(p.truncated);
    let p = content::preview(&root, "utf16.txt", 10).unwrap();
    assert_eq!(p.text, "hi");
    assert!(!p.truncated);
    assert_eq!(
        serde_json::to_value(p).unwrap(),
        serde_json::json!({"text":"hi","truncated":false})
    );
}

#[test]
fn preview_rejects_invalid_encoding_instead_of_replacement_characters() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::write(tmp.path().join("bad.txt"), [0xff, 0xfe, 0x00]).unwrap();
    assert!(content::preview(&root, "bad.txt", 100).is_err());
}

#[test]
fn preview_rejects_nul_content_even_when_the_path_looks_textual() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::write(tmp.path().join("binary.txt"), b"hello\0world").unwrap();
    assert!(!content::classify(&root, "binary.txt").unwrap());
    assert!(content::preview(&root, "binary.txt", 100).is_err());
}

#[test]
fn safe_open_rejects_alias_paths_and_directories() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::write(tmp.path().join("ok.txt"), b"ok").unwrap();
    fs::create_dir(tmp.path().join("folder")).unwrap();
    for unsafe_path in [
        "../outside",
        "/etc/passwd",
        "C:/Windows/win.ini",
        "folder/../ok.txt",
        "folder\\ok.txt",
        "folder",
    ] {
        assert!(
            content::open_safe(&root, unsafe_path).is_err(),
            "accepted {unsafe_path}"
        );
    }
    assert!(content::open_safe(&root, "ok.txt").is_ok());
}

#[test]
fn export_is_sorted_fenced_streamable_and_preserves_line_endings() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::create_dir(tmp.path().join("src")).unwrap();
    fs::write(tmp.path().join("src/z.rs"), b"last\r\n").unwrap();
    fs::write(tmp.path().join("a.txt"), b"line\n```\n~~~~\n").unwrap();
    let mut wide = vec![0xff, 0xfe];
    for unit in "wide text".encode_utf16() {
        wide.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(tmp.path().join("wide.txt"), wide).unwrap();
    let entries = vec![
        entry(tmp.path(), "src/z.rs"),
        entry(tmp.path(), "a.txt"),
        entry(tmp.path(), "wide.txt"),
    ];
    let out = tmp
        .path()
        .parent()
        .unwrap()
        .join(format!("contextpick-export-{}.md", std::process::id()));
    let _ = fs::remove_file(&out);
    let result = export::export_to(&root, &entries, &out, false, &AtomicBool::new(false)).unwrap();
    let md = fs::read_to_string(&out).unwrap();
    assert!(md.find("a.txt").unwrap() < md.find("src/z.rs").unwrap());
    assert!(md.contains("````text\nline\n```\n~~~~\n````"));
    assert!(md.contains("last\r\n"));
    assert!(md.contains("wide text"));
    assert_eq!(result.files, 3);
    assert_eq!(result.bytes as usize, md.len());
    assert_eq!(result.destination, out.to_string_lossy());
    fs::remove_file(out).unwrap();
}

#[test]
fn export_supports_backtick_runs_longer_than_sixteen_kib_without_fence_sized_allocation() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    let run = "`".repeat(16 * 1024 + 1);
    fs::write(tmp.path().join("long.rs"), run.as_bytes()).unwrap();
    let manifest = [entry(tmp.path(), "long.rs")];
    let out = tmp
        .path()
        .parent()
        .unwrap()
        .join(format!("contextpick-long-fence-{}.md", std::process::id()));
    let _ = fs::remove_file(&out);

    export::export_to(&root, &manifest, &out, false, &AtomicBool::new(false)).unwrap();
    let markdown = fs::read_to_string(&out).unwrap();
    let fence = "`".repeat(run.len() + 1);
    assert!(markdown.contains(&format!("{fence}rust\n{run}\n{fence}")));
    fs::remove_file(out).unwrap();
}

#[test]
fn export_uses_allowlisted_language_tags_and_falls_back_to_text() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    for (path, body) in [
        ("main.RS", "fn main() {}"),
        ("README.MD", "# Notes"),
        ("payload.rs;evil", "literal"),
    ] {
        fs::write(tmp.path().join(path), body).unwrap();
    }
    let manifest = [
        entry(tmp.path(), "main.RS"),
        entry(tmp.path(), "README.MD"),
        entry(tmp.path(), "payload.rs;evil"),
    ];
    let out = tmp
        .path()
        .parent()
        .unwrap()
        .join(format!("contextpick-tags-{}.md", std::process::id()));
    let _ = fs::remove_file(&out);

    export::export_to(&root, &manifest, &out, false, &AtomicBool::new(false)).unwrap();
    let markdown = fs::read_to_string(&out).unwrap();
    assert!(markdown.contains("```rust\nfn main() {}\n```"));
    assert!(markdown.contains("```markdown\n# Notes\n```"));
    assert!(markdown.contains("```text\nliteral\n```"));
    assert!(!markdown.contains("```rs;evil"));
    fs::remove_file(out).unwrap();
}

#[test]
fn export_rejects_changed_deleted_invalid_duplicate_empty_and_source_destinations_atomically() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::write(tmp.path().join("file.txt"), b"original").unwrap();
    let original = entry(tmp.path(), "file.txt");
    let destination = tmp
        .path()
        .parent()
        .unwrap()
        .join(format!("contextpick-atomic-{}.md", std::process::id()));
    let _ = fs::remove_file(&destination);
    let mut changed = original.clone();
    changed.size += 1;
    for manifest in [
        vec![changed],
        vec![original.clone(), original.clone()],
        vec![],
    ] {
        assert!(
            export::export_to(
                &root,
                &manifest,
                &destination,
                false,
                &AtomicBool::new(false)
            )
            .is_err()
        );
        assert!(!destination.exists());
    }
    assert!(
        export::export_to(
            &root,
            &[original],
            &tmp.path().join("file.txt"),
            true,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    fs::write(tmp.path().join("file.txt"), [0xff, 0xfe, 0x00]).unwrap();
    let invalid = entry(tmp.path(), "file.txt");
    assert!(
        export::export_to(
            &root,
            &[invalid],
            &destination,
            false,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(!destination.exists());
    fs::write(tmp.path().join("file.txt"), b"before\0after").unwrap();
    let binary = entry(tmp.path(), "file.txt");
    assert!(
        export::export_to(
            &root,
            &[binary],
            &destination,
            false,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(!destination.exists());
}

#[test]
fn export_honors_cancellation_and_noclobber() {
    let tmp = tempdir().unwrap();
    let root = WorkspaceRoot::open(tmp.path()).unwrap();
    fs::write(tmp.path().join("file.txt"), b"data").unwrap();
    let item = entry(tmp.path(), "file.txt");
    let out = tmp
        .path()
        .parent()
        .unwrap()
        .join(format!("contextpick-cancel-{}.md", std::process::id()));
    let _ = fs::remove_file(&out);
    assert!(
        export::export_to(
            &root,
            std::slice::from_ref(&item),
            &out,
            false,
            &AtomicBool::new(true)
        )
        .is_err()
    );
    assert!(!out.exists());
    fs::write(&out, b"existing").unwrap();
    assert!(export::export_to(&root, &[item], &out, false, &AtomicBool::new(false)).is_err());
    assert_eq!(fs::read(&out).unwrap(), b"existing");
    fs::remove_file(out).unwrap();
}
