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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedWorkspace {
    pub policy: FilterPolicy,
    pub intents: BTreeMap<String, Intent>,
    #[serde(default)]
    pub generated_outputs: BTreeSet<String>,
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
    InvalidLegacyV1(String),
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
            version: 2,
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
        let preferences = match parsed {
            ParsedPreferences::Current(preferences) => {
                return PreferencesRecovery {
                    preferences,
                    notice: None,
                    saving_blocked: false,
                };
            }
            ParsedPreferences::LegacyV1(legacy) => match migrate_v1(legacy) {
                Ok(preferences) => preferences,
                Err(error) => return recover_failed_migration(path, error.to_string()),
            },
            ParsedPreferences::InvalidLegacyV1(error) => {
                return recover_failed_migration(path, error);
            }
        };

        persist_migration(path, preferences, backup_original, |preferences, path| {
            preferences.save(path)
        })
    }

    pub fn load(path: &Path) -> Result<Self> {
        match read_preferences(path)? {
            ParsedPreferences::Current(preferences) => Ok(preferences),
            ParsedPreferences::LegacyV1(_) => Err(Error::Message(
                "version-1 settings require transactional migration; load them with recovery enabled"
                    .into(),
            )),
            ParsedPreferences::InvalidLegacyV1(error) => Err(Error::Message(error)),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if self.version != 2 {
            return Err(Error::Message(format!(
                "only settings version 2 can be saved; found version {}",
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
                    "Version-1 settings migration needs a backup before saving, but backup failed: {error}. The original remains at {}; saving is disabled. Check directory permissions or copy the file manually.",
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
                "Version-1 settings migration could not be saved: {error}. The original was preserved at {}; a backup is at {}. Saving is disabled until you resolve the migration.",
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
        Err(error) if contains_legacy_v1_marker(&bytes) => {
            return Ok(ParsedPreferences::InvalidLegacyV1(format!(
                "version-1 settings are corrupt and cannot be migrated: {error}"
            )));
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
            Err(error) => ParsedPreferences::InvalidLegacyV1(format!(
                "version-1 settings are invalid and cannot be migrated: {error}"
            )),
        }),
        Some(2) => {
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
        None if version_value.is_some_and(|version| {
            version.as_f64() == Some(1.0)
                || version
                    .as_str()
                    .is_some_and(|text| text.parse::<f64>().is_ok_and(|number| number == 1.0))
        }) =>
        {
            Ok(ParsedPreferences::InvalidLegacyV1(
                "version-1 settings use a non-integer schema version and cannot be migrated".into(),
            ))
        }
        None => Err(Error::Message(
            "settings have no valid schema version; original file preserved".into(),
        )),
    }
}

fn contains_legacy_v1_marker(bytes: &[u8]) -> bool {
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                if let Some((key, after_key)) = decode_json_string_token(bytes, index) {
                    if key == "version" {
                        let mut value = skip_json_whitespace(bytes, after_key);
                        if bytes.get(value) == Some(&b':') {
                            value = skip_json_whitespace(bytes, value + 1);
                            if looks_like_legacy_v1_version(bytes, value) {
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

fn looks_like_legacy_v1_version(bytes: &[u8], start: usize) -> bool {
    if bytes.get(start) == Some(&b'"') {
        return decode_json_string_token(bytes, start)
            .is_some_and(|(version, _)| version.parse::<f64>().is_ok_and(|number| number == 1.0));
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
    text.parse::<f64>().is_ok_and(|value| value == 1.0)
        || significant.starts_with(b"1.")
        || significant.starts_with(b"1e")
        || significant.starts_with(b"1E")
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

fn migrate_v1(legacy: LegacyPreferencesV1) -> Result<Preferences> {
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
            SavedWorkspace {
                policy,
                intents: workspace.intents,
                generated_outputs: workspace.generated_outputs,
            },
        );
    }
    let migrated = Preferences {
        version: 2,
        recent_root: legacy.recent_root,
        workspaces,
    };
    validate_preferences(&migrated)?;
    Ok(migrated)
}

fn validate_preferences(preferences: &Preferences) -> Result<()> {
    if preferences.version != 2 {
        return Err(Error::Message(format!(
            "unsupported settings version {}; expected version 2",
            preferences.version
        )));
    }
    for (root, workspace) in &preferences.workspaces {
        workspace.policy.validate().map_err(|error| {
            Error::Message(format!(
                "invalid filter policy for workspace {root:?}: {error}"
            ))
        })?;
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

fn recover_failed_migration(path: &Path, error: String) -> PreferencesRecovery {
    match backup_original(path) {
        Ok(backup) => PreferencesRecovery {
            preferences: Preferences::default(),
            notice: Some(format!(
                "Version-1 settings migration failed: {error}. The original was preserved at {}; a backup is at {}. Saving is disabled until you resolve the migration.",
                path.display(),
                backup.display()
            )),
            saving_blocked: true,
        },
        Err(backup_error) => PreferencesRecovery {
            preferences: Preferences::default(),
            notice: Some(format!(
                "Version-1 settings migration failed: {error}; backup also failed: {backup_error}. The original remains at {}; saving is disabled. Check directory permissions or manually copy the file.",
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
        let original = r#"{"version":1,"recentRoot":"root","workspaces":{}}"#;
        std::fs::write(&path, original).unwrap();
        let mut save_called = false;

        let recovery = persist_migration(&path, Preferences::default(), backup_original, |_, _| {
            save_called = true;
            Err(Error::Message("injected migration save failure".into()))
        });

        assert!(save_called);
        assert!(recovery.saving_blocked);
        assert!(
            recovery
                .notice
                .unwrap()
                .contains("migration could not be saved")
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
