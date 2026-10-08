use crate::{Error, ManifestEntry, Result, WorkspaceRoot, content, modified_ns};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_FENCE_RUN: usize = 4096;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub bytes: u64,
    pub files: usize,
    pub destination: String,
}

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(Error::Message("export cancelled".into()))
    } else {
        Ok(())
    }
}

fn verify_entry(root: &WorkspaceRoot, entry: &ManifestEntry) -> Result<File> {
    let file = content::open_safe(root, &entry.path)
        .map_err(|e| Error::Message(format!("{}: {e}", entry.path)))?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() != entry.size || modified_ns(&before) != entry.modified_ns
    {
        return Err(Error::Message(format!(
            "{}: file changed since manifest",
            entry.path
        )));
    }
    let opened = file.metadata()?;
    if opened.len() != entry.size || modified_ns(&opened) != entry.modified_ns {
        return Err(Error::Message(format!(
            "{}: file changed since manifest",
            entry.path
        )));
    }
    Ok(file)
}

fn update_run(bytes: &[u8], current: &mut usize, longest: &mut usize) {
    for &b in bytes {
        if b == b'`' {
            *current = current.saturating_add(1);
            *longest = (*longest).max(*current);
        } else {
            *current = 0;
        }
    }
}

// Decode one source into a disk-backed UTF-8 spool, validating all input while
// retaining only a small read buffer. The spool also lets us choose a fence
// longer than every backtick run before writing the Markdown section.
fn transcode(source: &mut File, cancel: &AtomicBool) -> Result<(File, usize)> {
    source.seek(SeekFrom::Start(0))?;
    let mut prefix = [0u8; 3];
    let mut got = 0;
    while got < prefix.len() {
        let n = source.read(&mut prefix[got..])?;
        if n == 0 {
            break;
        }
        got += n;
    }
    let (encoding, skip) = if got >= 3 && prefix[..3] == [0xef, 0xbb, 0xbf] {
        (0, 3)
    } else if got >= 2 && prefix[..2] == [0xff, 0xfe] {
        (1, 2)
    } else if got >= 2 && prefix[..2] == [0xfe, 0xff] {
        (2, 2)
    } else {
        (0, 0)
    };
    source.seek(SeekFrom::Start(skip as u64))?;
    let mut spool = tempfile::tempfile()?;
    let mut longest = 0usize;
    let mut run = 0usize;
    let mut buf = [0u8; 8192];
    if encoding == 0 {
        let mut carry = Vec::new();
        loop {
            check_cancel(cancel)?;
            let n = source.read(&mut buf)?;
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&buf[..n]);
            match std::str::from_utf8(&carry) {
                Ok(s) => {
                    if s.contains('\0') {
                        return Err(Error::Message("binary NUL character".into()));
                    }
                    update_run(s.as_bytes(), &mut run, &mut longest);
                    spool.write_all(s.as_bytes())?;
                    carry.clear();
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        if carry[..valid].contains(&0) {
                            return Err(Error::Message("binary NUL character".into()));
                        }
                        update_run(&carry[..valid], &mut run, &mut longest);
                        spool.write_all(&carry[..valid])?;
                        carry.drain(..valid);
                    }
                    if e.error_len().is_some() || carry.len() > 3 {
                        return Err(Error::Message("invalid UTF-8 content".into()));
                    }
                }
            }
        }
        if !carry.is_empty() {
            return Err(Error::Message("incomplete UTF-8 content".into()));
        }
    } else {
        let little = encoding == 1;
        let mut carry = Vec::new();
        let mut high: Option<u16> = None;
        loop {
            check_cancel(cancel)?;
            let n = source.read(&mut buf)?;
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&buf[..n]);
            if carry.len() % 2 != 0 {
                let last = carry.pop().unwrap();
                carry.push(last);
            }
            let usable = carry.len() & !1;
            let mut words: Vec<u16> = carry[..usable]
                .chunks_exact(2)
                .map(|p| {
                    if little {
                        u16::from_le_bytes([p[0], p[1]])
                    } else {
                        u16::from_be_bytes([p[0], p[1]])
                    }
                })
                .collect();
            carry.drain(..usable);
            if let Some(h) = high.take() {
                words.insert(0, h);
            }
            if words.last().is_some_and(|w| (0xd800..=0xdbff).contains(w)) {
                high = words.pop();
            }
            let mut text = String::new();
            for decoded in char::decode_utf16(words) {
                match decoded {
                    Ok(c) => text.push(c),
                    Err(_) => return Err(Error::Message("invalid UTF-16 content".into())),
                }
            }
            if text.contains('\0') {
                return Err(Error::Message("binary NUL character".into()));
            }
            update_run(text.as_bytes(), &mut run, &mut longest);
            spool.write_all(text.as_bytes())?;
        }
        if !carry.is_empty() || high.is_some() {
            return Err(Error::Message("incomplete UTF-16 content".into()));
        }
    }
    spool.seek(SeekFrom::Start(0))?;
    Ok((spool, longest))
}

fn escaped_heading(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '\n' => {
                out.push_str("\\n");
                continue;
            }
            '\r' => {
                out.push_str("\\r");
                continue;
            }
            '\t' => {
                out.push_str("\\t");
                continue;
            }
            _ if c.is_control() => {
                out.push_str(&format!("\\u{{{:x}}}", c as u32));
                continue;
            }
            _ => {}
        }
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '#') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn destination_outside_root(root: &Path, destination: &Path) -> Result<(PathBuf, PathBuf)> {
    let root = fs::canonicalize(root)?;
    let absolute = if destination.is_absolute() {
        destination.to_path_buf()
    } else {
        std::env::current_dir()?.join(destination)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| Error::Message("destination has no parent".into()))?;
    let canonical_parent = fs::canonicalize(parent)?;
    let target = canonical_parent.join(
        absolute
            .file_name()
            .ok_or_else(|| Error::Message("destination has no filename".into()))?,
    );
    if target.starts_with(&root) {
        return Err(Error::Message(
            "destination must be outside the workspace root".into(),
        ));
    }
    if target.exists() {
        let resolved = fs::canonicalize(&target)?;
        if resolved.starts_with(&root) {
            return Err(Error::Message(
                "destination must be outside the workspace root".into(),
            ));
        }
    }
    Ok((target, canonical_parent))
}

/// Export a frozen manifest transactionally as Markdown.
///
/// The destination must be outside `root`. This slice rejects in-root output
/// paths so an export cannot mutate sources or become part of a later scan.
pub fn export_to(
    root: &WorkspaceRoot,
    manifest: &[ManifestEntry],
    destination: &Path,
    overwrite: bool,
    cancel: &AtomicBool,
) -> Result<ExportResult> {
    if manifest.is_empty() {
        return Err(Error::Message("cannot export an empty manifest".into()));
    }
    root.validate_anchor()?;
    let (target, parent) = destination_outside_root(root.path(), destination)?;
    let mut sorted = manifest.to_vec();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    for pair in sorted.windows(2) {
        if pair[0].path == pair[1].path {
            return Err(Error::Message(format!(
                "duplicate manifest path: {}",
                pair[0].path
            )));
        }
    }
    let root_name = root
        .path()
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace");
    let mut temp = tempfile::NamedTempFile::new_in(&parent)?;
    let mut bytes = 0u64;
    macro_rules! emit {
        ($data:expr) => {{
            let data: Vec<u8> = ($data).to_vec();
            temp.write_all(&data)?;
            bytes += data.len() as u64;
        }};
    }
    emit!(format!("# ContextPick export — {}\n\n", escaped_heading(root_name)).as_bytes());
    for entry in &sorted {
        check_cancel(cancel)?;
        let mut source = verify_entry(root, entry)
            .map_err(|e| Error::Message(format!("{}: {e}", entry.path)))?;
        let (mut content, longest) = transcode(&mut source, cancel)
            .map_err(|e| Error::Message(format!("{}: {e}", entry.path)))?;
        if longest >= MAX_FENCE_RUN {
            return Err(Error::Message(format!(
                "{}: backtick run exceeds export fence limit",
                entry.path
            )));
        }
        let after = source.metadata()?;
        let path_after = content::open_safe(root, &entry.path)?.metadata()?;
        if after.len() != entry.size
            || modified_ns(&after) != entry.modified_ns
            || path_after.len() != entry.size
            || modified_ns(&path_after) != entry.modified_ns
        {
            return Err(Error::Message(format!(
                "{}: file changed during export",
                entry.path
            )));
        }
        let fence = "`".repeat(longest.max(2) + 1);
        emit!(format!("## {}\n\n{}text\n", escaped_heading(&entry.path), fence).as_bytes());
        let content_len = content.seek(SeekFrom::End(0))?;
        content.seek(SeekFrom::Start(content_len.saturating_sub(1)))?;
        let mut last = [0u8; 1];
        let ends_with_newline =
            content_len > 0 && content.read(&mut last)? == 1 && last[0] == b'\n';
        content.seek(SeekFrom::Start(0))?;
        let copied = std::io::copy(&mut content, &mut temp)?;
        bytes += copied;
        if !ends_with_newline {
            emit!(b"\n");
        }
        emit!(format!("{}\n\n", fence).as_bytes());
    }
    check_cancel(cancel)?;
    temp.as_file_mut().sync_all()?;
    let destination_text = destination.to_string_lossy().to_string();
    root.validate_anchor()?;
    if overwrite {
        temp.persist(&target).map_err(|e| Error::Io(e.error))?;
    } else {
        temp.persist_noclobber(&target)
            .map_err(|e| Error::Io(e.error))?;
    }
    Ok(ExportResult {
        bytes,
        files: sorted.len(),
        destination: destination_text,
    })
}
