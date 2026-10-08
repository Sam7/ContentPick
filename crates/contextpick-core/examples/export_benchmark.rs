//! Repeatable bounded-memory export measurement. All inputs are disposable synthetic data.
use contextpick_core::{
    content, export,
    workspace::{FilterPolicy, Workspace},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs::File,
    io::Write,
    sync::atomic::AtomicBool,
    time::Instant,
};

fn main() -> Result<(), Box<dyn Error>> {
    let fixture = tempfile::Builder::new()
        .prefix("contextpick-large-export-")
        .tempdir()?;
    let source_root = fixture.path().join("source");
    std::fs::create_dir(&source_root)?;
    let source_path = source_root.join("large.rs");
    let mut source = File::create(&source_path)?;
    let mut block = [b' '; 16 * 1024];
    block[..20].copy_from_slice(b"// synthetic source\n");
    block[block.len() - 1] = b'\n';
    for _ in 0..8192 {
        source.write_all(&block)?;
    }
    source.sync_all()?;
    drop(source);
    let source_bytes = std::fs::metadata(&source_path)?.len();
    let cancel = AtomicBool::new(false);
    let scan_started = Instant::now();
    let workspace = Workspace::scan(
        &source_root,
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &cancel,
    )?;
    let scan_ms = scan_started.elapsed().as_millis();
    let preview = content::preview(&workspace.root_handle, "large.rs", 256 * 1024)?;
    assert!(preview.truncated);
    assert_eq!(preview.text.len(), 256 * 1024);
    let started = Instant::now();
    let output_path = fixture.path().join("context.md");
    let result = export::export_to(
        &workspace.root_handle,
        &workspace.manifest(),
        &output_path,
        false,
        &cancel,
    )?;
    let export_ms = started.elapsed().as_millis();
    assert_eq!(result.files, 1);
    assert_eq!(result.bytes, std::fs::metadata(&output_path)?.len());
    assert_eq!(std::fs::metadata(&source_path)?.len(), source_bytes);
    println!(
        "{}",
        serde_json::json!({
            "sourceBytes":source_bytes,"exportBytes":result.bytes,"scanMs":scan_ms,
            "exportMs":export_ms,"previewBytes":preview.text.len(),"previewTruncated":preview.truncated,
            "os":std::env::consts::OS,"arch":std::env::consts::ARCH
        })
    );
    Ok(())
}
