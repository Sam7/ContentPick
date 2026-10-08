use crate::{
    Error, ManifestEntry, Result, WorkspaceRoot, content,
    selection::{self, Intent},
};
use globset::{Glob, GlobMatcher};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const ENTRY_LIMIT: usize = 200_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterPolicy {
    pub gitignore: bool,
    pub include_extensions: Vec<String>,
    pub exclude_extensions: Vec<String>,
    pub include_paths: Vec<String>,
    pub exclude_paths: Vec<String>,
}
impl Default for FilterPolicy {
    fn default() -> Self {
        Self {
            gitignore: true,
            include_extensions: vec![],
            exclude_extensions: vec![],
            include_paths: vec![],
            exclude_paths: vec![],
        }
    }
}

struct CompiledPolicy {
    include: Vec<(String, GlobMatcher)>,
    exclude: Vec<(String, GlobMatcher)>,
}
impl CompiledPolicy {
    fn new(policy: &FilterPolicy) -> Result<Self> {
        let compile = |rules: &[String]| {
            rules
                .iter()
                .map(|rule| {
                    Glob::new(rule)
                        .map(|g| (rule.clone(), g.compile_matcher()))
                        .map_err(|e| Error::Message(format!("invalid glob {rule}: {e}")))
                })
                .collect::<Result<Vec<_>>>()
        };
        Ok(Self {
            include: compile(&policy.include_paths)?,
            exclude: compile(&policy.exclude_paths)?,
        })
    }
    fn reason(&self, path: &str, directory: bool, policy: &FilterPolicy) -> Option<String> {
        if let Some((rule, _)) = self.exclude.iter().rev().find(|(_, g)| g.is_match(path)) {
            return Some(format!("custom exclude: {rule}"));
        }
        if directory {
            return None;
        }
        if !self.include.is_empty() && !self.include.iter().any(|(_, g)| g.is_match(path)) {
            return Some("custom include: no matching path".into());
        }
        let extension = extension(path);
        let matches = |rules: &[String]| {
            rules
                .iter()
                .any(|r| r.trim_start_matches('.').eq_ignore_ascii_case(&extension))
        };
        if matches(&policy.exclude_extensions) {
            return Some(format!("excluded extension: {extension}"));
        }
        if !policy.include_extensions.is_empty() && !matches(&policy.include_extensions) {
            return Some(format!("extension not allowed: {extension}"));
        }
        None
    }
}

fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.starts_with('.') && !name[1..].contains('.') {
        return name[1..].to_ascii_lowercase();
    }
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

#[derive(Clone)]
struct IndexedEntry {
    path: String,
    kind: String,
    size: u64,
    modified_ns: u64,
    hard: Option<String>,
    soft: Option<String>,
    enumerated: bool,
}

#[derive(Clone)]
pub struct Workspace {
    pub root: PathBuf,
    pub root_handle: WorkspaceRoot,
    pub policy: FilterPolicy,
    pub intents: BTreeMap<String, Intent>,
    pub browsed: BTreeSet<String>,
    pub generated_outputs: BTreeSet<String>,
    entries: Vec<IndexedEntry>,
    pub diagnostics: Vec<String>,
    pub enumerated_entries: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub selected: bool,
    pub force_included: bool,
    pub reason: Option<String>,
    pub enumerated: bool,
    pub partial: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub root: String,
    pub generation: u64,
    pub entries: Vec<EntryView>,
    pub selected_count: usize,
    pub estimated_bytes: u64,
    pub incomplete: bool,
    pub diagnostics: Vec<String>,
    pub policy: FilterPolicy,
}

impl Workspace {
    pub fn scan(
        root: &Path,
        policy: FilterPolicy,
        intents: BTreeMap<String, Intent>,
        browsed: BTreeSet<String>,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        Self::scan_with_outputs(root, policy, intents, browsed, BTreeSet::new(), cancel)
    }

    pub fn scan_with_outputs(
        root: &Path,
        policy: FilterPolicy,
        intents: BTreeMap<String, Intent>,
        browsed: BTreeSet<String>,
        generated_outputs: BTreeSet<String>,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let root_handle = WorkspaceRoot::open(root)?;
        Self::scan_pinned_with_outputs(
            root_handle,
            policy,
            intents,
            browsed,
            generated_outputs,
            cancel,
        )
    }

    pub fn scan_pinned(
        root_handle: WorkspaceRoot,
        policy: FilterPolicy,
        intents: BTreeMap<String, Intent>,
        browsed: BTreeSet<String>,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        Self::scan_pinned_with_outputs(
            root_handle,
            policy,
            intents,
            browsed,
            BTreeSet::new(),
            cancel,
        )
    }

    pub fn scan_pinned_with_outputs(
        root_handle: WorkspaceRoot,
        policy: FilterPolicy,
        intents: BTreeMap<String, Intent>,
        browsed: BTreeSet<String>,
        generated_outputs: BTreeSet<String>,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        root_handle.validate_anchor()?;
        let root = root_handle.path().to_path_buf();
        if !root.is_dir() {
            return Err(Error::Message("workspace is not a directory".into()));
        }
        let compiled = CompiledPolicy::new(&policy)?;
        let dir = root_handle.dir().try_clone()?;
        let mut workspace = Self {
            root,
            root_handle,
            policy,
            intents,
            browsed,
            generated_outputs,
            entries: vec![],
            diagnostics: vec![],
            enumerated_entries: 0,
        };
        workspace.scan_directory(&dir, "", &[], None, &compiled, cancel, 0)?;
        workspace.entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(workspace)
    }

    #[allow(clippy::too_many_arguments)]
    fn scan_directory(
        &mut self,
        dir: &cap_std::fs::Dir,
        relative: &str,
        parents: &[Gitignore],
        inherited_ignore: Option<String>,
        compiled: &CompiledPolicy,
        cancel: &AtomicBool,
        depth: usize,
    ) -> Result<()> {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Message("scan cancelled".into()));
        }
        if depth >= 128 {
            self.diagnostics
                .push(format!("{relative}: directory depth limit reached"));
            return Ok(());
        }
        let mut matchers = parents.to_vec();
        if self.policy.gitignore {
            let ignore_path = if relative.is_empty() {
                ".gitignore".to_owned()
            } else {
                format!("{relative}/.gitignore")
            };
            if let Ok(file) = content::open_safe(&self.root_handle, &ignore_path) {
                let mut text = String::new();
                match file.take(1024 * 1024 + 1).read_to_string(&mut text) {
                    Ok(_) if text.len() <= 1024 * 1024 => {
                        let mut builder = GitignoreBuilder::new(self.root.join(relative));
                        for line in text.lines() {
                            if let Err(e) =
                                builder.add_line(Some(PathBuf::from(&ignore_path)), line)
                            {
                                self.diagnostics.push(format!("{ignore_path}: {e}"));
                            }
                        }
                        match builder.build() {
                            Ok(matcher) => matchers.push(matcher),
                            Err(e) => self.diagnostics.push(format!("{ignore_path}: {e}")),
                        }
                    }
                    _ => self.diagnostics.push(format!(
                        "{ignore_path}: unreadable, invalid UTF-8 or larger than 1 MiB"
                    )),
                }
            }
        }
        let inherited_force =
            selection::evaluate(relative, None, inherited_ignore.as_deref(), &self.intents)
                .force_included;
        let targeted =
            inherited_ignore.is_some() && !self.browsed.contains(relative) && !inherited_force;
        let names: Vec<String> = if targeted {
            self.intents
                .iter()
                .filter(|(p, i)| {
                    **i == Intent::ForceInclude
                        && selection::is_descendant(p, relative)
                        && p.as_str() != relative
                })
                .filter_map(|(p, _)| {
                    p.strip_prefix(&format!("{relative}/"))
                        .and_then(|tail| tail.split('/').next())
                        .map(str::to_owned)
                })
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        } else {
            let location = if relative.is_empty() {
                Path::new(".")
            } else {
                Path::new(relative)
            };
            match dir.read_dir(location) {
                Ok(entries) => {
                    let mut names = vec![];
                    for entry in entries {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(Error::Message("scan cancelled".into()));
                        }
                        if names.len() + self.entries.len() >= ENTRY_LIMIT {
                            self.diagnostics
                                .push("entry limit reached; index is incomplete".into());
                            break;
                        }
                        match entry {
                            Ok(e) => match e.file_name().into_string() {
                                Ok(n) => names.push(n),
                                Err(_) => self.diagnostics.push(format!(
                                    "{relative}: non-UTF-8 filename cannot be represented safely"
                                )),
                            },
                            Err(e) => self.diagnostics.push(format!("{relative}: {e}")),
                        }
                    }
                    names.sort();
                    names
                }
                Err(e) => {
                    self.diagnostics.push(format!("{relative}: {e}"));
                    return Ok(());
                }
            }
        };
        for name in names {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Message("scan cancelled".into()));
            }
            if self.entries.len() >= ENTRY_LIMIT {
                break;
            }
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            self.enumerated_entries += 1;
            let metadata = match dir.symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    self.diagnostics.push(format!("{path}: {e}"));
                    continue;
                }
            };
            let mut linked = metadata.file_type().is_symlink();
            #[cfg(windows)]
            {
                use cap_std::fs::MetadataExt;
                linked |= metadata.file_attributes() & 0x400 != 0;
            }
            let directory = metadata.is_dir() && !linked;
            let mut hard = if linked {
                Some("link/reparse point: traversal disabled".into())
            } else if !metadata.is_file() && !directory {
                Some("not a regular file".into())
            } else {
                None
            };
            if path.split('/').any(|part| part == ".git") {
                hard = Some("Git metadata is not source context".into());
            }
            if let Some(reason) = self.generated_reason(&path) {
                hard = Some(reason.into());
            }
            let mut ignored = inherited_ignore.clone();
            if ignored.is_none() && self.policy.gitignore {
                for matcher in &matchers {
                    let matched = matcher.matched(self.root.join(&path), directory);
                    if let Some(rule) = matched.inner() {
                        ignored = if matched.is_ignore() {
                            Some(format!(
                                "gitignore {}: {}",
                                rule.from()
                                    .map(|p| p.display().to_string())
                                    .unwrap_or_default(),
                                rule.original()
                            ))
                        } else {
                            None
                        };
                    }
                }
            }
            let soft = compiled
                .reason(&path, directory, &self.policy)
                .or(ignored.clone());
            let preliminary =
                selection::evaluate(&path, hard.as_deref(), soft.as_deref(), &self.intents);
            if !directory && hard.is_none() {
                let ext = extension(&path);
                if [
                    "png", "jpg", "jpeg", "gif", "ico", "pdf", "zip", "exe", "dll", "woff",
                    "woff2", "mp4", "mp3", "bin",
                ]
                .contains(&ext.as_str())
                {
                    hard = Some("binary file type".into());
                } else if ![
                    "rs", "ts", "tsx", "js", "jsx", "json", "md", "txt", "toml", "yaml", "yml",
                    "css", "html", "xml", "csv", "py", "cs", "c", "cpp", "h", "go", "java",
                    "swift", "sh", "sql", "lock",
                ]
                .contains(&ext.as_str())
                    && (soft.is_none() || preliminary.force_included)
                {
                    match content::classify(&self.root_handle, &path) {
                        Ok(true) => {}
                        Ok(false) => hard = Some("binary or unsupported encoding".into()),
                        Err(e) => hard = Some(format!("unreadable: {e}")),
                    }
                }
            }
            let decision =
                selection::evaluate(&path, hard.as_deref(), soft.as_deref(), &self.intents);
            let required = self.intents.iter().any(|(p, i)| {
                *i == Intent::ForceInclude && selection::is_descendant(p, &path) && *p != path
            });
            let traverse = directory
                && hard.is_none()
                && (soft.is_none()
                    || decision.force_included
                    || required
                    || self.browsed.contains(&path));
            let stamp = metadata
                .modified()
                .ok()
                .and_then(|t| t.into_std().duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos().min(u64::MAX as u128) as u64)
                .unwrap_or(0);
            let complete = traverse
                && (soft.is_none() || decision.force_included || self.browsed.contains(&path));
            self.entries.push(IndexedEntry {
                path: path.clone(),
                kind: if directory {
                    "directory"
                } else if hard.is_some() {
                    "blocked"
                } else {
                    "file"
                }
                .into(),
                size: if directory { 0 } else { metadata.len() },
                modified_ns: stamp,
                hard,
                soft: soft.clone(),
                enumerated: !directory || complete,
            });
            if traverse {
                self.scan_directory(dir, &path, &matchers, soft, compiled, cancel, depth + 1)?;
            }
        }
        Ok(())
    }

    fn generated_reason(&self, path: &str) -> Option<&'static str> {
        (self.generated_outputs.contains(path)
            || path
                .split('/')
                .any(|name| name.starts_with(crate::destination::TEMP_PREFIX)))
        .then_some("generated output is excluded from source context")
    }

    fn hard_reason<'a>(&'a self, entry: &'a IndexedEntry) -> Option<&'a str> {
        self.generated_reason(&entry.path).or(entry.hard.as_deref())
    }

    pub fn manifest(&self) -> Vec<ManifestEntry> {
        self.entries
            .iter()
            .filter(|e| {
                e.kind == "file"
                    && selection::evaluate(
                        &e.path,
                        self.hard_reason(e),
                        e.soft.as_deref(),
                        &self.intents,
                    )
                    .selected
            })
            .map(|e| ManifestEntry {
                path: e.path.clone(),
                size: e.size,
                modified_ns: e.modified_ns,
            })
            .collect()
    }

    pub fn view(&self, generation: u64) -> WorkspaceView {
        let mut entries: Vec<_> = self
            .entries
            .iter()
            .map(|e| {
                let d = selection::evaluate(
                    &e.path,
                    self.hard_reason(e),
                    e.soft.as_deref(),
                    &self.intents,
                );
                EntryView {
                    path: e.path.clone(),
                    kind: if e.kind != "directory" && self.hard_reason(e).is_some() {
                        "blocked".into()
                    } else {
                        e.kind.clone()
                    },
                    size: e.size,
                    selected: d.selected,
                    force_included: d.force_included,
                    reason: d.reason,
                    enumerated: e.enumerated,
                    partial: false,
                }
            })
            .collect();
        let mut aggregates: BTreeMap<&str, (usize, usize, bool)> = BTreeMap::new();
        for entry in &entries {
            let mut parent = entry.path.as_str();
            while let Some((p, _)) = parent.rsplit_once('/') {
                let aggregate = aggregates.entry(p).or_default();
                if entry.kind == "file" {
                    aggregate.0 += 1;
                    aggregate.1 += usize::from(entry.selected);
                }
                aggregate.2 |= !entry.enumerated;
                parent = p;
            }
        }
        let aggregates: BTreeMap<String, _> = aggregates
            .into_iter()
            .map(|(p, a)| (p.to_owned(), a))
            .collect();
        for entry in &mut entries {
            if entry.kind == "directory" {
                if let Some((total, selected, unknown)) = aggregates.get(&entry.path) {
                    entry.partial =
                        *selected > 0 && (*selected < *total || *unknown || !entry.enumerated);
                    entry.selected = *selected > 0 && *selected == *total && !unknown;
                }
                if !entry.enumerated {
                    entry.selected = false;
                }
            }
        }
        // The index and manifest retain canonical lexical path order. The view is
        // presentation data, so expose a deterministic depth-first tree with
        // directories before files at each sibling level.
        let kinds: BTreeMap<String, bool> = entries
            .iter()
            .map(|entry| (entry.path.clone(), entry.kind == "directory"))
            .collect();
        entries.sort_by_cached_key(|entry| {
            let mut key = Vec::new();
            let mut prefix = String::new();
            for component in entry.path.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(component);
                let directory_first = kinds.get(prefix.as_str()).copied().unwrap_or(false);
                key.push((u8::from(!directory_first), component.to_owned()));
            }
            key
        });

        let manifest = self.manifest();
        WorkspaceView {
            policy: self.policy.clone(),
            root: self.root.display().to_string(),
            generation,
            selected_count: manifest.len(),
            estimated_bytes: manifest
                .iter()
                .map(|e| e.size.saturating_add(e.path.len() as u64 + 40))
                .sum::<u64>()
                .saturating_add(80),
            incomplete: entries.iter().any(|e| !e.enumerated) || !self.diagnostics.is_empty(),
            entries,
            diagnostics: self.diagnostics.clone(),
        }
    }
}
