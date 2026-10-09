use crate::{Error, Result};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone)]
pub struct WorkspaceRoot {
    path: PathBuf,
    dir: Arc<cap_std::fs::Dir>,
    identity: Arc<same_file::Handle>,
}

impl WorkspaceRoot {
    pub fn open(path: &Path) -> Result<Self> {
        let path = std::fs::canonicalize(path)?;
        let dir = cap_std::fs::Dir::open_ambient_dir(&path, cap_std::ambient_authority())?;
        let identity = same_file::Handle::from_file(dir.try_clone()?.into_std_file())?;
        Ok(Self {
            path,
            dir: Arc::new(dir),
            identity: Arc::new(identity),
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn dir(&self) -> &cap_std::fs::Dir {
        &self.dir
    }
    pub fn validate_anchor(&self) -> Result<()> {
        let current = same_file::Handle::from_path(&self.path)?;
        if current != *self.identity {
            return Err(Error::Message(
                "workspace root changed; reopen the folder".into(),
            ));
        }
        Ok(())
    }

    /// Compares pinned physical root identity without reopening either path.
    pub fn same_identity(&self, other: &Self) -> bool {
        self.identity.as_ref() == other.identity.as_ref()
    }
}
