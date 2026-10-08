use crate::{Error, Result, WorkspaceRoot};
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const SAMPLE_LIMIT: usize = 16 * 1024;
const PREVIEW_SOURCE_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub text: String,
    pub truncated: bool,
}

fn checked_relative(path: &str) -> Result<PathBuf> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.contains(':')
        || path.contains('\0')
    {
        return Err(Error::Message(format!("unsafe path: {path}")));
    }
    let mut result = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(' ')
            || part.ends_with('.')
        {
            return Err(Error::Message(format!("unsafe path: {path}")));
        }
        let base = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
        if matches!(
            base.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "CONIN$"
                | "CONOUT$"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "COM¹"
                | "COM²"
                | "COM³"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
                | "LPT¹"
                | "LPT²"
                | "LPT³"
        ) {
            return Err(Error::Message(format!("unsafe path: {path}")));
        }
        result.push(part);
    }
    Ok(result)
}

fn reject_links(dir: &cap_std::fs::Dir, path: &Path) -> Result<()> {
    let mut prefix = PathBuf::new();
    let count = path.components().count();
    for (index, component) in path.components().enumerate() {
        prefix.push(component.as_os_str());
        let meta = dir.symlink_metadata(&prefix)?;
        if meta.file_type().is_symlink() {
            return Err(Error::Message(format!(
                "link or reparse point rejected: {}",
                path.display()
            )));
        }
        #[cfg(windows)]
        {
            use cap_std::fs::MetadataExt as CapMetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(Error::Message(format!(
                    "link or reparse point rejected: {}",
                    path.display()
                )));
            }
        }
        if index + 1 < count && !meta.is_dir() {
            return Err(Error::Message(format!(
                "not a directory: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub fn open_safe(root: &WorkspaceRoot, path: &str) -> Result<File> {
    let rel = checked_relative(path)?;
    let dir = root.dir();
    reject_links(dir, &rel)?;
    let meta = dir.metadata(&rel)?;
    if !meta.is_file() {
        return Err(Error::Message(format!("not a regular file: {path}")));
    }
    Ok(dir.open(&rel)?.into_std())
}

fn decode_bytes(bytes: &[u8], tolerate_incomplete_tail: bool) -> Result<String> {
    if let Some(body) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return decode_utf8(body, tolerate_incomplete_tail);
    }
    if let Some(body) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return decode_utf16(body, true, tolerate_incomplete_tail);
    }
    if let Some(body) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return decode_utf16(body, false, tolerate_incomplete_tail);
    }
    decode_utf8(bytes, tolerate_incomplete_tail)
}

fn decode_utf8(bytes: &[u8], tolerate_incomplete_tail: bool) -> Result<String> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_owned()),
        Err(e) if tolerate_incomplete_tail && e.error_len().is_none() => {
            Ok(std::str::from_utf8(&bytes[..e.valid_up_to()])
                .map_err(|_| Error::Message("invalid UTF-8".into()))?
                .to_owned())
        }
        Err(_) => Err(Error::Message("invalid UTF-8 content".into())),
    }
}

fn decode_utf16(bytes: &[u8], little: bool, tolerate_incomplete_tail: bool) -> Result<String> {
    let usable = if bytes.len() % 2 == 1 && tolerate_incomplete_tail {
        bytes.len() - 1
    } else {
        bytes.len()
    };
    if usable % 2 != 0 {
        return Err(Error::Message("odd byte count in UTF-16 content".into()));
    }
    let mut words: Vec<u16> = bytes[..usable]
        .chunks_exact(2)
        .map(|p| {
            if little {
                u16::from_le_bytes([p[0], p[1]])
            } else {
                u16::from_be_bytes([p[0], p[1]])
            }
        })
        .collect();
    if tolerate_incomplete_tail && words.last().is_some_and(|w| (0xd800..=0xdbff).contains(w)) {
        words.pop();
    }
    let mut output = String::new();
    for c in char::decode_utf16(words) {
        match c {
            Ok(c) => output.push(c),
            Err(_) => return Err(Error::Message("invalid UTF-16 content".into())),
        }
    }
    Ok(output)
}

pub fn classify(root: &WorkspaceRoot, path: &str) -> Result<bool> {
    let mut file = open_safe(root, path)?;
    let mut sample = vec![0u8; SAMPLE_LIMIT];
    let n = file.read(&mut sample)?;
    let sample_truncated = file.metadata()?.len() > n as u64;
    sample.truncate(n);
    if sample.contains(&0)
        && !sample.starts_with(&[0xff, 0xfe])
        && !sample.starts_with(&[0xfe, 0xff])
    {
        return Ok(false);
    }
    Ok(decode_bytes(&sample, sample_truncated).is_ok_and(|text| !text.contains('\0')))
}

pub fn preview(root: &WorkspaceRoot, path: &str, cap: usize) -> Result<Preview> {
    let mut file = open_safe(root, path)?;
    let metadata_len = file.metadata()?.len();
    let source_limit = cap
        .saturating_mul(4)
        .saturating_add(4)
        .min(PREVIEW_SOURCE_LIMIT);
    let mut bytes = Vec::with_capacity(source_limit.min(64 * 1024));
    file.by_ref()
        .take(source_limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    let truncated = metadata_len > bytes.len() as u64 || bytes.len() > source_limit;
    if bytes.len() > source_limit {
        bytes.truncate(source_limit);
    }
    let decoded = decode_bytes(&bytes, truncated)?;
    if decoded.contains('\0') {
        return Err(Error::Message(format!("{path}: binary NUL character")));
    }
    let mut end = decoded.len().min(cap);
    while !decoded.is_char_boundary(end) {
        end -= 1;
    }
    let text = decoded[..end].to_owned();
    Ok(Preview {
        truncated: truncated || end < decoded.len(),
        text,
    })
}
