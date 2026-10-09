use crate::{Error, Result, WorkspaceRoot};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const SAMPLE_LIMIT: usize = 16 * 1024;
const PREVIEW_SOURCE_LIMIT: usize = 16 * 1024 * 1024;
pub(crate) const DECODE_CHUNK_BYTES: usize = 8192;
pub(crate) const MAX_DECODED_TEXT_CHUNK_BYTES: usize = DECODE_CHUNK_BYTES * 3 / 2 + 4;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub text: String,
    pub truncated: bool,
}

pub(crate) fn checked_relative(path: &str) -> Result<PathBuf> {
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

pub(crate) fn visit_decoded_text<R: Read + Seek>(
    source: &mut R,
    cancel: &AtomicBool,
    cancel_message: &str,
    max_input_bytes: Option<u64>,
    after_read: &mut impl FnMut(),
    visit: &mut impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    let check_cancel = || {
        if cancel.load(Ordering::Relaxed) {
            Err(Error::Message(cancel_message.into()))
        } else {
            Ok(())
        }
    };

    check_cancel()?;
    source.seek(SeekFrom::Start(0))?;
    let mut prefix = [0u8; 3];
    let mut got = 0;
    while got < prefix.len() {
        check_cancel()?;
        let read = source.read(&mut prefix[got..])?;
        if read == 0 {
            break;
        }
        got += read;
        if max_input_bytes.is_some_and(|limit| got as u64 > limit) {
            return Err(Error::Message(
                "file exceeds token estimate input limit".into(),
            ));
        }
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
    if max_input_bytes.is_some_and(|limit| skip as u64 > limit) {
        return Err(Error::Message(
            "file exceeds token estimate input limit".into(),
        ));
    }
    source.seek(SeekFrom::Start(skip as u64))?;

    let mut total_read = 0u64;
    let mut buffer = [0u8; DECODE_CHUNK_BYTES];
    if encoding == 0 {
        let mut carry = Vec::with_capacity(buffer.len() + 3);
        loop {
            check_cancel()?;
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total_read = total_read
                .checked_add(read as u64)
                .ok_or_else(|| Error::Message("file byte count overflow".into()))?;
            if max_input_bytes.is_some_and(|limit| total_read.saturating_add(skip as u64) > limit) {
                return Err(Error::Message(
                    "file exceeds token estimate input limit".into(),
                ));
            }
            after_read();
            carry.extend_from_slice(&buffer[..read]);
            match std::str::from_utf8(&carry) {
                Ok(text) => {
                    if text.contains('\0') {
                        return Err(Error::Message("binary NUL character".into()));
                    }
                    visit(text)?;
                    carry.clear();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        let text = std::str::from_utf8(&carry[..valid])
                            .map_err(|_| Error::Message("invalid UTF-8 content".into()))?;
                        if text.contains('\0') {
                            return Err(Error::Message("binary NUL character".into()));
                        }
                        visit(text)?;
                        carry.drain(..valid);
                    }
                    if error.error_len().is_some() || carry.len() > 3 {
                        return Err(Error::Message("invalid UTF-8 content".into()));
                    }
                }
            }
        }
        if !carry.is_empty() {
            return Err(Error::Message("incomplete UTF-8 content".into()));
        }
    } else {
        let little_endian = encoding == 1;
        let mut carry = Vec::with_capacity(buffer.len() + 1);
        let mut high_surrogate: Option<u16> = None;
        loop {
            check_cancel()?;
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total_read = total_read
                .checked_add(read as u64)
                .ok_or_else(|| Error::Message("file byte count overflow".into()))?;
            if max_input_bytes.is_some_and(|limit| total_read.saturating_add(skip as u64) > limit) {
                return Err(Error::Message(
                    "file exceeds token estimate input limit".into(),
                ));
            }
            after_read();
            carry.extend_from_slice(&buffer[..read]);
            let usable = carry.len() & !1;
            let mut words: Vec<u16> = carry[..usable]
                .chunks_exact(2)
                .map(|pair| {
                    if little_endian {
                        u16::from_le_bytes([pair[0], pair[1]])
                    } else {
                        u16::from_be_bytes([pair[0], pair[1]])
                    }
                })
                .collect();
            carry.drain(..usable);
            if let Some(high) = high_surrogate.take() {
                words.insert(0, high);
            }
            if words
                .last()
                .is_some_and(|word| (0xd800..=0xdbff).contains(word))
            {
                high_surrogate = words.pop();
            }
            let mut text = String::with_capacity(words.len().saturating_mul(2));
            for decoded in char::decode_utf16(words) {
                match decoded {
                    Ok(character) => text.push(character),
                    Err(_) => return Err(Error::Message("invalid UTF-16 content".into())),
                }
            }
            if text.contains('\0') {
                return Err(Error::Message("binary NUL character".into()));
            }
            if !text.is_empty() {
                visit(&text)?;
            }
        }
        if !carry.is_empty() || high_surrogate.is_some() {
            return Err(Error::Message("incomplete UTF-16 content".into()));
        }
    }
    check_cancel()?;
    Ok(())
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

#[cfg(test)]
mod streaming_decode_tests {
    use super::visit_decoded_text;
    use crate::Result;
    use std::io::{self, Cursor, Read, Seek, SeekFrom};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct ShortRead {
        inner: Cursor<Vec<u8>>,
        max_read: usize,
    }

    impl ShortRead {
        fn new(bytes: Vec<u8>, max_read: usize) -> Self {
            Self {
                inner: Cursor::new(bytes),
                max_read,
            }
        }
    }

    impl Read for ShortRead {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let length = buffer.len().min(self.max_read);
            self.inner.read(&mut buffer[..length])
        }
    }

    impl Seek for ShortRead {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.inner.seek(position)
        }
    }

    fn decode_short_reads(bytes: Vec<u8>, max_read: usize) -> Result<String> {
        let mut source = ShortRead::new(bytes, max_read);
        let cancelled = AtomicBool::new(false);
        let mut decoded = String::new();
        visit_decoded_text(
            &mut source,
            &cancelled,
            "cancelled",
            None,
            &mut || {},
            &mut |chunk| {
                decoded.push_str(chunk);
                Ok(())
            },
        )?;
        Ok(decoded)
    }

    #[test]
    fn strips_utf8_bom_and_decodes_multibyte_characters_across_single_byte_reads() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice("naïve 🧪".as_bytes());

        assert_eq!(decode_short_reads(bytes, 1).unwrap(), "naïve 🧪");
    }

    #[test]
    fn decodes_big_endian_utf16_with_odd_read_boundaries_and_split_surrogate_pairs() {
        let mut bytes = vec![0xfe, 0xff];
        for word in "A🧪B".encode_utf16() {
            bytes.extend_from_slice(&word.to_be_bytes());
        }

        assert_eq!(decode_short_reads(bytes, 1).unwrap(), "A🧪B");
    }

    #[test]
    fn rejects_lone_surrogates_and_incomplete_utf16_code_units() {
        assert!(decode_short_reads(vec![0xff, 0xfe, 0x00, 0xdc], 1).is_err());
        assert!(decode_short_reads(vec![0xff, 0xfe, 0x41], 1).is_err());
        assert!(decode_short_reads(vec![0xff, 0xfe, 0x00, 0xd8], 1).is_err());
    }

    #[test]
    fn cancellation_during_utf16_streaming_returns_an_error() {
        let mut source = ShortRead::new(vec![0xff, 0xfe, 0x41, 0x00, 0x42, 0x00], 1);
        let cancelled = AtomicBool::new(false);
        let mut decoded = String::new();
        let result = visit_decoded_text(
            &mut source,
            &cancelled,
            "cancelled",
            None,
            &mut || {
                cancelled.store(true, Ordering::Relaxed);
            },
            &mut |chunk| {
                decoded.push_str(chunk);
                Ok(())
            },
        );

        assert!(result.is_err());
        assert!(decoded.is_empty());
    }
}
