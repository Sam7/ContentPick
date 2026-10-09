use contextpick_core::workspace::{EntryView, WorkspaceView};
use serde::Serialize;

pub(crate) const PAGE_ENTRY_LIMIT: usize = 512;
pub(crate) const PAGE_BYTE_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileCatalog {
    pub root: String,
    pub generation: u64,
    pub names: Vec<String>,
    pub active_profile: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceResponse {
    #[serde(flatten)]
    pub view: WorkspaceView,
    pub entry_count: usize,
    pub next_offset: Option<usize>,
    pub profile_catalog: ProfileCatalog,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePage {
    pub root: String,
    pub generation: u64,
    pub offset: usize,
    pub entries: Vec<EntryView>,
    pub next_offset: Option<usize>,
}

fn serialized_len(value: &impl Serialize) -> Result<usize, String> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|e| e.to_string())
}

fn bounded_entries(
    view: &WorkspaceView,
    offset: usize,
    overhead: usize,
) -> Result<(Vec<EntryView>, Option<usize>), String> {
    if offset > view.entries.len() {
        return Err("invalid workspace page offset".into());
    }
    // Reserve space for replacing null with a next-offset number in the envelope.
    let mut bytes = overhead.saturating_add(32);
    if bytes > PAGE_BYTE_LIMIT {
        return Err("workspace metadata exceeds the 256 KiB IPC limit".into());
    }
    let mut entries = Vec::new();
    for entry in view.entries.iter().skip(offset).take(PAGE_ENTRY_LIMIT) {
        let cost = serialized_len(entry)?.saturating_add(1);
        if bytes.saturating_add(cost) > PAGE_BYTE_LIMIT {
            if entries.is_empty() {
                return Err("a workspace entry exceeds the 256 KiB IPC limit".into());
            }
            break;
        }
        bytes += cost;
        entries.push(entry.clone());
    }
    let end = offset + entries.len();
    Ok((entries, (end < view.entries.len()).then_some(end)))
}

pub(crate) fn initial(
    view: &WorkspaceView,
    profile_catalog: ProfileCatalog,
) -> Result<WorkspaceResponse, String> {
    let mut response = WorkspaceResponse {
        view: WorkspaceView {
            root: view.root.clone(),
            generation: view.generation,
            entries: vec![],
            selected_count: view.selected_count,
            estimated_bytes: view.estimated_bytes,
            incomplete: view.incomplete,
            diagnostics: view.diagnostics.clone(),
            policy: view.policy.clone(),
        },
        entry_count: view.entries.len(),
        next_offset: None,
        profile_catalog,
    };
    let (entries, next_offset) = bounded_entries(view, 0, serialized_len(&response)?)?;
    response.view.entries = entries;
    response.next_offset = next_offset;
    Ok(response)
}

pub(crate) fn page(view: &WorkspaceView, offset: usize) -> Result<WorkspacePage, String> {
    let mut response = WorkspacePage {
        root: view.root.clone(),
        generation: view.generation,
        offset,
        entries: vec![],
        next_offset: None,
    };
    let (entries, next_offset) = bounded_entries(view, offset, serialized_len(&response)?)?;
    response.entries = entries;
    response.next_offset = next_offset;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use contextpick_core::workspace::{EntryView, FilterPolicy, WorkspaceView};

    fn fixture(count: usize) -> WorkspaceView {
        WorkspaceView {
            root: "synthetic-root".into(),
            generation: 7,
            entries: (0..count)
                .map(|n| EntryView {
                    path: format!("file-{n:05}.ts"),
                    kind: "file".into(),
                    size: 16,
                    selected: true,
                    force_included: false,
                    git_ignored: false,
                    reason: None,
                    enumerated: true,
                    partial: false,
                })
                .collect(),
            selected_count: count,
            estimated_bytes: count as u64 * 80,
            incomplete: false,
            diagnostics: vec![],
            policy: FilterPolicy::default(),
        }
    }

    fn profile_catalog(view: &WorkspaceView) -> ProfileCatalog {
        ProfileCatalog {
            root: view.root.clone(),
            generation: view.generation,
            names: vec![],
            active_profile: None,
        }
    }

    #[test]
    fn twenty_thousand_entries_transfer_in_bounded_ordered_pages() {
        let view = fixture(20_000);
        let first = initial(&view, profile_catalog(&view)).unwrap();
        assert_eq!(first.entry_count, 20_000);
        assert_eq!(first.view.entries.len(), PAGE_ENTRY_LIMIT);
        assert_eq!(first.view.selected_count, 20_000);
        assert!(serde_json::to_vec(&first).unwrap().len() <= PAGE_BYTE_LIMIT);
        let mut paths: Vec<_> = first.view.entries.iter().map(|e| e.path.clone()).collect();
        let mut offset = first.next_offset;
        while let Some(next) = offset {
            let chunk = page(&view, next).unwrap();
            assert_eq!(chunk.offset, paths.len());
            assert_eq!(chunk.generation, 7);
            assert!(chunk.entries.len() <= PAGE_ENTRY_LIMIT);
            assert!(serde_json::to_vec(&chunk).unwrap().len() <= PAGE_BYTE_LIMIT);
            paths.extend(chunk.entries.iter().map(|e| e.path.clone()));
            offset = chunk.next_offset;
        }
        assert_eq!(
            paths,
            view.entries
                .iter()
                .map(|e| e.path.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn serialized_byte_budget_accounts_for_escaping_unicode_and_metadata() {
        let mut view = fixture(1_000);
        for entry in &mut view.entries {
            entry.reason = Some("quote\"\n\\é".repeat(300));
        }
        let first = initial(&view, profile_catalog(&view)).unwrap();
        assert!(first.view.entries.len() < PAGE_ENTRY_LIMIT);
        assert!(!first.view.entries.is_empty());
        assert!(serde_json::to_vec(&first).unwrap().len() <= PAGE_BYTE_LIMIT);
        let second = page(&view, first.next_offset.unwrap()).unwrap();
        assert!(!second.entries.is_empty());
        assert!(serde_json::to_vec(&second).unwrap().len() <= PAGE_BYTE_LIMIT);
        view.diagnostics.push("x".repeat(PAGE_BYTE_LIMIT));
        assert!(initial(&view, profile_catalog(&view)).is_err());
    }

    #[test]
    fn initial_page_budget_includes_worst_case_profile_catalog_escaping() {
        let view = fixture(20_000);
        let names: Vec<_> = (0..20)
            .map(|index| format!("{index:02}{}", "\u{0001}".repeat(78)))
            .collect();
        let profile_catalog = ProfileCatalog {
            root: view.root.clone(),
            generation: view.generation,
            active_profile: names.first().cloned(),
            names,
        };

        let response = initial(&view, profile_catalog).unwrap();

        assert!(serde_json::to_vec(&response).unwrap().len() <= PAGE_BYTE_LIMIT);
    }

    #[test]
    fn empty_end_invalid_offsets_and_oversized_entry_are_explicit() {
        let empty_view = fixture(0);
        let empty = initial(&empty_view, profile_catalog(&empty_view)).unwrap();
        assert!(empty.view.entries.is_empty());
        assert!(empty.next_offset.is_none());
        let mut view = fixture(1);
        assert!(page(&view, 1).unwrap().next_offset.is_none());
        assert!(page(&view, 2).is_err());
        assert!(page(&view, usize::MAX).is_err());
        view.entries[0].reason = Some("x".repeat(PAGE_BYTE_LIMIT));
        assert!(initial(&view, profile_catalog(&view)).is_err());
        assert!(page(&view, 0).is_err());
    }
}
