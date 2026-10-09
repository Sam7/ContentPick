use crate::{
    Error, ManifestEntry, Result, WorkspaceRoot, content, destination::Destination, modified_ns,
};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

const FENCE_WRITE_CHUNK: usize = 4096;

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
    Ok(file)
}

/// Revalidate a frozen manifest using metadata only, without reading file bodies.
pub fn validate_manifest(root: &WorkspaceRoot, manifest: &[ManifestEntry]) -> Result<()> {
    root.validate_anchor()?;
    for entry in manifest {
        drop(verify_entry(root, entry)?);
    }
    Ok(())
}

pub(crate) fn language_tag(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extension = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    [
        ("rs", "rust"),
        ("ts", "typescript"),
        ("tsx", "tsx"),
        ("js", "javascript"),
        ("mjs", "javascript"),
        ("cjs", "javascript"),
        ("jsx", "jsx"),
        ("json", "json"),
        ("md", "markdown"),
        ("markdown", "markdown"),
        ("toml", "toml"),
        ("yaml", "yaml"),
        ("yml", "yaml"),
        ("css", "css"),
        ("html", "html"),
        ("htm", "html"),
        ("xml", "xml"),
        ("csv", "csv"),
        ("py", "python"),
        ("cs", "csharp"),
        ("c", "c"),
        ("h", "c"),
        ("cpp", "cpp"),
        ("cc", "cpp"),
        ("cxx", "cpp"),
        ("hpp", "cpp"),
        ("hxx", "cpp"),
        ("go", "go"),
        ("java", "java"),
        ("swift", "swift"),
        ("sh", "bash"),
        ("bash", "bash"),
        ("sql", "sql"),
    ]
    .iter()
    .find_map(|(candidate, tag)| candidate.eq_ignore_ascii_case(extension).then_some(*tag))
    .unwrap_or("text")
}

fn write_counted<W: Write>(writer: &mut W, data: &[u8], total: &mut u64) -> Result<()> {
    writer.write_all(data)?;
    *total = total
        .checked_add(data.len() as u64)
        .ok_or_else(|| Error::Message("Markdown export byte count overflow".into()))?;
    Ok(())
}

fn write_repeated<W: Write>(
    writer: &mut W,
    byte: u8,
    mut count: usize,
    cancel: &AtomicBool,
    total: &mut u64,
) -> Result<()> {
    let block = [byte; FENCE_WRITE_CHUNK];
    while count > 0 {
        check_cancel(cancel)?;
        let chunk = count.min(block.len());
        write_counted(writer, &block[..chunk], total)?;
        count -= chunk;
    }
    Ok(())
}

fn copy_with_cancel<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cancel: &AtomicBool,
    total: &mut u64,
) -> Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_cancel(cancel)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        write_counted(writer, &buffer[..read], total)?;
    }
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
fn transcode_with_read_hook(
    source: &mut File,
    cancel: &AtomicBool,
    after_payload_read: &mut impl FnMut(),
) -> Result<(File, usize)> {
    let mut spool = tempfile::tempfile()?;
    let mut longest = 0usize;
    let mut run = 0usize;
    content::visit_decoded_text(
        source,
        cancel,
        "export cancelled",
        None,
        after_payload_read,
        &mut |text| {
            update_run(text.as_bytes(), &mut run, &mut longest);
            spool.write_all(text.as_bytes())?;
            Ok(())
        },
    )?;
    spool.seek(SeekFrom::Start(0))?;
    Ok((spool, longest))
}

pub(crate) fn escaped_heading(s: &str) -> String {
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

/// Export a frozen manifest transactionally as Markdown.
///
/// In-root callers must persist the destination's exclusion before exporting.
/// The desktop adapter uses export_prepared to reserve before creating a file.
pub fn export_to(
    root: &WorkspaceRoot,
    manifest: &[ManifestEntry],
    destination: &Path,
    overwrite: bool,
    cancel: &AtomicBool,
) -> Result<ExportResult> {
    export_prepared(
        root,
        manifest,
        Destination::prepare(root, destination, overwrite)?,
        cancel,
    )
}

pub fn export_prepared(
    root: &WorkspaceRoot,
    manifest: &[ManifestEntry],
    destination: Destination,
    cancel: &AtomicBool,
) -> Result<ExportResult> {
    export_prepared_with_read_hook(root, manifest, destination, cancel, &mut || {})
}

fn export_prepared_with_read_hook(
    root: &WorkspaceRoot,
    manifest: &[ManifestEntry],
    destination: Destination,
    cancel: &AtomicBool,
    after_source_read: &mut impl FnMut(),
) -> Result<ExportResult> {
    if manifest.is_empty() {
        return Err(Error::Message("cannot export an empty manifest".into()));
    }
    root.validate_anchor()?;
    if destination
        .relative_path()
        .is_some_and(|path| manifest.iter().any(|entry| entry.path == path))
    {
        return Err(Error::Message(
            "export destination is also a manifest input".into(),
        ));
    }
    let destination_text = destination.path().display().to_string();
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
    let mut transaction = destination.create_temp()?;
    let temp = transaction.file_mut();
    let mut bytes = 0u64;
    write_counted(
        &mut *temp,
        format!("# ContextPick export — {}\n\n", escaped_heading(root_name)).as_bytes(),
        &mut bytes,
    )?;
    for entry in &sorted {
        check_cancel(cancel)?;
        let mut source = verify_entry(root, entry)
            .map_err(|e| Error::Message(format!("{}: {e}", entry.path)))?;
        let (mut content, longest) =
            transcode_with_read_hook(&mut source, cancel, after_source_read)
                .map_err(|e| Error::Message(format!("{}: {e}", entry.path)))?;
        let fence_len = longest
            .max(2)
            .checked_add(1)
            .ok_or_else(|| Error::Message("code fence is too long to represent".into()))?;
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
        write_counted(
            &mut *temp,
            format!("## {}\n\n", escaped_heading(&entry.path)).as_bytes(),
            &mut bytes,
        )?;
        write_repeated(&mut *temp, b'`', fence_len, cancel, &mut bytes)?;
        write_counted(&mut *temp, language_tag(&entry.path).as_bytes(), &mut bytes)?;
        write_counted(&mut *temp, b"\n", &mut bytes)?;
        let content_len = content.seek(SeekFrom::End(0))?;
        content.seek(SeekFrom::Start(content_len.saturating_sub(1)))?;
        let mut last = [0u8; 1];
        let ends_with_newline =
            content_len > 0 && content.read(&mut last)? == 1 && last[0] == b'\n';
        content.seek(SeekFrom::Start(0))?;
        copy_with_cancel(&mut content, &mut *temp, cancel, &mut bytes)?;
        if !ends_with_newline {
            write_counted(&mut *temp, b"\n", &mut bytes)?;
        }
        write_repeated(&mut *temp, b'`', fence_len, cancel, &mut bytes)?;
        write_counted(&mut *temp, b"\n\n", &mut bytes)?;
    }
    check_cancel(cancel)?;
    if temp.metadata()?.len() != bytes {
        return Err(Error::Message(
            "export byte count does not match output file".into(),
        ));
    }
    root.validate_anchor()?;
    transaction.commit(cancel)?;
    Ok(ExportResult {
        bytes,
        files: sorted.len(),
        destination: destination_text,
    })
}

#[cfg(test)]
mod tests {
    use super::{copy_with_cancel, export_prepared_with_read_hook, write_repeated};
    use crate::{Error, ManifestEntry, WorkspaceRoot, destination::Destination, modified_ns};
    use std::io::{self, Read};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::tempdir;

    #[test]
    fn export_rejects_source_mutated_during_read_without_publishing_partial_output() {
        let temp = tempdir().unwrap();
        let root = WorkspaceRoot::open(temp.path()).unwrap();
        let source_path = temp.path().join("file.txt");
        let original = vec![b'a'; 24 * 1024];
        let changed = vec![b'b'; original.len() + 1];
        std::fs::write(&source_path, &original).unwrap();
        let metadata = std::fs::metadata(&source_path).unwrap();
        let manifest = [ManifestEntry {
            path: "file.txt".into(),
            size: metadata.len(),
            modified_ns: modified_ns(&metadata),
        }];
        let destination_path = temp.path().join("context.md");
        let destination = Destination::prepare(&root, &destination_path, false).unwrap();
        let mut mutated = false;

        let error = export_prepared_with_read_hook(
            &root,
            &manifest,
            destination,
            &AtomicBool::new(false),
            &mut || {
                if !mutated {
                    mutated = true;
                    std::fs::write(&source_path, &changed).unwrap();
                }
            },
        )
        .expect_err("a source changed during its read must be rejected");

        assert!(mutated, "the source read hook must run during export");
        assert!(error.to_string().contains("file changed during export"));
        assert!(
            !destination_path.exists(),
            "partial output must not publish"
        );
        let remaining = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(remaining, [std::ffi::OsString::from("file.txt")]);
        assert_eq!(std::fs::read(&source_path).unwrap(), changed);
    }

    struct CancelAfterChunk<'a> {
        cancel: &'a AtomicBool,
        emitted: bool,
    }

    struct CancelOnWrite<'a> {
        cancel: &'a AtomicBool,
        output: Vec<u8>,
    }

    impl io::Write for CancelOnWrite<'_> {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.output.extend_from_slice(buffer);
            self.cancel.store(true, Ordering::Relaxed);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Read for CancelAfterChunk<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.emitted {
                return Ok(0);
            }
            let count = buffer.len().min(8192);
            buffer[..count].fill(b'x');
            self.emitted = true;
            self.cancel.store(true, Ordering::Relaxed);
            Ok(count)
        }
    }

    #[test]
    fn spool_copy_checks_cancellation_between_chunks() {
        let cancel = AtomicBool::new(false);
        let mut reader = CancelAfterChunk {
            cancel: &cancel,
            emitted: false,
        };
        let mut output = Vec::new();
        let mut total = 0;

        let error = copy_with_cancel(&mut reader, &mut output, &cancel, &mut total).unwrap_err();

        assert!(matches!(error, Error::Message(message) if message == "export cancelled"));
        assert_eq!(output, vec![b'x'; 8192]);
        assert_eq!(total, 8192);
    }

    #[test]
    fn long_fence_write_checks_cancellation_between_chunks() {
        let cancel = AtomicBool::new(false);
        let mut writer = CancelOnWrite {
            cancel: &cancel,
            output: Vec::new(),
        };
        let mut total = 0;

        let error = write_repeated(&mut writer, b'`', 8192, &cancel, &mut total).unwrap_err();

        assert!(matches!(error, Error::Message(message) if message == "export cancelled"));
        assert_eq!(writer.output, vec![b'`'; 4096]);
        assert_eq!(total, 4096);
    }

    struct FullDisk {
        remaining: usize,
    }

    impl io::Write for FullDisk {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(io::Error::other("synthetic disk full"));
            }
            let written = self.remaining.min(buffer.len());
            self.remaining -= written;
            Ok(written)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn partial_output_write_failure_is_propagated_without_reporting_success() {
        let mut reader = &b"synthetic source content"[..];
        let mut writer = FullDisk { remaining: 4 };
        let mut total = 0;
        let error = copy_with_cancel(
            &mut reader,
            &mut writer,
            &AtomicBool::new(false),
            &mut total,
        )
        .unwrap_err();
        assert!(matches!(error, Error::Io(error) if error.to_string() == "synthetic disk full"));
        assert_eq!(total, 0);
    }
}
