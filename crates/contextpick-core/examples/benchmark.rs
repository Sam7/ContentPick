use contextpick_core::selection::Intent;
use contextpick_core::workspace::{FilterPolicy, Workspace};
use serde::Serialize;
use std::sync::atomic::AtomicBool;
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    error::Error,
    fs,
    hint::black_box,
    path::PathBuf,
    time::Instant,
};
use tempfile::{Builder, TempDir};

#[derive(Serialize)]
struct Report {
    os: &'static str,
    arch: &'static str,
    generated_text_files: usize,
    ignored_files_created: usize,
    workspace_index_entries: usize,
    enumerated_entries: usize,
    selected_files: usize,
    ignored_subtree_pruned: bool,
    reevaluation_iterations: usize,
    generation_ms: u128,
    scan_ms: u128,
    view_ms: u128,
    reevaluation_total_ms: u128,
}

fn create_fixture(
    base: Option<&PathBuf>,
    large: bool,
) -> Result<(TempDir, usize, usize, u128), Box<dyn Error>> {
    let files: usize = if large { 20_000 } else { 2_000 };
    let ignored_files: usize = if large { 100_000 } else { 10_000 };
    let mut builder = Builder::new();
    builder.prefix("contextpick-bench-");
    let temp = match base {
        Some(path) => builder.tempdir_in(path)?,
        None => builder.tempdir()?,
    };
    let started = Instant::now();
    fs::write(temp.path().join(".gitignore"), "ignored/\n")?;
    let ignored_root = temp.path().join("ignored");
    fs::create_dir_all(&ignored_root)?;

    for index in 0..files {
        let path = temp.path().join(format!("source_{index:05}.rs"));
        fs::write(
            path,
            format!("// synthetic source {index}\npub const VALUE: usize = {index};\n"),
        )?;
    }

    // Spread ignored files across many child directories to avoid testing a
    // single unusually large directory rather than ignored-subtree pruning.
    let directories = ignored_files.div_ceil(1_000);
    for directory in 0..directories {
        let child = ignored_root.join(format!("bucket_{directory:04}"));
        fs::create_dir(&child)?;
        let count = (ignored_files - directory * 1_000).min(1_000);
        for index in 0..count {
            let path = child.join(format!("ignored_{index:04}.txt"));
            fs::write(path, "ignored synthetic content\n")?;
        }
    }

    Ok((temp, files, ignored_files, started.elapsed().as_millis()))
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut base = None;
    let mut large = false;
    for arg in env::args().skip(1) {
        if arg == "--large" {
            large = true;
        } else if arg.starts_with('-') {
            return Err(format!("unknown argument: {arg}").into());
        } else if base.is_none() {
            base = Some(PathBuf::from(arg));
        } else {
            return Err("expected at most one temporary-directory parent path".into());
        }
    }

    let (fixture, generated_files, ignored_files, generation_ms) =
        create_fixture(base.as_ref(), large)?;
    let scan_started = Instant::now();
    let mut workspace = Workspace::scan(
        fixture.path(),
        FilterPolicy::default(),
        BTreeMap::new(),
        BTreeSet::new(),
        &AtomicBool::new(false),
    )?;
    let scan_ms = scan_started.elapsed().as_millis();

    let view_started = Instant::now();
    let view = workspace.view(1);
    let view_ms = view_started.elapsed().as_millis();
    let ignored_subtree_pruned = !view
        .entries
        .iter()
        .any(|entry| entry.path.starts_with("ignored/"));
    assert!(
        ignored_subtree_pruned,
        "ignored subtree was recursively indexed"
    );
    assert_eq!(
        workspace.enumerated_entries,
        generated_files + 2,
        "expected only text files, .gitignore, and ignored placeholder to be enumerated"
    );

    let iterations = if large { 100 } else { 20 };
    let reevaluation_started = Instant::now();
    let mut reevaluated = 0usize;
    for iteration in 0..iterations {
        workspace.intents.insert(
            "source_00000.rs".into(),
            if iteration % 2 == 0 {
                Intent::Exclude
            } else {
                Intent::Include
            },
        );
        reevaluated += black_box(workspace.manifest().len());
    }
    let reevaluation_total_ms = reevaluation_started.elapsed().as_millis();
    black_box(reevaluated);

    let report = Report {
        os: env::consts::OS,
        arch: env::consts::ARCH,
        generated_text_files: generated_files,
        ignored_files_created: ignored_files,
        workspace_index_entries: view.entries.len(),
        enumerated_entries: workspace.enumerated_entries,
        selected_files: view.selected_count,
        ignored_subtree_pruned,
        reevaluation_iterations: iterations,
        generation_ms,
        scan_ms,
        view_ms,
        reevaluation_total_ms,
    };
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
