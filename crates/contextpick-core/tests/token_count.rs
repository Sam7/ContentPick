use contextpick_core::{
    ManifestEntry, WorkspaceRoot, modified_ns,
    token_count::{TOKENIZER_ID, count_export_file_section, count_export_preamble},
};
use std::sync::atomic::AtomicBool;
use tempfile::tempdir;
use tiktoken_rs::o200k_base_singleton;

fn manifest(root: &WorkspaceRoot, path: &str) -> ManifestEntry {
    let metadata = std::fs::metadata(root.path().join(path)).unwrap();
    ManifestEntry {
        path: path.to_owned(),
        size: metadata.len(),
        modified_ns: modified_ns(&metadata),
    }
}

#[test]
fn uses_the_named_offline_encoding_and_counts_markdown_preamble() {
    assert_eq!(TOKENIZER_ID, "o200k_base");
    let tokenizer = o200k_base_singleton();
    assert_eq!(tokenizer.count_ordinary("hello world"), 2);
    let escaped_root = "demo\\#root";
    let expected = format!("# ContextPick export — {escaped_root}\n\n");

    assert_eq!(
        count_export_preamble("demo#root"),
        tokenizer.count_ordinary(&expected) as u64
    );
}

#[test]
fn counts_a_validated_file_section_with_export_headings_and_dynamic_fences() {
    let temp = tempdir().unwrap();
    let source = temp.path().join("main.rs");
    let body = "fn main() {\n    println!(\"```\");\n}";
    std::fs::write(&source, body).unwrap();
    let root = WorkspaceRoot::open(temp.path()).unwrap();
    let entry = manifest(&root, "main.rs");
    let tokenizer = o200k_base_singleton();
    let expected = ["## main.rs\n\n", "````rust\n", body, "\n", "````\n\n"]
        .into_iter()
        .map(|segment| tokenizer.count_ordinary(segment) as u64)
        .sum::<u64>();

    let estimate = count_export_file_section(&root, &entry, &AtomicBool::new(false)).unwrap();

    assert_eq!(estimate.tokens, expected);
    assert_eq!(estimate.size, entry.size);
    assert_eq!(estimate.modified_ns, entry.modified_ns);
}

#[test]
fn matches_direct_o200k_reference_counts_for_code_punctuation_and_unicode() {
    let temp = tempdir().unwrap();
    let fixtures = [
        ("code.rs", "fn main() { println!(\"hello\"); }\n", "rust"),
        ("punctuation.txt", "!?. -> => {} [] <|endoftext|>\n", "text"),
        ("unicode.md", "Crème 東京 🧪 café\n", "markdown"),
    ];
    for (path, body, _) in fixtures {
        std::fs::write(temp.path().join(path), body).unwrap();
    }
    let root = WorkspaceRoot::open(temp.path()).unwrap();
    let tokenizer = o200k_base_singleton();
    let mut total = 0;

    for (path, body, language) in fixtures {
        let entry = manifest(&root, path);
        let expected = [
            format!("## {path}\n\n"),
            format!("```{language}\n"),
            body.to_owned(),
            "```\n\n".to_owned(),
        ]
        .into_iter()
        .map(|segment| tokenizer.count_ordinary(&segment) as u64)
        .sum::<u64>();

        let estimate = count_export_file_section(&root, &entry, &AtomicBool::new(false)).unwrap();

        assert_eq!(estimate.tokens, expected, "fixture {path}");
        total += estimate.tokens;
    }
    assert!(total > 0);
}

#[test]
fn counts_decoded_utf16_body_without_counting_its_bom() {
    let temp = tempdir().unwrap();
    let body = "Ω\r\n";
    let mut bytes = vec![0xff, 0xfe];
    for unit in body.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(temp.path().join("utf16.txt"), bytes).unwrap();
    let root = WorkspaceRoot::open(temp.path()).unwrap();
    let entry = manifest(&root, "utf16.txt");
    let tokenizer = o200k_base_singleton();
    let expected = ["## utf16.txt\n\n", "```text\n", body, "```\n\n"]
        .into_iter()
        .map(|segment| tokenizer.count_ordinary(segment) as u64)
        .sum::<u64>();

    let estimate = count_export_file_section(&root, &entry, &AtomicBool::new(false)).unwrap();

    assert_eq!(estimate.tokens, expected);
}

#[test]
fn refuses_binary_and_invalid_utf8_content_instead_of_counting_a_prefix() {
    let temp = tempdir().unwrap();
    std::fs::write(temp.path().join("binary.txt"), b"text\0secret").unwrap();
    std::fs::write(temp.path().join("invalid.txt"), [b'o', b'k', 0xff]).unwrap();
    let root = WorkspaceRoot::open(temp.path()).unwrap();
    let cancel = AtomicBool::new(false);

    for path in ["binary.txt", "invalid.txt"] {
        let error = count_export_file_section(&root, &manifest(&root, path), &cancel)
            .expect_err("invalid input must not return an exact-looking estimate");
        assert!(!error.to_string().is_empty());
    }
}

#[test]
fn observes_cancellation_before_reading_a_file() {
    let temp = tempdir().unwrap();
    std::fs::write(temp.path().join("large.txt"), vec![b'x'; 64 * 1024]).unwrap();
    let root = WorkspaceRoot::open(temp.path()).unwrap();
    let entry = manifest(&root, "large.txt");

    let error = count_export_file_section(&root, &entry, &AtomicBool::new(true))
        .expect_err("a cancelled estimate must not return a count");

    assert_eq!(error.to_string(), "token estimate cancelled");
}
