use crate::{
    Error, ManifestEntry, Result, WorkspaceRoot, content,
    selection::{self, Intent},
};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering as CmpOrdering,
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub(crate) const ENTRY_LIMIT: usize = 200_000;
pub(crate) const INDEX_TEXT_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const DIAGNOSTIC_LIMIT: usize = 64;
const DIAGNOSTIC_BYTES_LIMIT: usize = 16 * 1024;
const DIAGNOSTIC_MESSAGE_BYTES_LIMIT: usize = 1024;
const DIAGNOSTIC_SUMMARY_RESERVE: usize = 128;
const DIAGNOSTIC_LIMIT_MESSAGE_RESERVE: usize = 3;
const DIAGNOSTIC_LIMIT_BYTES_RESERVE: usize =
    DIAGNOSTIC_LIMIT_MESSAGE_RESERVE * DIAGNOSTIC_MESSAGE_BYTES_LIMIT;
const FILTER_RULE_LIMIT: usize = 256;
const FILTER_RULE_BYTES_LIMIT: usize = 4 * 1024;
const FILTER_RULE_TEXT_BYTES_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy)]
struct ScanLimits {
    raw_entry_attempts: usize,
    retained_text_bytes: usize,
    gitignore_bytes: usize,
    gitignore_rules: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanOutcome {
    Complete,
    Incomplete,
    Exhausted,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            raw_entry_attempts: ENTRY_LIMIT,
            retained_text_bytes: INDEX_TEXT_BYTES_LIMIT,
            gitignore_bytes: 1024 * 1024,
            gitignore_rules: 4096,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct FilterPolicy {
    pub gitignore: bool,
    pub include_extensions: Vec<String>,
    pub include_paths: Vec<String>,
    pub exclude_paths: Vec<String>,
}
impl Default for FilterPolicy {
    fn default() -> Self {
        Self {
            gitignore: true,
            include_extensions: vec![],
            include_paths: vec![],
            exclude_paths: vec![],
        }
    }
}

impl FilterPolicy {
    pub fn validate(&self) -> Result<()> {
        CompiledPolicy::new(self).map(|_| ())
    }
}

pub(crate) const FILE_EXTENSION_RULE_PREFIX: &str = "file-ext:";
pub(crate) const LITERAL_GLOB_RULE_PREFIX: &str = "glob:";

pub(crate) fn migrated_extension_path_rule(legacy_extension: &str) -> String {
    let extension = legacy_extension
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let mut rule = String::from(FILE_EXTENSION_RULE_PREFIX);
    if extension.is_empty() {
        rule.push_str("<none>");
        return rule;
    }

    for byte in extension.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            rule.push(char::from(byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            rule.push('%');
            rule.push(char::from(HEX[(byte >> 4) as usize]));
            rule.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    rule
}

struct CompiledPolicy {
    include_rules: Vec<String>,
    include: GlobSet,
    exclude_rules: Vec<String>,
    exclude: GlobSet,
    exclude_glob_rule_indices: Vec<usize>,
    exclude_file_extensions: Vec<(usize, String)>,
}
impl CompiledPolicy {
    fn new(policy: &FilterPolicy) -> Result<Self> {
        let rule_lists = [
            ("include extension", &policy.include_extensions),
            ("include path", &policy.include_paths),
            ("exclude path", &policy.exclude_paths),
        ];
        let rule_count = rule_lists
            .iter()
            .map(|(_, rules)| rules.len())
            .sum::<usize>();
        if rule_count > FILTER_RULE_LIMIT {
            return Err(Error::Message(format!(
                "filter policy allows at most {FILTER_RULE_LIMIT} total rules across extension and path filters; remove some rules"
            )));
        }
        let mut total_bytes = 0usize;
        for (kind, rules) in rule_lists {
            for (index, rule) in rules.iter().enumerate() {
                if rule.len() > FILTER_RULE_BYTES_LIMIT {
                    return Err(Error::Message(format!(
                        "filter policy {kind} rule #{} exceeds 4 KiB per rule; shorten it",
                        index + 1
                    )));
                }
                total_bytes = total_bytes.saturating_add(rule.len());
            }
        }
        if total_bytes > FILTER_RULE_TEXT_BYTES_LIMIT {
            return Err(Error::Message(
                "filter policy allows at most 64 KiB of total rule text; shorten or remove rules"
                    .into(),
            ));
        }

        let include = compile_path_rules("include", &policy.include_paths, false)?;
        let exclude = compile_path_rules("exclude", &policy.exclude_paths, true)?;
        Ok(Self {
            include_rules: policy.include_paths.clone(),
            include: include.globs,
            exclude_rules: policy.exclude_paths.clone(),
            exclude: exclude.globs,
            exclude_glob_rule_indices: exclude.glob_rule_indices,
            exclude_file_extensions: exclude.file_extensions,
        })
    }
    fn reason(&self, path: &str, directory: bool, policy: &FilterPolicy) -> Option<String> {
        let mut matched_exclude = self
            .exclude
            .matches(path)
            .last()
            .map(|glob_index| self.exclude_glob_rule_indices[*glob_index]);
        if !directory {
            let extension = extension(path);
            if let Some((rule_index, _)) = self
                .exclude_file_extensions
                .iter()
                .rev()
                .find(|(_, rule_extension)| rule_extension.eq_ignore_ascii_case(&extension))
            {
                matched_exclude =
                    Some(matched_exclude.map_or(*rule_index, |current| current.max(*rule_index)));
            }
        }
        if let Some(index) = matched_exclude {
            return Some(format!("custom exclude: {}", self.exclude_rules[index]));
        }
        if directory {
            return None;
        }
        if !self.include_rules.is_empty() && !self.include.is_match(path) {
            return Some("custom include: no matching path".into());
        }
        let extension = extension(path);
        let include_matches = policy.include_extensions.iter().any(|rule| {
            rule.trim_start_matches('.')
                .eq_ignore_ascii_case(&extension)
        });
        if !policy.include_extensions.is_empty() && !include_matches {
            return Some(format!("extension not allowed: {extension}"));
        }
        None
    }
}

struct CompiledPathRules {
    globs: GlobSet,
    glob_rule_indices: Vec<usize>,
    file_extensions: Vec<(usize, String)>,
}

fn compile_path_rules(
    kind: &str,
    rules: &[String],
    allow_file_extension_rules: bool,
) -> Result<CompiledPathRules> {
    let mut builder = GlobSetBuilder::new();
    let mut glob_rule_indices = Vec::new();
    let mut file_extensions = Vec::new();
    for (index, rule) in rules.iter().enumerate() {
        if allow_file_extension_rules
            && let Some(encoded_extension) = rule.strip_prefix(FILE_EXTENSION_RULE_PREFIX)
        {
            let extension = decode_file_extension_rule(encoded_extension).map_err(|error| {
                Error::Message(format!(
                    "invalid filter policy exclude path rule #{}: {error}",
                    index + 1
                ))
            })?;
            file_extensions.push((index, extension));
            continue;
        }
        let pattern = if allow_file_extension_rules {
            rule.strip_prefix(LITERAL_GLOB_RULE_PREFIX).unwrap_or(rule)
        } else {
            rule
        };
        let glob = Glob::new(pattern).map_err(|e| {
            Error::Message(format!(
                "invalid filter policy {kind} path rule #{}: {e}",
                index + 1
            ))
        })?;
        builder.add(glob);
        glob_rule_indices.push(index);
    }
    let set = builder.build().map_err(|_| {
        Error::Message(format!(
            "filter policy {kind} path rules are too complex to compile; simplify or remove rules"
        ))
    })?;
    Ok(CompiledPathRules {
        globs: set,
        glob_rule_indices,
        file_extensions,
    })
}

fn decode_file_extension_rule(encoded: &str) -> std::result::Result<String, &'static str> {
    if encoded == "<none>" {
        return Ok(String::new());
    }
    if encoded.is_empty() {
        return Err("use <none> for extensionless files");
    }
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("incomplete percent escape");
            }
            let high = decode_hex(bytes[index + 1]).ok_or("invalid percent escape")?;
            let low = decode_hex(bytes[index + 2]).ok_or("invalid percent escape")?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            if !bytes[index].is_ascii_alphanumeric()
                && !matches!(bytes[index], b'-' | b'_' | b'.' | b'~')
            {
                return Err(
                    "characters outside the encoded rule alphabet must use percent escapes",
                );
            }
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "percent escapes must form UTF-8 text")
}

fn decode_hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
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
    git_ignore_matched: bool,
    custom_excluded: bool,
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
    entries: Arc<Vec<IndexedEntry>>,
    pub diagnostics: Vec<String>,
    pub enumerated_entries: usize,
    diagnostic_bytes: usize,
    omitted_diagnostics: usize,
    scan_limits: ScanLimits,
    raw_entry_attempts: usize,
    retained_text_bytes: usize,
    gitignore_body_bytes_read: usize,
    gitignore_rule_count: usize,
    gitignore_bytes_exhausted: bool,
    gitignore_rules_exhausted: bool,
    gitignore_budget_reported: bool,
    raw_entry_limit_reported: bool,
    retained_text_limit_reported: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub selected: bool,
    pub force_included: bool,
    pub git_ignored: bool,
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
        Self::scan_pinned_with_limits(
            root_handle,
            policy,
            intents,
            browsed,
            generated_outputs,
            ScanLimits::default(),
            cancel,
        )
    }

    fn scan_pinned_with_limits(
        root_handle: WorkspaceRoot,
        policy: FilterPolicy,
        intents: BTreeMap<String, Intent>,
        browsed: BTreeSet<String>,
        generated_outputs: BTreeSet<String>,
        scan_limits: ScanLimits,
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
            entries: Arc::new(vec![]),
            diagnostics: vec![],
            enumerated_entries: 0,
            diagnostic_bytes: 0,
            omitted_diagnostics: 0,
            scan_limits,
            raw_entry_attempts: 0,
            retained_text_bytes: 0,
            gitignore_body_bytes_read: 0,
            gitignore_rule_count: 0,
            gitignore_bytes_exhausted: false,
            gitignore_rules_exhausted: false,
            gitignore_budget_reported: false,
            raw_entry_limit_reported: false,
            retained_text_limit_reported: false,
        };
        workspace.scan_directory(&dir, "", &[], None, false, &compiled, cancel, 0)?;
        workspace.finalize_diagnostics();
        Arc::make_mut(&mut workspace.entries).sort_by(|a, b| a.path.cmp(&b.path));
        Ok(workspace)
    }

    fn count_raw_entry_attempt(&mut self) -> bool {
        if self.raw_entry_attempts >= self.scan_limits.raw_entry_attempts {
            self.report_raw_entry_limit();
            return false;
        }
        self.raw_entry_attempts += 1;
        true
    }

    fn report_raw_entry_limit(&mut self) {
        if !self.raw_entry_limit_reported {
            self.push_limit_diagnostic(
                "raw directory entry limit reached; scan is incomplete".into(),
            );
            self.raw_entry_limit_reported = true;
        }
    }

    fn reserve_entry_text(&mut self, path: &str, hard: Option<&str>, soft: Option<&str>) -> bool {
        let bytes = path
            .len()
            .saturating_add(hard.map(str::len).unwrap_or_default())
            .saturating_add(soft.map(str::len).unwrap_or_default());
        if self.retained_text_bytes.saturating_add(bytes) > self.scan_limits.retained_text_bytes {
            if !self.retained_text_limit_reported {
                self.push_limit_diagnostic(format!(
                    "{path}: retained metadata text budget reached; scan is incomplete"
                ));
                self.retained_text_limit_reported = true;
            }
            return false;
        }
        self.retained_text_bytes += bytes;
        true
    }

    fn push_diagnostic(&mut self, message: String) {
        let message = truncate_diagnostic(&message);
        let byte_limit_before_summary = DIAGNOSTIC_BYTES_LIMIT
            .saturating_sub(DIAGNOSTIC_SUMMARY_RESERVE)
            .saturating_sub(DIAGNOSTIC_LIMIT_BYTES_RESERVE);
        let diagnostic_count_limit = DIAGNOSTIC_LIMIT - 1 - DIAGNOSTIC_LIMIT_MESSAGE_RESERVE;
        let fits = self.diagnostics.len() < diagnostic_count_limit
            && self.diagnostic_bytes.saturating_add(message.len()) <= byte_limit_before_summary;
        if fits {
            self.diagnostic_bytes += message.len();
            self.diagnostics.push(message);
        } else {
            self.omitted_diagnostics = self.omitted_diagnostics.saturating_add(1);
        }
    }

    fn push_limit_diagnostic(&mut self, message: String) {
        let message = truncate_diagnostic(&message);
        debug_assert!(message.len() <= DIAGNOSTIC_MESSAGE_BYTES_LIMIT);
        debug_assert!(self.diagnostics.len() < DIAGNOSTIC_LIMIT - 1);
        debug_assert!(
            self.diagnostic_bytes.saturating_add(message.len())
                <= DIAGNOSTIC_BYTES_LIMIT - DIAGNOSTIC_SUMMARY_RESERVE
        );
        self.diagnostic_bytes += message.len();
        self.diagnostics.push(message);
    }

    fn finalize_diagnostics(&mut self) {
        if self.omitted_diagnostics == 0 {
            return;
        }
        let summary = format!(
            "Additional scan diagnostics omitted: {}",
            self.omitted_diagnostics
        );
        debug_assert!(summary.len() <= DIAGNOSTIC_SUMMARY_RESERVE);
        debug_assert!(self.diagnostics.len() < DIAGNOSTIC_LIMIT);
        debug_assert!(
            self.diagnostic_bytes.saturating_add(summary.len()) <= DIAGNOSTIC_BYTES_LIMIT
        );
        self.diagnostic_bytes += summary.len();
        self.diagnostics.push(summary);
    }

    #[allow(clippy::too_many_arguments)]
    fn scan_directory(
        &mut self,
        dir: &cap_std::fs::Dir,
        relative: &str,
        parents: &[Arc<Gitignore>],
        inherited_ignore: Option<String>,
        inherited_git_ignored: bool,
        compiled: &CompiledPolicy,
        cancel: &AtomicBool,
        depth: usize,
    ) -> Result<ScanOutcome> {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Message("scan cancelled".into()));
        }
        if depth >= 128 {
            self.push_diagnostic(format!("{relative}: directory depth limit reached"));
            return Ok(ScanOutcome::Incomplete);
        }
        let mut matchers = parents.to_vec();
        let mut outcome = ScanOutcome::Complete;
        let mut local_ignore_failure_reason = None;
        if self.policy.gitignore {
            let ignore_path = if relative.is_empty() {
                ".gitignore".to_owned()
            } else {
                format!("{relative}/.gitignore")
            };
            match content::open_safe(&self.root_handle, &ignore_path) {
                Ok(file) => {
                    if self.gitignore_bytes_exhausted || self.gitignore_rules_exhausted {
                        let reason = format!(
                            "{ignore_path}: ignore source not read because the cumulative .gitignore budget is exhausted; subtree is conservatively excluded"
                        );
                        self.push_diagnostic(reason.clone());
                        local_ignore_failure_reason = Some(reason);
                        outcome = ScanOutcome::Incomplete;
                    } else {
                        let remaining_bytes = self
                            .scan_limits
                            .gitignore_bytes
                            .saturating_sub(self.gitignore_body_bytes_read);
                        let read_limit = remaining_bytes.saturating_add(1).min(1024 * 1024 + 1);
                        let mut bytes = Vec::new();
                        let read_result = file.take(read_limit as u64).read_to_end(&mut bytes);
                        self.gitignore_body_bytes_read =
                            self.gitignore_body_bytes_read.saturating_add(bytes.len());
                        let byte_limit_exceeded =
                            self.gitignore_body_bytes_read > self.scan_limits.gitignore_bytes;
                        if byte_limit_exceeded {
                            self.gitignore_bytes_exhausted = true;
                        }

                        if let Err(error) = read_result {
                            let reason = if byte_limit_exceeded {
                                format!(
                                    "{ignore_path}: cumulative .gitignore budget (input) exceeded; subtree is conservatively excluded"
                                )
                            } else {
                                format!(
                                    "{ignore_path}: unreadable .gitignore ({error}); subtree is conservatively excluded"
                                )
                            };
                            if byte_limit_exceeded && !self.gitignore_budget_reported {
                                self.push_limit_diagnostic(reason.clone());
                                self.gitignore_budget_reported = true;
                            } else {
                                self.push_diagnostic(reason.clone());
                            }
                            local_ignore_failure_reason = Some(reason);
                            outcome = ScanOutcome::Incomplete;
                        } else if byte_limit_exceeded {
                            let reason = format!(
                                "{ignore_path}: cumulative .gitignore budget (input) exceeded; subtree is conservatively excluded"
                            );
                            if !self.gitignore_budget_reported {
                                self.push_limit_diagnostic(reason.clone());
                                self.gitignore_budget_reported = true;
                            }
                            local_ignore_failure_reason = Some(reason);
                            outcome = ScanOutcome::Incomplete;
                        } else if bytes.len() > 1024 * 1024 {
                            let reason = format!(
                                "{ignore_path}: .gitignore exceeds 1 MiB; subtree is conservatively excluded"
                            );
                            self.push_diagnostic(reason.clone());
                            local_ignore_failure_reason = Some(reason);
                            outcome = ScanOutcome::Incomplete;
                        } else {
                            match String::from_utf8(bytes) {
                                Err(error) => {
                                    let reason = format!(
                                        "{ignore_path}: invalid UTF-8 .gitignore ({error}); subtree is conservatively excluded"
                                    );
                                    self.push_diagnostic(reason.clone());
                                    local_ignore_failure_reason = Some(reason);
                                    outcome = ScanOutcome::Incomplete;
                                }
                                Ok(text) => {
                                    let rule_count = text.lines().count();
                                    if self.gitignore_rule_count.saturating_add(rule_count)
                                        > self.scan_limits.gitignore_rules
                                    {
                                        self.gitignore_rules_exhausted = true;
                                        self.gitignore_rule_count =
                                            self.gitignore_rule_count.saturating_add(rule_count);
                                        let reason = format!(
                                            "{ignore_path}: cumulative .gitignore budget (rule) exceeded; subtree is conservatively excluded"
                                        );
                                        if !self.gitignore_budget_reported {
                                            self.push_limit_diagnostic(reason.clone());
                                            self.gitignore_budget_reported = true;
                                        }
                                        local_ignore_failure_reason = Some(reason);
                                        outcome = ScanOutcome::Incomplete;
                                    } else {
                                        self.gitignore_rule_count += rule_count;
                                        let mut builder =
                                            GitignoreBuilder::new(self.root.join(relative));
                                        let mut parse_failed = false;
                                        for line in text.lines() {
                                            if let Err(e) = builder
                                                .add_line(Some(PathBuf::from(&ignore_path)), line)
                                            {
                                                self.push_diagnostic(format!("{ignore_path}: {e}"));
                                                parse_failed = true;
                                            }
                                        }
                                        if parse_failed {
                                            let reason = format!(
                                                "{ignore_path}: one or more ignore rules could not be parsed; subtree is conservatively excluded"
                                            );
                                            self.push_diagnostic(reason.clone());
                                            local_ignore_failure_reason = Some(reason);
                                            outcome = ScanOutcome::Incomplete;
                                        } else {
                                            match builder.build() {
                                                Ok(matcher) => matchers.push(Arc::new(matcher)),
                                                Err(e) => {
                                                    let reason = format!(
                                                        "{ignore_path}: ignore rules could not be compiled ({e}); subtree is conservatively excluded"
                                                    );
                                                    self.push_diagnostic(reason.clone());
                                                    local_ignore_failure_reason = Some(reason);
                                                    outcome = ScanOutcome::Incomplete;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    let is_non_file = matches!(
                        &error,
                        Error::Message(message) if message.starts_with("not a regular file:")
                    );
                    if is_non_file {
                        self.push_diagnostic(format!("{ignore_path}: {error}"));
                    } else {
                        let reason = format!(
                            "{ignore_path}: unreadable ignore source ({error}); subtree is conservatively excluded"
                        );
                        self.push_diagnostic(reason.clone());
                        local_ignore_failure_reason = Some(reason);
                    }
                    outcome = ScanOutcome::Incomplete;
                }
            }
        }
        let inherited_ignore = inherited_ignore.or(local_ignore_failure_reason);
        let inherited_force =
            selection::evaluate(relative, None, inherited_ignore.as_deref(), &self.intents)
                .force_included;
        let targeted =
            inherited_ignore.is_some() && !self.browsed.contains(relative) && !inherited_force;
        let names: Vec<String> = if targeted {
            let mut names = BTreeSet::new();
            let remaining = self
                .scan_limits
                .raw_entry_attempts
                .saturating_sub(self.raw_entry_attempts);
            let mut exceeded_limit = false;
            let prefix = if relative.is_empty() {
                String::new()
            } else {
                format!("{relative}/")
            };
            for (path, intent) in &self.intents {
                if *intent != Intent::ForceInclude
                    || !selection::is_descendant(path, relative)
                    || path.as_str() == relative
                {
                    continue;
                }
                let Some(name) = path
                    .strip_prefix(&prefix)
                    .and_then(|tail| tail.split('/').next())
                    .map(str::to_owned)
                else {
                    continue;
                };
                if !names.contains(&name) {
                    if names.len() >= remaining {
                        exceeded_limit = true;
                        break;
                    }
                    names.insert(name);
                }
            }
            self.raw_entry_attempts += names.len();
            if exceeded_limit {
                self.report_raw_entry_limit();
                outcome = ScanOutcome::Exhausted;
            }
            names.into_iter().collect()
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
                        if !self.count_raw_entry_attempt() {
                            outcome = ScanOutcome::Exhausted;
                            break;
                        }
                        match entry {
                            Ok(e) => match e.file_name().into_string() {
                                Ok(n) => names.push(n),
                                Err(_) => {
                                    self.push_diagnostic(format!(
                                        "{relative}: non-UTF-8 filename cannot be represented safely"
                                    ));
                                    outcome = ScanOutcome::Incomplete;
                                }
                            },
                            Err(e) => {
                                self.push_diagnostic(format!("{relative}: {e}"));
                                outcome = ScanOutcome::Incomplete;
                            }
                        }
                    }
                    names.sort();
                    names
                }
                Err(e) => {
                    self.push_diagnostic(format!("{relative}: {e}"));
                    return Ok(ScanOutcome::Incomplete);
                }
            }
        };
        for name in names {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Message("scan cancelled".into()));
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
                    self.push_diagnostic(format!("{path}: {e}"));
                    if outcome == ScanOutcome::Complete {
                        outcome = ScanOutcome::Incomplete;
                    }
                    continue;
                }
            };
            let linked = metadata.file_type().is_symlink();
            #[cfg(windows)]
            let linked = {
                use cap_std::fs::MetadataExt;
                linked || metadata.file_attributes() & 0x400 != 0
            };
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
            let mut git_ignored = inherited_git_ignored;
            if ignored.is_none() && self.policy.gitignore {
                for matcher in &matchers {
                    let matched = matcher.matched(self.root.join(&path), directory);
                    if let Some(rule) = matched.inner() {
                        ignored = if matched.is_ignore() {
                            git_ignored = true;
                            Some(format!(
                                "gitignore {}: {}",
                                rule.from()
                                    .map(|p| p.display().to_string())
                                    .unwrap_or_default(),
                                rule.original()
                            ))
                        } else {
                            git_ignored = false;
                            None
                        };
                    }
                }
            }
            let custom_exclusion = compiled.reason(&path, directory, &self.policy);
            let soft = custom_exclusion.clone().or(ignored.clone());
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
            if !self.reserve_entry_text(&path, hard.as_deref(), soft.as_deref()) {
                outcome = ScanOutcome::Exhausted;
                break;
            }
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
            let entry_index = self.entries.len();
            Arc::make_mut(&mut self.entries).push(IndexedEntry {
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
                git_ignore_matched: git_ignored,
                custom_excluded: custom_exclusion.is_some(),
                enumerated: !directory || complete,
            });
            if traverse {
                let inherited_git_ignored = git_ignored && custom_exclusion.is_none();
                let subtree_outcome = self.scan_directory(
                    dir,
                    &path,
                    &matchers,
                    soft,
                    inherited_git_ignored,
                    compiled,
                    cancel,
                    depth + 1,
                )?;
                if subtree_outcome != ScanOutcome::Complete {
                    Arc::make_mut(&mut self.entries)[entry_index].enumerated = false;
                    if subtree_outcome == ScanOutcome::Exhausted {
                        outcome = ScanOutcome::Exhausted;
                        break;
                    }
                    if outcome == ScanOutcome::Complete {
                        outcome = ScanOutcome::Incomplete;
                    }
                }
            }
        }
        Ok(outcome)
    }

    fn generated_reason(&self, path: &str) -> Option<&'static str> {
        (self.generated_outputs.contains(path)
            || crate::destination::is_export_temporary_path(Path::new(path)))
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
                    git_ignored: e.git_ignore_matched
                        && !e.custom_excluded
                        && self.hard_reason(e).is_none()
                        && !matches!(
                            selection::effective_intent(&e.path, &self.intents),
                            Some(Intent::Exclude | Intent::ForceExclude | Intent::ForceInclude)
                        ),
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
        let directory_paths: BTreeSet<&str> = self
            .entries
            .iter()
            .filter(|entry| entry.kind == "directory")
            .map(|entry| entry.path.as_str())
            .collect();
        entries
            .sort_by(|left, right| compare_tree_paths(&left.path, &right.path, &directory_paths));

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

fn compare_tree_paths(left: &str, right: &str, directories: &BTreeSet<&str>) -> CmpOrdering {
    let mut left_start = 0;
    let mut right_start = 0;
    let mut left_parts = left.split('/');
    let mut right_parts = right.split('/');

    loop {
        match (left_parts.next(), right_parts.next()) {
            (Some(left_part), Some(right_part)) if left_part == right_part => {
                left_start += left_part.len() + 1;
                right_start += right_part.len() + 1;
            }
            (Some(left_part), Some(right_part)) => {
                let left_end = left_start + left_part.len();
                let right_end = right_start + right_part.len();
                let left_is_directory = directories.contains(&left[..left_end]);
                let right_is_directory = directories.contains(&right[..right_end]);
                return (!left_is_directory)
                    .cmp(&(!right_is_directory))
                    .then_with(|| left_part.cmp(right_part));
            }
            (None, None) => return CmpOrdering::Equal,
            (None, Some(_)) => return CmpOrdering::Less,
            (Some(_), None) => return CmpOrdering::Greater,
        }
    }
}

fn truncate_diagnostic(message: &str) -> String {
    if message.len() <= DIAGNOSTIC_MESSAGE_BYTES_LIMIT {
        return message.to_owned();
    }

    const MARKER: &str = " …[truncated]… ";
    let available = DIAGNOSTIC_MESSAGE_BYTES_LIMIT - MARKER.len();
    let prefix_budget = available * 3 / 4;
    let suffix_budget = available - prefix_budget;
    let mut prefix_end = prefix_budget;
    while !message.is_char_boundary(prefix_end) {
        prefix_end -= 1;
    }
    let mut suffix_start = message.len() - suffix_budget;
    while !message.is_char_boundary(suffix_start) {
        suffix_start += 1;
    }
    format!(
        "{}{}{}",
        &message[..prefix_end],
        MARKER,
        &message[suffix_start..]
    )
}

#[cfg(test)]
mod diagnostic_tests {
    use super::{
        CompiledPolicy, DIAGNOSTIC_BYTES_LIMIT, DIAGNOSTIC_LIMIT, FilterPolicy, ScanLimits,
        Workspace, decode_file_extension_rule, extension, migrated_extension_path_rule,
        truncate_diagnostic,
    };
    use crate::{WorkspaceRoot, selection::Intent};
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::atomic::AtomicBool,
    };

    #[test]
    fn migrated_extension_rules_preserve_legacy_extension_normalization() {
        assert_eq!(extension("Makefile"), "");
        assert_eq!(extension("trailing."), "");
        assert_eq!(extension(".env"), "env");
        assert_eq!(extension("nested/.hidden.Rs"), "rs");
        assert_eq!(migrated_extension_path_rule(".rS"), "file-ext:rs");
        assert_eq!(migrated_extension_path_rule(""), "file-ext:<none>");
        assert_eq!(migrated_extension_path_rule("*?["), "file-ext:%2A%3F%5B");
        assert_eq!(decode_file_extension_rule("%2A%3F%5B"), Ok("*?[".into()));
        assert_eq!(
            decode_file_extension_rule("%GG"),
            Err("invalid percent escape")
        );
        assert_eq!(
            decode_file_extension_rule(""),
            Err("use <none> for extensionless files")
        );
    }

    #[test]
    fn encoded_extension_and_escaped_glob_rules_keep_literal_matches() {
        let policy = FilterPolicy {
            exclude_paths: vec![
                "file-ext:%2A%3F%5B".into(),
                "glob:glob:*.rs".into(),
                "glob:file-ext:literal".into(),
            ],
            ..FilterPolicy::default()
        };
        let compiled = CompiledPolicy::new(&policy).unwrap();

        assert_eq!(
            compiled.reason("name.*?[", false, &policy).as_deref(),
            Some("custom exclude: file-ext:%2A%3F%5B")
        );
        assert_eq!(
            compiled.reason("glob:source.rs", false, &policy).as_deref(),
            Some("custom exclude: glob:glob:*.rs")
        );
        assert_eq!(
            compiled
                .reason("file-ext:literal", false, &policy)
                .as_deref(),
            Some("custom exclude: glob:file-ext:literal")
        );
        assert_eq!(compiled.reason("source.rs", false, &policy), None);
    }

    #[test]
    fn diagnostic_truncation_preserves_utf8_boundary_prefix_and_suffix() {
        let message = format!("useful path: {}: useful error reason", "é".repeat(800));
        let truncated = truncate_diagnostic(&message);

        assert!(truncated.len() <= 1024);
        assert!(truncated.starts_with("useful path: "));
        assert!(truncated.contains("[truncated]"));
        assert!(truncated.ends_with("useful error reason"));
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());
    }

    #[test]
    fn raw_entry_budget_stops_descendant_and_marks_its_directory_incomplete() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("tree/inner")).unwrap();
        std::fs::write(temp.path().join("a.ts"), "a").unwrap();
        std::fs::write(temp.path().join("tree/inner/b.ts"), "b").unwrap();

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                raw_entry_attempts: 2,
                retained_text_bytes: usize::MAX,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        let view = workspace.view(1);
        let tree = view
            .entries
            .iter()
            .find(|entry| entry.path == "tree")
            .unwrap();
        assert!(!tree.enumerated);
        assert!(!view.entries.iter().any(|entry| entry.path == "tree/inner"));
        assert_eq!(workspace.enumerated_entries, 2);
        assert!(view.incomplete);
        assert_eq!(
            view.diagnostics
                .iter()
                .filter(|message| message.contains("raw directory entry limit"))
                .count(),
            1
        );
    }

    #[test]
    fn git_ignore_classification_excludes_policy_intents_safety_and_unknown_rules() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("ignored-dir")).unwrap();
        std::fs::create_dir_all(temp.path().join("unavailable")).unwrap();
        std::fs::write(
            temp.path().join(".gitignore"),
            "ignored-dir/\n*.log\n*.png\n",
        )
        .unwrap();
        std::fs::write(temp.path().join("unavailable/.gitignore"), "{malformed\n").unwrap();
        for path in [
            "ignored-dir/hidden.ts",
            "ignored-dir/forced.ts",
            "ignored-dir/user.ts",
            "custom.log",
            "user.log",
            "forced.log",
            "hard.png",
            "unavailable/hidden.ts",
            "visible.ts",
        ] {
            std::fs::write(temp.path().join(path), "source").unwrap();
        }

        let mut policy = FilterPolicy::default();
        policy.exclude_paths.push("custom.log".into());
        let intents = BTreeMap::from([
            ("ignored-dir/forced.ts".into(), Intent::ForceInclude),
            ("ignored-dir/user.ts".into(), Intent::Exclude),
            ("user.log".into(), Intent::Exclude),
            ("forced.log".into(), Intent::ForceInclude),
        ]);
        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            policy,
            intents,
            BTreeSet::from(["ignored-dir".into(), "unavailable".into()]),
            BTreeSet::new(),
            ScanLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
        let entries = workspace.view(1).entries;
        let classified = |path: &str| {
            entries
                .iter()
                .find(|entry| entry.path == path)
                .unwrap_or_else(|| panic!("missing entry {path}"))
                .git_ignored
        };

        assert!(
            classified("ignored-dir"),
            "lazy Git-ignored folder is classified"
        );
        assert!(
            classified("ignored-dir/hidden.ts"),
            "browsed ignored descendants inherit classification"
        );
        assert!(
            !classified("ignored-dir/forced.ts"),
            "force-included paths are not effectively ignored"
        );
        assert!(
            !classified("ignored-dir/user.ts"),
            "user exclusions are not Git-ignore results"
        );
        assert!(
            !classified("custom.log"),
            "custom rules take classification precedence"
        );
        assert!(
            !classified("user.log"),
            "manual exclusions are not Git-ignore results"
        );
        assert!(
            !classified("forced.log"),
            "force-included files are not ignored"
        );
        assert!(
            !classified("hard.png"),
            "hard safety blocks are not Git-ignore results"
        );
        assert!(
            !classified("unavailable/hidden.ts"),
            "unknown-rule failures are not Git-ignore results"
        );
        assert!(!classified("visible.ts"));
    }

    #[test]
    fn retained_text_budget_stops_descendants_and_marks_all_ancestors_incomplete() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("outer/inner")).unwrap();
        std::fs::write(temp.path().join("outer/inner/source.ts"), "text").unwrap();

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                raw_entry_attempts: usize::MAX,
                retained_text_bytes: "outer".len() + "outer/inner".len(),
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        let view = workspace.view(1);
        for path in ["outer", "outer/inner"] {
            let directory = view
                .entries
                .iter()
                .find(|entry| entry.path == path)
                .unwrap();
            assert!(
                !directory.enumerated,
                "{path} incorrectly claims completeness"
            );
        }
        assert!(
            !view
                .entries
                .iter()
                .any(|entry| entry.path.ends_with("source.ts"))
        );
        assert!(view.incomplete);
        assert!(
            view.diagnostics
                .iter()
                .any(|message| { message.contains("retained metadata text budget") })
        );
    }

    #[test]
    fn cumulative_gitignore_budget_is_injected_and_preserves_siblings() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("a")).unwrap();
        std::fs::create_dir_all(temp.path().join("b")).unwrap();
        std::fs::write(temp.path().join("a/.gitignore"), "*.ts\n").unwrap();
        std::fs::write(temp.path().join("b/.gitignore"), "hidden.ts\n").unwrap();
        std::fs::write(temp.path().join("a/hidden.ts"), "ignored by known rule").unwrap();
        std::fs::write(temp.path().join("b/hidden.ts"), "unknown rule").unwrap();
        std::fs::write(temp.path().join("b/forced.ts"), "explicit intent").unwrap();
        std::fs::write(temp.path().join("z.ts"), "readable sibling").unwrap();
        let intents = BTreeMap::from([("b/forced.ts".into(), Intent::ForceInclude)]);

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            intents,
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                gitignore_bytes: 5,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let view = workspace.view(1);

        assert!(
            view.incomplete,
            "budget exhaustion must mark the scan incomplete"
        );
        assert!(view.diagnostics.iter().any(|message| {
            message.contains("cumulative .gitignore budget") && message.contains("b/.gitignore")
        }));
        assert!(
            view.entries
                .iter()
                .any(|entry| entry.path == "z.ts" && entry.selected)
        );
        assert!(
            !view
                .entries
                .iter()
                .any(|entry| entry.path == "a/hidden.ts" && entry.selected)
        );
        assert!(
            !view
                .entries
                .iter()
                .any(|entry| entry.path == "b/hidden.ts" && entry.selected)
        );
        assert!(
            view.entries
                .iter()
                .any(|entry| entry.path == "b/forced.ts" && entry.selected)
        );
    }

    #[test]
    fn cumulative_gitignore_rule_budget_is_checked_before_building_matchers() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("a")).unwrap();
        std::fs::write(temp.path().join("a/.gitignore"), "secret.ts\nother.ts\n").unwrap();
        std::fs::write(temp.path().join("a/secret.ts"), "unknown rules").unwrap();
        std::fs::write(temp.path().join("z.ts"), "readable sibling").unwrap();

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                gitignore_rules: 1,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let view = workspace.view(1);

        assert!(view.incomplete);
        assert!(view.diagnostics.iter().any(|message| {
            message.contains("cumulative .gitignore budget") && message.contains("a/.gitignore")
        }));
        assert!(
            !view
                .entries
                .iter()
                .any(|entry| entry.path == "a/secret.ts" && entry.selected)
        );
        assert!(
            view.entries
                .iter()
                .any(|entry| entry.path == "z.ts" && entry.selected)
        );
    }

    #[test]
    fn cumulative_gitignore_cutoff_bounds_body_reads_and_preserves_siblings() {
        let temp = tempfile::tempdir().unwrap();
        for directory in ["a", "b", "c", "d"] {
            std::fs::create_dir_all(temp.path().join(directory)).unwrap();
        }
        let budget = 5;
        std::fs::write(temp.path().join("a/.gitignore"), "a\n").unwrap();
        std::fs::write(temp.path().join("b/.gitignore"), "secret.ts\n").unwrap();
        std::fs::write(temp.path().join("b/secret.ts"), "unknown rule").unwrap();
        std::fs::write(temp.path().join("b/forced.ts"), "explicit intent").unwrap();
        std::fs::write(temp.path().join("c/visible.ts"), "readable sibling").unwrap();
        std::fs::write(temp.path().join("d/.gitignore"), "hidden.ts\n").unwrap();
        std::fs::write(temp.path().join("d/hidden.ts"), "later unknown rule").unwrap();
        let intents = BTreeMap::from([("b/forced.ts".into(), Intent::ForceInclude)]);

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            intents,
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                gitignore_bytes: budget,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let view = workspace.view(1);

        assert!(workspace.gitignore_body_bytes_read <= budget + 1);
        assert!(view.incomplete);
        assert!(
            !view
                .entries
                .iter()
                .any(|entry| { entry.path == "b/secret.ts" && entry.selected })
        );
        assert!(
            !view
                .entries
                .iter()
                .any(|entry| { entry.path == "d/hidden.ts" && entry.selected })
        );
        assert!(view.entries.iter().any(|entry| {
            entry.path == "b/forced.ts" && entry.selected && entry.force_included
        }));
        assert!(
            view.entries
                .iter()
                .any(|entry| { entry.path == "c/visible.ts" && entry.selected })
        );
    }

    #[test]
    fn root_gitignore_budget_preserves_top_level_force_include() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join(".gitignore"), "secret.ts\n").unwrap();
        std::fs::write(temp.path().join("secret.ts"), "conservatively excluded").unwrap();
        std::fs::write(temp.path().join("forced.ts"), "explicit intent").unwrap();
        let intents = BTreeMap::from([("forced.ts".into(), Intent::ForceInclude)]);

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            intents,
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                gitignore_bytes: 0,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let view = workspace.view(1);

        assert!(view.incomplete);
        assert!(!view.entries.iter().any(|entry| entry.path == "secret.ts"));
        assert!(
            view.entries.iter().any(|entry| {
                entry.path == "forced.ts" && entry.selected && entry.force_included
            })
        );
    }

    #[test]
    fn oversized_root_gitignore_conservatively_excludes_but_keeps_force_include() {
        let temp = tempfile::tempdir().unwrap();
        let mut ignore = String::from("secret.ts\n");
        ignore.push_str(&"# padding\n".repeat(1024 * 1024 / 10 + 2));
        assert!(ignore.len() > 1024 * 1024);
        std::fs::write(temp.path().join(".gitignore"), ignore).unwrap();
        std::fs::write(temp.path().join("secret.ts"), "unknown ignore rules").unwrap();
        std::fs::write(temp.path().join("forced.ts"), "explicit intent").unwrap();
        let intents = BTreeMap::from([("forced.ts".into(), Intent::ForceInclude)]);

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            intents,
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                gitignore_bytes: usize::MAX,
                gitignore_rules: usize::MAX,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let view = workspace.view(1);

        assert!(view.incomplete);
        assert!(!view.entries.iter().any(|entry| entry.path == "secret.ts"));
        assert!(view.diagnostics.iter().any(|message| {
            message.contains(".gitignore") && message.contains("conservatively excluded")
        }));
        assert!(
            view.entries.iter().any(|entry| {
                entry.path == "forced.ts" && entry.selected && entry.force_included
            })
        );
    }

    #[test]
    fn malformed_ignore_rule_excludes_its_subtree_but_keeps_sibling_and_force_include() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("a")).unwrap();
        std::fs::write(temp.path().join("a/.gitignore"), "{secret.ts\n").unwrap();
        std::fs::write(temp.path().join("a/{secret.ts"), "literal Git pattern").unwrap();
        std::fs::write(temp.path().join("a/forced.ts"), "explicit intent").unwrap();
        std::fs::write(temp.path().join("z.ts"), "readable sibling").unwrap();
        let intents = BTreeMap::from([("a/forced.ts".into(), Intent::ForceInclude)]);

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            intents,
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
        let view = workspace.view(1);

        assert!(view.incomplete);
        assert!(
            !view
                .entries
                .iter()
                .any(|entry| entry.path == "a/{secret.ts" && entry.selected)
        );
        assert!(view.diagnostics.iter().any(|message| {
            message.contains("a/.gitignore") && message.contains("conservatively excluded")
        }));
        assert!(view.entries.iter().any(|entry| {
            entry.path == "a/forced.ts" && entry.selected && entry.force_included
        }));
        assert!(
            view.entries
                .iter()
                .any(|entry| entry.path == "z.ts" && entry.selected)
        );
    }

    #[test]
    fn all_limit_notices_and_diagnostic_flood_fit_the_bounded_summary() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("a/c")).unwrap();
        let malformed = std::iter::repeat_n("bad\\", 2_000)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(temp.path().join("a/.gitignore"), &malformed).unwrap();
        std::fs::write(temp.path().join("a/c/.gitignore"), "secret.ts\n").unwrap();
        std::fs::write(temp.path().join("a/c/other.ts"), "other").unwrap();
        std::fs::write(temp.path().join("a/c/secret.ts"), "secret").unwrap();
        std::fs::write(temp.path().join("a/c/third.ts"), "third").unwrap();
        std::fs::write(temp.path().join("z.ts"), "sibling").unwrap();
        let parse_failure_reason = "a/.gitignore: one or more ignore rules could not be parsed; subtree is conservatively excluded";

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::from(["a".into(), "a/c".into()]),
            BTreeSet::new(),
            ScanLimits {
                raw_entry_attempts: 7,
                retained_text_bytes: "a".len()
                    + "a/.gitignore".len()
                    + parse_failure_reason.len()
                    + "a/c".len()
                    + parse_failure_reason.len(),
                gitignore_bytes: malformed.len(),
                gitignore_rules: usize::MAX,
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        let diagnostics = workspace.view(1).diagnostics;
        for marker in [
            "raw directory entry limit",
            "retained metadata text budget",
            "cumulative .gitignore budget",
            "Additional scan diagnostics omitted",
        ] {
            assert!(
                diagnostics.iter().any(|message| message.contains(marker)),
                "missing diagnostic {marker}"
            );
        }
        assert!(diagnostics.len() <= DIAGNOSTIC_LIMIT);
        assert!(diagnostics.iter().map(String::len).sum::<usize>() <= DIAGNOSTIC_BYTES_LIMIT);
    }

    #[test]
    fn targeted_force_names_consume_the_shared_raw_entry_budget() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("dist/a")).unwrap();
        std::fs::create_dir_all(temp.path().join("dist/b")).unwrap();
        std::fs::write(temp.path().join(".gitignore"), "dist/\n").unwrap();
        std::fs::write(temp.path().join("dist/a/one.ts"), "one").unwrap();
        std::fs::write(temp.path().join("dist/b/two.ts"), "two").unwrap();
        let intents = BTreeMap::from([
            ("dist/a/one.ts".into(), Intent::ForceInclude),
            ("dist/b/two.ts".into(), Intent::ForceInclude),
        ]);

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            intents,
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                raw_entry_attempts: 3,
                retained_text_bytes: usize::MAX,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        let view = workspace.view(1);
        let dist = view
            .entries
            .iter()
            .find(|entry| entry.path == "dist")
            .unwrap();
        assert!(!dist.enumerated);
        assert!(view.incomplete);
        assert!(!view.entries.iter().any(|entry| entry.path == "dist/b"));
        assert!(
            view.diagnostics
                .iter()
                .any(|message| { message.contains("raw directory entry limit") })
        );
    }

    #[test]
    fn scan_limit_notice_survives_a_flood_of_malformed_rule_diagnostics() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("a")).unwrap();
        let malformed = std::iter::repeat_n("bad\\", 2_000)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(temp.path().join("a/.gitignore"), malformed).unwrap();
        std::fs::write(temp.path().join("a/inside.ts"), "a").unwrap();
        std::fs::write(temp.path().join("b.ts"), "b").unwrap();
        std::fs::write(temp.path().join("c.ts"), "c").unwrap();

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::from(["a".into()]),
            BTreeSet::new(),
            ScanLimits {
                raw_entry_attempts: 2,
                retained_text_bytes: usize::MAX,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        let diagnostics = workspace.view(1).diagnostics;
        assert!(
            diagnostics
                .iter()
                .any(|message| { message.contains("raw directory entry limit") })
        );
        assert!(diagnostics.len() <= DIAGNOSTIC_LIMIT);
        assert!(diagnostics.iter().map(String::len).sum::<usize>() <= DIAGNOSTIC_BYTES_LIMIT);
    }

    #[cfg(unix)]
    #[test]
    fn invalid_utf8_directory_entries_consume_the_raw_entry_budget() {
        use std::os::unix::ffi::OsStringExt;

        let temp = tempfile::tempdir().unwrap();
        for name in [[0xff, b'a'], [0xfe, b'b'], [0xfd, b'c']] {
            std::fs::write(
                temp.path()
                    .join(std::ffi::OsString::from_vec(name.to_vec())),
                "text",
            )
            .unwrap();
        }

        let workspace = Workspace::scan_pinned_with_limits(
            WorkspaceRoot::open(temp.path()).unwrap(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            BTreeSet::new(),
            ScanLimits {
                raw_entry_attempts: 2,
                retained_text_bytes: usize::MAX,
                ..ScanLimits::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();

        assert!(
            workspace
                .view(1)
                .diagnostics
                .iter()
                .any(|message| { message.contains("raw directory entry limit") })
        );
    }
}
