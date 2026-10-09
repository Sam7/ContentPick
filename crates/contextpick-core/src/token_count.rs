use crate::workspace::{ENTRY_LIMIT, INDEX_TEXT_BYTES_LIMIT};
use crate::{Error, ManifestEntry, Result, WorkspaceRoot, content, export, modified_ns};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tiktoken_rs::{CoreBPE, o200k_base_singleton};

pub const TOKENIZER_ID: &str = "o200k_base";
pub const TOKEN_FILE_INPUT_LIMIT_BYTES: u64 = 64 * 1024 * 1024;

const TOKEN_TEXT_CHUNK_BYTES: usize = content::DECODE_CHUNK_BYTES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileTokenEstimate {
    pub tokens: u64,
    pub size: u64,
    pub modified_ns: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenEstimate {
    pub tokens: u64,
    pub files: usize,
    pub reused_files: usize,
    pub computed_files: usize,
    pub tokenizer_id: &'static str,
}

#[derive(Clone, Debug)]
struct CachedFileEstimate {
    estimate: FileTokenEstimate,
    tokenizer_id: &'static str,
}

/// A bounded cache for the active pinned workspace. Root identity scopes all
/// path/version entries; a path keeps only its most recently observed version.
#[derive(Default)]
pub struct TokenEstimateCache {
    state: Mutex<TokenEstimateCacheState>,
}

#[derive(Default)]
struct TokenEstimateCacheState {
    root: Option<WorkspaceRoot>,
    entries: HashMap<String, CachedFileEstimate>,
    path_bytes: usize,
}

impl TokenEstimateCache {
    pub fn estimate_selected(
        &self,
        root: &WorkspaceRoot,
        entries: &[ManifestEntry],
        cancel: &AtomicBool,
    ) -> Result<TokenEstimate> {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Message("token estimate cancelled".into()));
        }
        root.validate_anchor()?;
        self.select_root(root);

        if entries.is_empty() {
            return Ok(TokenEstimate {
                tokens: 0,
                files: 0,
                reused_files: 0,
                computed_files: 0,
                tokenizer_id: TOKENIZER_ID,
            });
        }

        let root_name = root
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workspace");
        let mut tokens = count_export_preamble(root_name);
        let mut reused_files = 0usize;
        let mut computed_files = 0usize;

        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Message("token estimate cancelled".into()));
            }
            let estimate = match self.cached(root, entry) {
                Some(estimate) => {
                    reused_files += 1;
                    estimate
                }
                None => {
                    let estimate = count_export_file_section(root, entry, cancel)?;
                    if cancel.load(Ordering::Relaxed) {
                        return Err(Error::Message("token estimate cancelled".into()));
                    }
                    self.insert(root, entry, estimate.clone());
                    computed_files += 1;
                    estimate
                }
            };
            tokens = tokens
                .checked_add(estimate.tokens)
                .ok_or_else(|| Error::Message("token estimate overflow".into()))?;
        }

        root.validate_anchor()?;
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Message("token estimate cancelled".into()));
        }
        Ok(TokenEstimate {
            tokens,
            files: entries.len(),
            reused_files,
            computed_files,
            tokenizer_id: TOKENIZER_ID,
        })
    }

    fn select_root(&self, root: &WorkspaceRoot) {
        let mut state = self.lock();
        if state
            .root
            .as_ref()
            .is_none_or(|current| !current.same_identity(root))
        {
            state.entries.clear();
            state.path_bytes = 0;
            state.root = Some(root.clone());
        }
    }

    fn cached(&self, root: &WorkspaceRoot, entry: &ManifestEntry) -> Option<FileTokenEstimate> {
        let state = self.lock();
        if !state
            .root
            .as_ref()
            .is_some_and(|current| current.same_identity(root))
        {
            return None;
        }
        let cached = state.entries.get(&entry.path)?;
        (cached.tokenizer_id == TOKENIZER_ID
            && cached.estimate.size == entry.size
            && cached.estimate.modified_ns == entry.modified_ns)
            .then(|| cached.estimate.clone())
    }

    fn insert(&self, root: &WorkspaceRoot, entry: &ManifestEntry, estimate: FileTokenEstimate) {
        if entry.path.len() > INDEX_TEXT_BYTES_LIMIT {
            return;
        }
        let mut state = self.lock();
        if !state
            .root
            .as_ref()
            .is_some_and(|current| current.same_identity(root))
        {
            return;
        }
        if state.entries.remove(&entry.path).is_some() {
            state.path_bytes = state.path_bytes.saturating_sub(entry.path.len());
        }
        while state.entries.len() >= ENTRY_LIMIT
            || state.path_bytes.saturating_add(entry.path.len()) > INDEX_TEXT_BYTES_LIMIT
        {
            let Some(path) = state.entries.keys().next().cloned() else {
                break;
            };
            state.path_bytes = state.path_bytes.saturating_sub(path.len());
            state.entries.remove(&path);
        }
        state.path_bytes += entry.path.len();
        state.entries.insert(
            entry.path.clone(),
            CachedFileEstimate {
                estimate,
                tokenizer_id: TOKENIZER_ID,
            },
        );
    }

    fn lock(&self) -> MutexGuard<'_, TokenEstimateCacheState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn tokenizer() -> &'static CoreBPE {
    o200k_base_singleton()
}

fn count_text(text: &str) -> u64 {
    tokenizer().count_ordinary(text) as u64
}

fn add_count(total: &mut u64, text: &str) -> Result<()> {
    *total = total
        .checked_add(count_text(text))
        .ok_or_else(|| Error::Message("token estimate overflow".into()))?;
    Ok(())
}

fn add_repeated_backticks(total: &mut u64, mut count: usize, cancel: &AtomicBool) -> Result<()> {
    let chunk = "`".repeat(TOKEN_TEXT_CHUNK_BYTES);
    while count > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Message("token estimate cancelled".into()));
        }
        let length = count.min(chunk.len());
        add_count(total, &chunk[..length])?;
        count -= length;
    }
    Ok(())
}

fn add_fence_open(
    total: &mut u64,
    fence_len: usize,
    path: &str,
    cancel: &AtomicBool,
) -> Result<()> {
    let language_line = format!("{}\n", export::language_tag(path));
    if fence_len <= TOKEN_TEXT_CHUNK_BYTES {
        let mut opening = "`".repeat(fence_len);
        opening.push_str(&language_line);
        add_count(total, &opening)
    } else {
        add_repeated_backticks(total, fence_len, cancel)?;
        add_count(total, &language_line)
    }
}

fn add_fence_close(total: &mut u64, fence_len: usize, cancel: &AtomicBool) -> Result<()> {
    if fence_len <= TOKEN_TEXT_CHUNK_BYTES - 2 {
        let mut closing = "`".repeat(fence_len);
        closing.push_str("\n\n");
        add_count(total, &closing)
    } else {
        add_repeated_backticks(total, fence_len, cancel)?;
        add_count(total, "\n\n")
    }
}

/// Counts the export title as an independent segment. The total remains an
/// estimate because file and input-chunk boundaries are counted separately.
pub fn count_export_preamble(root_name: &str) -> u64 {
    let heading = format!(
        "# ContextPick export — {}\n\n",
        export::escaped_heading(root_name)
    );
    count_text(&heading)
}

pub fn count_export_file_section(
    root: &WorkspaceRoot,
    entry: &ManifestEntry,
    cancel: &AtomicBool,
) -> Result<FileTokenEstimate> {
    count_export_file_section_with_limit(
        root,
        entry,
        cancel,
        TOKEN_FILE_INPUT_LIMIT_BYTES,
        &mut || {},
    )
}

fn count_export_file_section_with_limit(
    root: &WorkspaceRoot,
    entry: &ManifestEntry,
    cancel: &AtomicBool,
    input_limit: u64,
    after_read: &mut impl FnMut(),
) -> Result<FileTokenEstimate> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Message("token estimate cancelled".into()));
    }
    root.validate_anchor()?;
    let mut source = content::open_safe(root, &entry.path)
        .map_err(|error| Error::Message(format!("{}: {error}", entry.path)))?;
    let before = source.metadata()?;
    if !before.is_file() || before.len() != entry.size || modified_ns(&before) != entry.modified_ns
    {
        return Err(Error::Message(format!(
            "{}: file changed since manifest",
            entry.path
        )));
    }
    if before.len() > input_limit {
        return Err(Error::Message(format!(
            "{}: file exceeds token estimate input limit",
            entry.path
        )));
    }

    let mut body_tokens = 0u64;
    let mut last_byte = None;
    let mut current_backticks = 0usize;
    let mut longest_backticks = 0usize;
    content::visit_decoded_text(
        &mut source,
        cancel,
        "token estimate cancelled",
        Some(input_limit),
        after_read,
        &mut |text| {
            if text.len() > content::MAX_DECODED_TEXT_CHUNK_BYTES {
                return Err(Error::Message("token text chunk exceeded its bound".into()));
            }
            body_tokens = body_tokens
                .checked_add(tokenizer().count_ordinary(text) as u64)
                .ok_or_else(|| Error::Message("token estimate overflow".into()))?;
            last_byte = text.as_bytes().last().copied().or(last_byte);
            for byte in text.bytes() {
                if byte == b'`' {
                    current_backticks = current_backticks.saturating_add(1);
                    longest_backticks = longest_backticks.max(current_backticks);
                } else {
                    current_backticks = 0;
                }
            }
            Ok(())
        },
    )
    .map_err(|error| Error::Message(format!("{}: {error}", entry.path)))?;

    let after = source.metadata()?;
    let path_after = content::open_safe(root, &entry.path)?.metadata()?;
    if after.len() != entry.size
        || modified_ns(&after) != entry.modified_ns
        || path_after.len() != entry.size
        || modified_ns(&path_after) != entry.modified_ns
    {
        return Err(Error::Message(format!(
            "{}: file changed during token estimate",
            entry.path
        )));
    }
    root.validate_anchor()?;

    let fence_len = longest_backticks
        .max(2)
        .checked_add(1)
        .ok_or_else(|| Error::Message("code fence is too long to represent".into()))?;
    let mut tokens = 0;
    add_count(
        &mut tokens,
        &format!("## {}\n\n", export::escaped_heading(&entry.path)),
    )?;
    add_fence_open(&mut tokens, fence_len, &entry.path, cancel)?;
    tokens = tokens
        .checked_add(body_tokens)
        .ok_or_else(|| Error::Message("token estimate overflow".into()))?;
    if last_byte != Some(b'\n') {
        add_count(&mut tokens, "\n")?;
    }
    add_fence_close(&mut tokens, fence_len, cancel)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Message("token estimate cancelled".into()));
    }

    Ok(FileTokenEstimate {
        tokens,
        size: after.len(),
        modified_ns: modified_ns(&after),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        FileTokenEstimate, TokenEstimateCache, count_export_file_section_with_limit, tokenizer,
    };
    use crate::workspace::{FilterPolicy, Workspace};
    use crate::{ManifestEntry, WorkspaceRoot, content, modified_ns};
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::tempdir;

    fn manifest(root: &WorkspaceRoot, path: &str) -> ManifestEntry {
        let metadata = std::fs::metadata(root.path().join(path)).unwrap();
        ManifestEntry {
            path: path.to_owned(),
            size: metadata.len(),
            modified_ns: modified_ns(&metadata),
        }
    }

    fn scan(root: &std::path::Path) -> Workspace {
        Workspace::scan(
            root,
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    #[test]
    fn reuses_unchanged_file_counts_after_an_unrelated_file_is_added() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(temp.path().join("b.rs"), "fn b() {}\n").unwrap();
        let first_workspace = scan(temp.path());
        let cancel = AtomicBool::new(false);
        let cache = TokenEstimateCache::default();

        let first = cache
            .estimate_selected(
                &first_workspace.root_handle,
                &first_workspace.manifest(),
                &cancel,
            )
            .unwrap();
        assert_eq!(first.computed_files, 2);
        assert_eq!(first.reused_files, 0);

        std::fs::write(temp.path().join("unrelated.rs"), "fn unrelated() {}\n").unwrap();
        let next_workspace = scan(temp.path());
        let next = cache
            .estimate_selected(
                &next_workspace.root_handle,
                &next_workspace.manifest(),
                &cancel,
            )
            .unwrap();

        assert_eq!(next.computed_files, 1);
        assert_eq!(next.reused_files, 2);
        assert_eq!(next.files, 3);
    }

    #[test]
    fn empty_selection_has_zero_tokens_and_does_not_count_the_export_preamble() {
        let temp = tempdir().unwrap();
        let workspace = scan(temp.path());
        let cache = TokenEstimateCache::default();

        let estimate = cache
            .estimate_selected(&workspace.root_handle, &[], &AtomicBool::new(false))
            .unwrap();

        assert_eq!(estimate.tokens, 0);
        assert_eq!(estimate.files, 0);
        assert_eq!(estimate.reused_files, 0);
        assert_eq!(estimate.computed_files, 0);
    }

    #[test]
    fn recomputes_only_a_file_whose_observed_version_changed() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("changed.rs"), "fn a() {}\n").unwrap();
        std::fs::write(temp.path().join("same.rs"), "fn same() {}\n").unwrap();
        let first_workspace = scan(temp.path());
        let cancel = AtomicBool::new(false);
        let cache = TokenEstimateCache::default();
        cache
            .estimate_selected(
                &first_workspace.root_handle,
                &first_workspace.manifest(),
                &cancel,
            )
            .unwrap();

        std::fs::write(
            temp.path().join("changed.rs"),
            "fn changed_with_more_bytes() {}\n",
        )
        .unwrap();
        let next_workspace = scan(temp.path());
        let next = cache
            .estimate_selected(
                &next_workspace.root_handle,
                &next_workspace.manifest(),
                &cancel,
            )
            .unwrap();

        assert_eq!(next.computed_files, 1);
        assert_eq!(next.reused_files, 1);
    }

    #[test]
    fn root_identity_change_does_not_reuse_matching_relative_paths() {
        let first_root = tempdir().unwrap();
        let second_root = tempdir().unwrap();
        std::fs::write(first_root.path().join("same.rs"), "fn first() {}\n").unwrap();
        std::fs::write(second_root.path().join("same.rs"), "fn second() {}\n").unwrap();
        let first_workspace = scan(first_root.path());
        let second_workspace = scan(second_root.path());
        let cancel = AtomicBool::new(false);
        let cache = TokenEstimateCache::default();
        cache
            .estimate_selected(
                &first_workspace.root_handle,
                &first_workspace.manifest(),
                &cancel,
            )
            .unwrap();

        let second = cache
            .estimate_selected(
                &second_workspace.root_handle,
                &second_workspace.manifest(),
                &cancel,
            )
            .unwrap();

        assert_eq!(second.computed_files, 1);
        assert_eq!(second.reused_files, 0);
    }

    #[test]
    fn tokenizer_id_change_invalidates_only_the_matching_cached_file() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(temp.path().join("b.rs"), "fn b() {}\n").unwrap();
        let workspace = scan(temp.path());
        let cancel = AtomicBool::new(false);
        let cache = TokenEstimateCache::default();
        cache
            .estimate_selected(&workspace.root_handle, &workspace.manifest(), &cancel)
            .unwrap();
        cache.lock().entries.get_mut("a.rs").unwrap().tokenizer_id = "other_encoding";

        let estimate = cache
            .estimate_selected(&workspace.root_handle, &workspace.manifest(), &cancel)
            .unwrap();

        assert_eq!(estimate.computed_files, 1);
        assert_eq!(estimate.reused_files, 1);
    }

    #[test]
    fn cache_entry_count_stays_within_the_workspace_index_limit() {
        let temp = tempdir().unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();
        let cache = TokenEstimateCache::default();
        cache.select_root(&root);
        let estimate = FileTokenEstimate {
            tokens: 1,
            size: 1,
            modified_ns: 1,
        };

        for index in 0..super::ENTRY_LIMIT {
            let entry = ManifestEntry {
                path: format!("file-{index}"),
                size: 1,
                modified_ns: 1,
            };
            cache.insert(&root, &entry, estimate.clone());
        }
        assert_eq!(cache.lock().entries.len(), super::ENTRY_LIMIT);

        let last = ManifestEntry {
            path: "new-file".into(),
            size: 1,
            modified_ns: 1,
        };
        cache.insert(&root, &last, estimate);

        let state = cache.lock();
        assert_eq!(state.entries.len(), super::ENTRY_LIMIT);
        assert!(state.path_bytes <= super::INDEX_TEXT_BYTES_LIMIT);
    }

    #[test]
    fn cancelled_or_invalid_files_are_not_inserted_into_the_cache() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("cancelled.rs"), "fn cancelled() {}\n").unwrap();
        std::fs::write(temp.path().join("binary.rs"), b"fn binary() {\0}\n").unwrap();
        let workspace = scan(temp.path());
        let cache = TokenEstimateCache::default();

        let error = cache
            .estimate_selected(
                &workspace.root_handle,
                &workspace.manifest(),
                &AtomicBool::new(true),
            )
            .expect_err("pre-cancelled estimate must fail");
        assert!(error.to_string().contains("cancelled"));
        assert!(cache.lock().entries.is_empty());

        let binary = ManifestEntry {
            path: "binary.rs".into(),
            ..manifest(&workspace.root_handle, "binary.rs")
        };
        let error = cache
            .estimate_selected(&workspace.root_handle, &[binary], &AtomicBool::new(false))
            .expect_err("invalid source must not produce a total");
        assert!(error.to_string().contains("binary NUL"));
        assert!(cache.lock().entries.is_empty());
    }

    #[test]
    fn checks_cancellation_between_text_chunks() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("large.txt"), vec![b'x'; 32 * 1024]).unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();
        let entry = manifest(&root, "large.txt");
        let cancel = AtomicBool::new(false);
        let mut reads = 0;

        let error =
            count_export_file_section_with_limit(&root, &entry, &cancel, 64 * 1024, &mut || {
                reads += 1;
                cancel.store(true, Ordering::Relaxed);
            })
            .expect_err("cancellation after a source read must stop the count");

        assert_eq!(reads, 1);
        assert_eq!(error.to_string(), "large.txt: token estimate cancelled");
    }

    #[test]
    fn rejects_an_input_limit_before_returning_a_partial_estimate() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("limited.txt"), b"more than four bytes").unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();
        let entry = manifest(&root, "limited.txt");

        let error = count_export_file_section_with_limit(
            &root,
            &entry,
            &AtomicBool::new(false),
            4,
            &mut || {},
        )
        .expect_err("input above the configured byte limit must not return a prefix count");

        assert!(error.to_string().contains("input limit"));
    }

    #[test]
    fn counts_large_text_in_fixed_size_chunks() {
        let temp = tempdir().unwrap();
        let body = "界".repeat(64 * 1024);
        std::fs::write(temp.path().join("large.txt"), body.as_bytes()).unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();
        let entry = manifest(&root, "large.txt");
        let cancel = AtomicBool::new(false);
        let mut chunk_count = 0;
        let mut max_chunk_bytes = 0;
        let mut body_tokens = 0u64;

        let estimate =
            count_export_file_section_with_limit(&root, &entry, &cancel, 256 * 1024, &mut || {
                chunk_count += 1
            })
            .unwrap();
        let mut source = content::open_safe(&root, "large.txt").unwrap();
        content::visit_decoded_text(
            &mut source,
            &cancel,
            "test cancelled",
            Some(256 * 1024),
            &mut || {},
            &mut |text| {
                max_chunk_bytes = max_chunk_bytes.max(text.len());
                body_tokens += tokenizer().count_ordinary(text) as u64;
                Ok(())
            },
        )
        .unwrap();
        let expected = ["## large.txt\n\n", "```text\n", "\n", "```\n\n"]
            .into_iter()
            .map(|segment| tokenizer().count_ordinary(segment) as u64)
            .sum::<u64>()
            + body_tokens;

        assert!(chunk_count > 8);
        assert!(max_chunk_bytes <= super::TOKEN_TEXT_CHUNK_BYTES + 3);
        assert_eq!(estimate.tokens, expected);
        assert_eq!(estimate.size, body.len() as u64);
    }

    #[test]
    fn counts_utf16_chunks_with_bounded_utf8_expansion() {
        let temp = tempdir().unwrap();
        let body = "界".repeat(16 * 1024);
        let mut encoded = vec![0xff, 0xfe];
        for word in body.encode_utf16() {
            encoded.extend_from_slice(&word.to_le_bytes());
        }
        std::fs::write(temp.path().join("utf16.txt"), &encoded).unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();
        let entry = manifest(&root, "utf16.txt");

        let estimate = count_export_file_section_with_limit(
            &root,
            &entry,
            &AtomicBool::new(false),
            encoded.len() as u64,
            &mut || {},
        )
        .unwrap();

        let mut body_tokens = 0;
        let mut max_chunk_bytes = 0;
        let mut source = content::open_safe(&root, "utf16.txt").unwrap();
        content::visit_decoded_text(
            &mut source,
            &AtomicBool::new(false),
            "test cancelled",
            Some(encoded.len() as u64),
            &mut || {},
            &mut |text| {
                max_chunk_bytes = max_chunk_bytes.max(text.len());
                body_tokens += tokenizer().count_ordinary(text) as u64;
                Ok(())
            },
        )
        .unwrap();

        let framing = ["## utf16.txt\n\n", "```text\n", "\n", "```\n\n"]
            .into_iter()
            .map(|segment| tokenizer().count_ordinary(segment) as u64)
            .sum::<u64>();
        assert!(max_chunk_bytes > super::TOKEN_TEXT_CHUNK_BYTES + 3);
        assert!(max_chunk_bytes <= content::MAX_DECODED_TEXT_CHUNK_BYTES);
        assert_eq!(estimate.tokens, body_tokens + framing);
    }

    #[test]
    fn refuses_a_source_changed_during_token_count() {
        let temp = tempdir().unwrap();
        let source_path = temp.path().join("changing.txt");
        let original = vec![b'a'; 32 * 1024];
        let changed = vec![b'b'; original.len() + 1];
        std::fs::write(&source_path, &original).unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();
        let entry = manifest(&root, "changing.txt");
        let mut changed_source = false;

        let error = count_export_file_section_with_limit(
            &root,
            &entry,
            &AtomicBool::new(false),
            64 * 1024,
            &mut || {
                if !changed_source {
                    changed_source = true;
                    std::fs::write(&source_path, &changed).unwrap();
                }
            },
        )
        .expect_err("a changed source cannot yield a successful count");

        assert!(changed_source);
        assert!(
            error
                .to_string()
                .contains("file changed during token estimate")
        );
    }
}
