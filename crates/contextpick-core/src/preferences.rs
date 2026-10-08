use crate::{Error, Result, selection::Intent, workspace::FilterPolicy};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const MAX_SETTINGS_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspace {
    pub policy: FilterPolicy,
    pub intents: BTreeMap<String, Intent>,
    #[serde(default)]
    pub generated_outputs: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub version: u32,
    pub recent_root: Option<String>,
    pub workspaces: BTreeMap<String, SavedWorkspace>,
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
            version: 1,
            recent_root: None,
            workspaces: BTreeMap::new(),
        }
    }
}
impl Preferences {
    pub fn load_with_recovery(path: &Path) -> PreferencesRecovery {
        match Self::load(path) {
            Ok(preferences) => PreferencesRecovery {
                preferences,
                notice: None,
                saving_blocked: false,
            },
            Err(error) => match backup_original(path) {
                Ok(backup) => PreferencesRecovery {
                    preferences: Self::default(),
                    notice: Some(format!(
                        "Settings could not be loaded: {error}. The original was preserved at {}. Defaults are in use; review or restore the backup.",
                        backup.display()
                    )),
                    saving_blocked: false,
                },
                Err(backup_error) => PreferencesRecovery {
                    preferences: Self::default(),
                    notice: Some(format!(
                        "Settings could not be loaded: {error}. Backup failed: {backup_error}. Saving settings is disabled to protect the original at {}; check directory permissions or manually copy the file.",
                        path.display()
                    )),
                    saving_blocked: true,
                },
            },
        }
    }

    pub fn load(path: &Path) -> Result<Self> {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_SETTINGS_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_SETTINGS_BYTES {
            return Err(Error::Message("settings exceed 4 MiB safety limit".into()));
        }
        let settings: Self = serde_json::from_slice(&bytes).map_err(|e| {
            Error::Message(format!(
                "settings are corrupt: {e}; original file preserved"
            ))
        })?;
        if settings.version != 1 {
            return Err(Error::Message(format!(
                "unsupported settings version {}; original file preserved",
                settings.version
            )));
        }
        Ok(settings)
    }
    pub fn save(&self, path: &Path) -> Result<()> {
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
