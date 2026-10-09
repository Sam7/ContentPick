//! Repeatable offline tokenizer measurement over synthetic selected files.
use contextpick_core::{
    token_count::{count_export_file_section, count_export_preamble},
    workspace::{FilterPolicy, Workspace},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    hint::black_box,
    sync::atomic::AtomicBool,
    time::Instant,
};

const FILE_BYTES: usize = 128 * 1024;

fn main() -> Result<(), Box<dyn Error>> {
    let large = std::env::args().skip(1).any(|arg| arg == "--large");
    let file_count = if large { 256 } else { 64 };
    let fixture = tempfile::Builder::new()
        .prefix("contextpick-token-bench-")
        .tempdir()?;

    let mut contents = String::with_capacity(FILE_BYTES);
    let line = "// synthetic tokenizer benchmark source with punctuation, Unicode café, and Rust symbols\npub const VALUE: usize = 42;\n";
    while contents.len() < FILE_BYTES {
        contents.push_str(line);
    }
    contents.truncate(FILE_BYTES);

    let generation_started = Instant::now();
    for index in 0..file_count {
        fs::write(
            fixture.path().join(format!("source_{index:04}.rs")),
            &contents,
        )?;
    }
    let generation_ms = generation_started.elapsed().as_millis();

    let cancel = AtomicBool::new(false);
    let scan_started = Instant::now();
    let workspace = Workspace::scan(
        fixture.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &cancel,
    )?;
    let scan_ms = scan_started.elapsed().as_millis();
    let manifest = workspace.manifest();
    assert_eq!(manifest.len(), file_count);

    // This first call includes loading and parsing the bundled encoding data.
    let tokenizer_init_started = Instant::now();
    let preamble_tokens = black_box(count_export_preamble("token-benchmark"));
    let tokenizer_init_ms = tokenizer_init_started.elapsed().as_millis();

    let count_started = Instant::now();
    let mut total_tokens = preamble_tokens;
    let mut total_bytes = 0u64;
    for entry in &manifest {
        let estimate = count_export_file_section(&workspace.root_handle, entry, &cancel)?;
        total_tokens += estimate.tokens;
        total_bytes += estimate.size;
    }
    let count_ms = count_started.elapsed().as_millis();
    let seconds = count_ms as f64 / 1000.0;

    println!(
        "{}",
        serde_json::json!({
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "files": file_count,
            "sourceBytes": total_bytes,
            "estimatedTokens": total_tokens,
            "generationMs": generation_ms,
            "scanMs": scan_ms,
            "coldTokenizerInitMs": tokenizer_init_ms,
            "countMs": count_ms,
            "sourceMiBPerSecond": if seconds > 0.0 { total_bytes as f64 / (1024.0 * 1024.0) / seconds } else { 0.0 },
            "tokensPerSecond": if seconds > 0.0 { total_tokens as f64 / seconds } else { 0.0 },
            "perFileConcurrency": 1,
            "perFileInputLimitBytes": 64 * 1024 * 1024,
        })
    );
    Ok(())
}
