use crate::{
    Error, Result,
    selection::Intent,
    workspace::{
        FILE_EXTENSION_RULE_PREFIX, FilterPolicy, LITERAL_GLOB_RULE_PREFIX,
        migrated_extension_path_rule,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const MAX_SETTINGS_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_PROFILES_PER_WORKSPACE: usize = 20;
pub const MAX_PROFILE_NAME_BYTES: usize = 80;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedWorkspace {
    pub policy: FilterPolicy,
    pub intents: BTreeMap<String, Intent>,
    #[serde(default)]
    pub generated_outputs: BTreeSet<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, SavedProfile>,
    #[serde(default)]
    pub active_profile: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedProfile {
    pub policy: FilterPolicy,
    pub intents: BTreeMap<String, Intent>,
}

impl SavedWorkspace {
    /// Store a named snapshot of the current policy and manual path intents.
    pub fn create_profile(&mut self, name: &str) -> Result<()> {
        let name = normalize_profile_name(name)?;
        if self.profiles.contains_key(&name) {
            return Err(Error::Message(format!(
                "a profile named {name:?} already exists"
            )));
        }
        if self.profiles.len() >= MAX_PROFILES_PER_WORKSPACE {
            return Err(Error::Message(format!(
                "a workspace can contain at most {MAX_PROFILES_PER_WORKSPACE} profiles"
            )));
        }
        let profile = self.snapshot_profile()?;
        self.profiles.insert(name.clone(), profile);
        self.active_profile = Some(name);
        Ok(())
    }

    /// Replace an existing snapshot with the current policy and manual intents.
    pub fn update_profile(&mut self, name: &str) -> Result<()> {
        let name = normalize_profile_name(name)?;
        if !self.profiles.contains_key(&name) {
            return Err(Error::Message(format!("profile {name:?} does not exist")));
        }
        let profile = self.snapshot_profile()?;
        self.profiles.insert(name.clone(), profile);
        self.active_profile = Some(name);
        Ok(())
    }

    /// Apply one profile's policy and manual intents to the current workspace.
    pub fn activate_profile(&mut self, name: &str) -> Result<()> {
        let name = normalize_profile_name(name)?;
        let profile = self
            .profiles
            .get(&name)
            .ok_or_else(|| Error::Message(format!("profile {name:?} does not exist")))?
            .clone();
        profile.policy.validate()?;
        self.policy = profile.policy;
        self.intents = profile.intents;
        self.active_profile = Some(name);
        Ok(())
    }

    pub fn rename_profile(&mut self, current_name: &str, new_name: &str) -> Result<()> {
        let current_name = normalize_profile_name(current_name)?;
        let new_name = normalize_profile_name(new_name)?;
        if !self.profiles.contains_key(&current_name) {
            return Err(Error::Message(format!(
                "profile {current_name:?} does not exist"
            )));
        }
        if current_name == new_name {
            return Ok(());
        }
        if self.profiles.contains_key(&new_name) {
            return Err(Error::Message(format!(
                "a profile named {new_name:?} already exists"
            )));
        }
        let is_active = self.active_profile.as_deref() == Some(current_name.as_str());
        let profile = self
            .profiles
            .remove(&current_name)
            .expect("profile existence was checked");
        self.profiles.insert(new_name.clone(), profile);
        if is_active {
            self.active_profile = Some(new_name);
        }
        Ok(())
    }

    pub fn delete_profile(&mut self, name: &str) -> Result<()> {
        let name = normalize_profile_name(name)?;
        self.profiles
            .remove(&name)
            .ok_or_else(|| Error::Message(format!("profile {name:?} does not exist")))?;
        if self.active_profile.as_deref() == Some(name.as_str()) {
            self.active_profile = None;
        }
        Ok(())
    }

    fn snapshot_profile(&self) -> Result<SavedProfile> {
        self.policy.validate()?;
        Ok(SavedProfile {
            policy: self.policy.clone(),
            intents: self.intents.clone(),
        })
    }
}

fn normalize_profile_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Message("profile name cannot be empty".into()));
    }
    if name.len() > MAX_PROFILE_NAME_BYTES {
        return Err(Error::Message(format!(
            "profile name cannot exceed {MAX_PROFILE_NAME_BYTES} UTF-8 bytes"
        )));
    }
    Ok(name.to_owned())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub version: u32,
    pub recent_root: Option<String>,
    pub workspaces: BTreeMap<String, SavedWorkspace>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPreferencesV1 {
    version: u32,
    #[serde(default)]
    recent_root: Option<String>,
    #[serde(default)]
    workspaces: BTreeMap<String, LegacySavedWorkspaceV1>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPreferencesV2 {
    version: u32,
    #[serde(default)]
    recent_root: Option<String>,
    #[serde(default)]
    workspaces: BTreeMap<String, LegacySavedWorkspaceV2>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct LegacySavedWorkspaceV2 {
    policy: FilterPolicy,
    intents: BTreeMap<String, Intent>,
    generated_outputs: BTreeSet<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct LegacySavedWorkspaceV1 {
    policy: LegacyFilterPolicyV1,
    intents: BTreeMap<String, Intent>,
    generated_outputs: BTreeSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct LegacyFilterPolicyV1 {
    gitignore: bool,
    include_extensions: Vec<String>,
    exclude_extensions: Vec<String>,
    include_paths: Vec<String>,
    exclude_paths: Vec<String>,
}

impl Default for LegacyFilterPolicyV1 {
    fn default() -> Self {
        let policy = FilterPolicy::default();
        Self {
            gitignore: policy.gitignore,
            include_extensions: policy.include_extensions,
            exclude_extensions: Vec::new(),
            include_paths: policy.include_paths,
            exclude_paths: policy.exclude_paths,
        }
    }
}

enum ParsedPreferences {
    Current(Preferences),
    LegacyV1(LegacyPreferencesV1),
    LegacyV2(LegacyPreferencesV2),
    InvalidMigration { version: u32, error: String },
}

#[derive(Clone, Debug)]
pub struct PreferencesRecovery {
    pub preferences: Preferences,
    pub notice: Option<String>,
    /// When true, callers must not save defaults over the unreadable original.
    pub saving_blocked: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 3,
            recent_root: None,
            workspaces: BTreeMap::new(),
        }
    }
}

impl Preferences {
    pub fn load_with_recovery(path: &Path) -> PreferencesRecovery {
        let parsed = match read_preferences(path) {
            Ok(parsed) => parsed,
            Err(error) => return recover_unreadable(path, error),
        };
        let (source_version, migrated) = match parsed {
            ParsedPreferences::Current(preferences) => {
                return PreferencesRecovery {
                    preferences,
                    notice: None,
                    saving_blocked: false,
                };
            }
            ParsedPreferences::LegacyV1(legacy) => (1, migrate_v1(legacy).and_then(migrate_v2)),
            ParsedPreferences::LegacyV2(legacy) => (2, migrate_v2(legacy)),
            ParsedPreferences::InvalidMigration { version, error } => {
                return recover_failed_migration(path, version, error);
            }
        };
        let preferences = match migrated {
            Ok(preferences) => preferences,
            Err(error) => return recover_failed_migration(path, source_version, error.to_string()),
        };

        persist_migration(
            path,
            source_version,
            preferences,
            backup_original,
            |preferences, path| preferences.save(path),
        )
    }

    pub fn load(path: &Path) -> Result<Self> {
        match read_preferences(path)? {
            ParsedPreferences::Current(preferences) => Ok(preferences),
            ParsedPreferences::LegacyV1(_) => Err(Error::Message(
                "version-1 settings require transactional migration; load them with recovery enabled"
                    .into(),
            )),
            ParsedPreferences::LegacyV2(_) => Err(Error::Message(
                "version-2 settings require transactional migration; load them with recovery enabled"
                    .into(),
            )),
            ParsedPreferences::InvalidMigration { error, .. } => Err(Error::Message(error)),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if self.version != 3 {
            return Err(Error::Message(format!(
                "only settings version 3 can be saved; found version {}",
                self.version
            )));
        }
        validate_preferences(self)?;
        let parent = path
            .parent()
            .ok_or_else(|| Error::Message("settings path has no parent".into()))?;
        std::fs::create_dir_all(parent)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        {
            let mut writer = LimitedWriter {
                inner: &mut temp,
                written: 0,
            };
            serde_json::to_writer_pretty(&mut writer, self)
                .map_err(|e| Error::Message(e.to_string()))?;
            writer.flush()?;
        }
        temp.flush()?;
        temp.as_file().sync_all()?;
        temp.persist(path).map_err(|e| Error::Io(e.error))?;
        Ok(())
    }
}

fn persist_migration(
    path: &Path,
    source_version: u32,
    preferences: Preferences,
    backup_original: impl FnOnce(&Path) -> io::Result<PathBuf>,
    save: impl FnOnce(&Preferences, &Path) -> Result<()>,
) -> PreferencesRecovery {
    let backup = match backup_original(path) {
        Ok(backup) => backup,
        Err(error) => {
            return PreferencesRecovery {
                preferences: Preferences::default(),
                notice: Some(format!(
                    "Version-{source_version} settings migration needs a backup before saving, but backup failed: {error}. The original remains at {}; saving is disabled. Check directory permissions or copy the file manually.",
                    path.display()
                )),
                saving_blocked: true,
            };
        }
    };
    match save(&preferences, path) {
        Ok(()) => PreferencesRecovery {
            preferences,
            notice: None,
            saving_blocked: false,
        },
        Err(error) => PreferencesRecovery {
            preferences: Preferences::default(),
            notice: Some(format!(
                "Version-{source_version} settings migration could not be saved: {error}. The original was preserved at {}; a backup is at {}. Saving is disabled until you resolve the migration.",
                path.display(),
                backup.display()
            )),
            saving_blocked: true,
        },
    }
}

fn read_preferences(path: &Path) -> Result<ParsedPreferences> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ParsedPreferences::Current(Preferences::default()));
        }
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(Error::Message("settings exceed 4 MiB safety limit".into()));
    }
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) if contains_settings_version_marker(&bytes, 1) => {
            return Ok(ParsedPreferences::InvalidMigration {
                version: 1,
                error: format!("version-1 settings are corrupt and cannot be migrated: {error}"),
            });
        }
        Err(error) if contains_settings_version_marker(&bytes, 2) => {
            return Ok(ParsedPreferences::InvalidMigration {
                version: 2,
                error: format!("version-2 settings are corrupt and cannot be migrated: {error}"),
            });
        }
        Err(error) => {
            return Err(Error::Message(format!(
                "settings are corrupt: {error}; original file preserved"
            )));
        }
    };
    let version_value = value.get("version");
    match version_value.and_then(serde_json::Value::as_u64) {
        Some(1) => Ok(match serde_json::from_value::<LegacyPreferencesV1>(value) {
            Ok(preferences) => ParsedPreferences::LegacyV1(preferences),
            Err(error) => ParsedPreferences::InvalidMigration {
                version: 1,
                error: format!("version-1 settings are invalid and cannot be migrated: {error}"),
            },
        }),
        Some(2) => Ok(match serde_json::from_value::<LegacyPreferencesV2>(value) {
            Ok(preferences) => ParsedPreferences::LegacyV2(preferences),
            Err(error) => ParsedPreferences::InvalidMigration {
                version: 2,
                error: format!("version-2 settings are invalid and cannot be migrated: {error}"),
            },
        }),
        Some(3) => {
            let preferences: Preferences = serde_json::from_value(value).map_err(|error| {
                Error::Message(format!(
                    "settings are invalid: {error}; original file preserved"
                ))
            })?;
            validate_preferences(&preferences)?;
            Ok(ParsedPreferences::Current(preferences))
        }
        Some(version) => Err(Error::Message(format!(
            "unsupported settings version {version}; original file preserved"
        ))),
        None if version_value.is_some_and(|version| is_non_integer_version(version, 1)) => {
            Ok(ParsedPreferences::InvalidMigration {
                version: 1,
                error: "version-1 settings use a non-integer schema version and cannot be migrated"
                    .into(),
            })
        }
        None if version_value.is_some_and(|version| is_non_integer_version(version, 2)) => {
            Ok(ParsedPreferences::InvalidMigration {
                version: 2,
                error: "version-2 settings use a non-integer schema version and cannot be migrated"
                    .into(),
            })
        }
        None => Err(Error::Message(
            "settings have no valid schema version; original file preserved".into(),
        )),
    }
}

fn contains_settings_version_marker(bytes: &[u8], wanted: u32) -> bool {
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                if let Some((key, after_key)) = decode_json_string_token(bytes, index) {
                    if key == "version" {
                        let mut value = skip_json_whitespace(bytes, after_key);
                        if bytes.get(value) == Some(&b':') {
                            value = skip_json_whitespace(bytes, value + 1);
                            if looks_like_settings_version(bytes, value, wanted) {
                                return true;
                            }
                        }
                    }
                    index = after_key;
                } else {
                    index += 1;
                }
            }
            _ => index += 1,
        }
    }
    false
}

fn looks_like_settings_version(bytes: &[u8], start: usize, wanted: u32) -> bool {
    if bytes.get(start) == Some(&b'"') {
        return decode_json_string_token(bytes, start).is_some_and(|(version, _)| {
            version
                .parse::<f64>()
                .is_ok_and(|number| number == f64::from(wanted))
        });
    }

    let mut end = start;
    while bytes
        .get(end)
        .is_some_and(|byte| matches!(byte, b'0'..=b'9' | b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        end += 1;
    }
    if end == start {
        return false;
    }
    let token = &bytes[start..end];
    let text = String::from_utf8_lossy(token);
    let significant = token
        .iter()
        .position(|byte| *byte != b'0')
        .map_or(token, |index| &token[index..]);
    text.parse::<f64>()
        .is_ok_and(|value| value == f64::from(wanted))
        || significant.starts_with(format!("{wanted}.").as_bytes())
        || significant.starts_with(format!("{wanted}e").as_bytes())
        || significant.starts_with(format!("{wanted}E").as_bytes())
}

fn is_non_integer_version(value: &serde_json::Value, wanted: u32) -> bool {
    value.as_f64() == Some(f64::from(wanted))
        || value.as_str().is_some_and(|text| {
            text.parse::<f64>()
                .is_ok_and(|number| number == f64::from(wanted))
        })
}

fn decode_json_string_token(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                if index + 1 >= bytes.len() {
                    return None;
                }
                index += 2;
            }
            b'"' => {
                index += 1;
                let value = serde_json::from_slice::<String>(&bytes[start..index]).ok()?;
                return Some((value, index));
            }
            _ => index += 1,
        }
    }
    None
}

fn skip_json_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

fn migrate_v1(legacy: LegacyPreferencesV1) -> Result<LegacyPreferencesV2> {
    if legacy.version != 1 {
        return Err(Error::Message("invalid legacy settings version".into()));
    }
    let mut workspaces = BTreeMap::new();
    for (root, workspace) in legacy.workspaces {
        let LegacyFilterPolicyV1 {
            gitignore,
            include_extensions,
            exclude_extensions,
            include_paths,
            mut exclude_paths,
        } = workspace.policy;
        for rule in &mut exclude_paths {
            if rule.starts_with(FILE_EXTENSION_RULE_PREFIX)
                || rule.starts_with(LITERAL_GLOB_RULE_PREFIX)
            {
                *rule = format!("{LITERAL_GLOB_RULE_PREFIX}{rule}");
            }
        }
        let mut seen_generated = BTreeSet::new();
        let mut migrated_extensions = Vec::new();
        for extension in exclude_extensions {
            let rule = migrated_extension_path_rule(&extension);
            if seen_generated.insert(rule.clone()) {
                migrated_extensions.push(rule);
            }
        }
        // Version 1 evaluated path exclusions before extension exclusions. Keep
        // those paths later so their prior explanation precedence survives.
        migrated_extensions.append(&mut exclude_paths);
        let exclude_paths = migrated_extensions;
        let policy = FilterPolicy {
            gitignore,
            include_extensions,
            include_paths,
            exclude_paths,
        };
        policy.validate().map_err(|error| {
            Error::Message(format!(
                "migration of filters for workspace {root:?} failed validation: {error}"
            ))
        })?;
        workspaces.insert(
            root,
            LegacySavedWorkspaceV2 {
                policy,
                intents: workspace.intents,
                generated_outputs: workspace.generated_outputs,
            },
        );
    }
    Ok(LegacyPreferencesV2 {
        version: 2,
        recent_root: legacy.recent_root,
        workspaces,
    })
}

fn migrate_v2(legacy: LegacyPreferencesV2) -> Result<Preferences> {
    if legacy.version != 2 {
        return Err(Error::Message("invalid version-2 settings schema".into()));
    }
    let workspaces = legacy
        .workspaces
        .into_iter()
        .map(|(root, workspace)| {
            (
                root,
                SavedWorkspace {
                    policy: workspace.policy,
                    intents: workspace.intents,
                    generated_outputs: workspace.generated_outputs,
                    profiles: BTreeMap::new(),
                    active_profile: None,
                },
            )
        })
        .collect();
    let migrated = Preferences {
        version: 3,
        recent_root: legacy.recent_root,
        workspaces,
    };
    validate_preferences(&migrated)?;
    Ok(migrated)
}

fn validate_preferences(preferences: &Preferences) -> Result<()> {
    if preferences.version != 3 {
        return Err(Error::Message(format!(
            "unsupported settings version {}; expected version 3",
            preferences.version
        )));
    }
    for (root, workspace) in &preferences.workspaces {
        workspace.policy.validate().map_err(|error| {
            Error::Message(format!(
                "invalid filter policy for workspace {root:?}: {error}"
            ))
        })?;
        if workspace.profiles.len() > MAX_PROFILES_PER_WORKSPACE {
            return Err(Error::Message(format!(
                "workspace {root:?} exceeds the {MAX_PROFILES_PER_WORKSPACE}-profile limit"
            )));
        }
        for (name, profile) in &workspace.profiles {
            let normalized = normalize_profile_name(name).map_err(|error| {
                Error::Message(format!(
                    "invalid profile name in workspace {root:?}: {error}"
                ))
            })?;
            if normalized != name.as_str() {
                return Err(Error::Message(format!(
                    "profile name {name:?} in workspace {root:?} is not normalized"
                )));
            }
            profile.policy.validate().map_err(|error| {
                Error::Message(format!(
                    "invalid filter policy for profile {name:?} in workspace {root:?}: {error}"
                ))
            })?;
        }
        if let Some(active_profile) = &workspace.active_profile {
            let normalized = normalize_profile_name(active_profile).map_err(|error| {
                Error::Message(format!(
                    "invalid active profile name in workspace {root:?}: {error}"
                ))
            })?;
            if normalized.as_str() != active_profile.as_str()
                || !workspace.profiles.contains_key(&normalized)
            {
                return Err(Error::Message(format!(
                    "active profile {active_profile:?} in workspace {root:?} is missing or not normalized"
                )));
            }
            let profile = &workspace.profiles[&normalized];
            if profile.policy != workspace.policy || profile.intents != workspace.intents {
                return Err(Error::Message(format!(
                    "active profile {active_profile:?} does not match the current policy and intents in workspace {root:?}"
                )));
            }
        }
    }
    Ok(())
}

fn recover_unreadable(path: &Path, error: Error) -> PreferencesRecovery {
    match backup_original(path) {
        Ok(backup) => PreferencesRecovery {
            preferences: Preferences::default(),
            notice: Some(format!(
                "Settings could not be loaded: {error}. The original was preserved at {}. Defaults are in use; review or restore the backup.",
                backup.display()
            )),
            saving_blocked: false,
        },
        Err(backup_error) => PreferencesRecovery {
            preferences: Preferences::default(),
            notice: Some(format!(
                "Settings could not be loaded: {error}. Backup failed: {backup_error}. Saving settings is disabled to protect the original at {}; check directory permissions or manually copy the file.",
                path.display()
            )),
            saving_blocked: true,
        },
    }
}

fn recover_failed_migration(
    path: &Path,
    source_version: u32,
    error: String,
) -> PreferencesRecovery {
    match backup_original(path) {
        Ok(backup) => PreferencesRecovery {
            preferences: Preferences::default(),
            notice: Some(format!(
                "Version-{source_version} settings migration failed: {error}. The original was preserved at {}; a backup is at {}. Saving is disabled until you resolve the migration.",
                path.display(),
                backup.display()
            )),
            saving_blocked: true,
        },
        Err(backup_error) => PreferencesRecovery {
            preferences: Preferences::default(),
            notice: Some(format!(
                "Version-{source_version} settings migration failed: {error}; backup also failed: {backup_error}. The original remains at {}; saving is disabled. Check directory permissions or manually copy the file.",
                path.display()
            )),
            saving_blocked: true,
        },
    }
}

struct LimitedWriter<'a, W> {
    inner: &'a mut W,
    written: u64,
}

impl<W: Write> Write for LimitedWriter<'_, W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let attempted = self.written.saturating_add(buffer.len() as u64);
        if attempted > MAX_SETTINGS_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "settings exceed 4 MiB safety limit",
            ));
        }
        let written = self.inner.write(buffer)?;
        self.written = self.written.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn backup_original(path: &Path) -> io::Result<PathBuf> {
    let mut source = std::fs::File::open(path)?;
    let metadata = source.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "settings backup source is not a regular file",
        ));
    }
    if metadata.len() > MAX_SETTINGS_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "settings exceed the 4 MiB recovery backup limit",
        ));
    }

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let backup_dir = parent.join("settings-recovery");
    std::fs::create_dir_all(&backup_dir)?;

    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("settings");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for sequence in 0..16 {
        let backup = backup_dir.join(format!("{stem}-{timestamp}-{sequence}.json"));
        let mut destination = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let copy_result = (|| {
            let mut bounded_source = (&mut source).take(MAX_SETTINGS_BYTES + 1);
            let copied = io::copy(&mut bounded_source, &mut destination)?;
            if copied > MAX_SETTINGS_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "settings grew beyond the 4 MiB recovery backup limit while being copied",
                ));
            }
            destination.flush()?;
            destination.sync_all()
        })();
        if let Err(error) = copy_result {
            drop(destination);
            let _ = std::fs::remove_file(&backup);
            return Err(error);
        }
        return Ok(backup);
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique settings backup filename after 16 attempts",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_migration_save_keeps_original_and_backup_and_blocks_saving() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = r#"{"version":2,"recentRoot":"root","workspaces":{}}"#;
        std::fs::write(&path, original).unwrap();
        let mut save_called = false;

        let recovery =
            persist_migration(&path, 2, Preferences::default(), backup_original, |_, _| {
                save_called = true;
                Err(Error::Message("injected migration save failure".into()))
            });

        assert!(save_called);
        assert!(recovery.saving_blocked);
        assert!(
            recovery
                .notice
                .unwrap()
                .contains("Version-2 settings migration could not be saved")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        let backups: Vec<_> = std::fs::read_dir(dir.path().join("settings-recovery"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), original);
    }
}
