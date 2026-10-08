use crate::{Error, Result, selection::Intent, workspace::FilterPolicy};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspace {
    pub policy: FilterPolicy,
    pub intents: BTreeMap<String, Intent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub version: u32,
    pub recent_root: Option<String>,
    pub workspaces: BTreeMap<String, SavedWorkspace>,
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
    pub fn load(path: &Path) -> Result<Self> {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
        };
        let mut bytes = Vec::new();
        file.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 4 * 1024 * 1024 {
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
        serde_json::to_writer_pretty(&mut temp, self).map_err(|e| Error::Message(e.to_string()))?;
        temp.flush()?;
        temp.as_file().sync_all()?;
        temp.persist(path).map_err(|e| Error::Io(e.error))?;
        Ok(())
    }
}
