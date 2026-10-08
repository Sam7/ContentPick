#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod paging;

use contextpick_core::{
    content,
    destination::Destination,
    export::{self, ExportResult},
    preferences::{Preferences, SavedWorkspace},
    selection::Intent,
    workspace::{FilterPolicy, Workspace, WorkspaceView},
};
use paging::{WorkspacePage, WorkspaceResponse};
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Session {
    workspace: Option<Workspace>,
    snapshot: Option<Arc<WorkspaceView>>,
    generation: u64,
    cancel: Arc<AtomicBool>,
    preferences: Preferences,
    settings_path: std::path::PathBuf,
    startup_notice: Option<String>,
    settings_saving_blocked: bool,
}
type Shared = Arc<Mutex<Session>>;
type CommandResult<T> = std::result::Result<T, String>;

fn lock(shared: &Shared) -> CommandResult<std::sync::MutexGuard<'_, Session>> {
    shared
        .lock()
        .map_err(|_| "application state unavailable".into())
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| e.to_string())?
}

fn begin_scan(shared: &Shared) -> CommandResult<(u64, Arc<AtomicBool>)> {
    let mut state = lock(shared)?;
    state.cancel.store(true, Ordering::Relaxed);
    state.generation += 1;
    state.cancel = Arc::new(AtomicBool::new(false));
    Ok((state.generation, state.cancel.clone()))
}

fn publish(
    shared: &Shared,
    workspace: Workspace,
    generation: u64,
) -> CommandResult<WorkspaceResponse> {
    let snapshot = Arc::new(workspace.view(generation));
    let response = paging::initial(&snapshot)?;
    let mut state = lock(shared)?;
    if state.generation != generation {
        return Err("operation superseded by a newer request".into());
    }
    persist_workspace(&mut state, &workspace)?;
    state.workspace = Some(workspace);
    state.snapshot = Some(snapshot);
    Ok(response)
}

fn get_workspace_page(
    shared: &Shared,
    generation: u64,
    offset: usize,
) -> CommandResult<WorkspacePage> {
    let snapshot = {
        let state = lock(shared)?;
        if state.generation != generation {
            return Err("workspace page superseded by a newer request".into());
        }
        state
            .snapshot
            .clone()
            .filter(|view| view.generation == generation)
            .ok_or("workspace snapshot is not ready")?
    };
    let response = paging::page(&snapshot, offset)?;
    if lock(shared)?.generation != generation {
        return Err("workspace page superseded by a newer request".into());
    }
    Ok(response)
}

#[tauri::command]
async fn workspace_page(
    generation: u64,
    offset: usize,
    state: State<'_, Shared>,
) -> CommandResult<WorkspacePage> {
    let shared = state.inner().clone();
    blocking(move || get_workspace_page(&shared, generation, offset)).await
}

fn persist_workspace(state: &mut Session, workspace: &Workspace) -> CommandResult<()> {
    if state.settings_saving_blocked {
        return Err(format!(
            "Settings recovery could not preserve the original at {}. Copy it to a safe location, fix config directory permissions and restart ContextPick before saving changes.",
            state.settings_path.display()
        ));
    }
    let mut preferences = state.preferences.clone();
    {
        let root = workspace.root.display().to_string();
        preferences.recent_root = Some(root.clone());
        preferences.workspaces.insert(
            root,
            SavedWorkspace {
                policy: workspace.policy.clone(),
                intents: workspace.intents.clone(),
                generated_outputs: workspace.generated_outputs.clone(),
            },
        );
    }
    preferences
        .save(&state.settings_path)
        .map_err(|e| format!("Could not save preferences: {e}"))?;
    state.preferences = preferences;
    Ok(())
}

#[tauri::command]
async fn restore_workspace(state: State<'_, Shared>) -> CommandResult<Option<WorkspaceResponse>> {
    let shared = state.inner().clone();
    let (generation, cancel) = begin_scan(&shared)?;
    blocking(move || {
        let (root, saved, notice) = {
            let mut state = lock(&shared)?;
            let notice = state.startup_notice.take();
            let Some(root) = state.preferences.recent_root.clone() else {
                return match notice {
                    Some(notice) => Err(notice),
                    None => Ok(None),
                };
            };
            let saved = state
                .preferences
                .workspaces
                .get(&root)
                .cloned()
                .unwrap_or_default();
            (root, saved, notice)
        };
        let mut workspace = Workspace::scan_with_outputs(
            std::path::Path::new(&root),
            saved.policy,
            saved.intents,
            BTreeSet::new(),
            saved.generated_outputs,
            &cancel,
        )
        .map_err(|e| format!("Recent folder unavailable: {e}. Open a folder to continue."))?;
        if let Some(notice) = notice {
            workspace.diagnostics.push(notice);
        }
        publish(&shared, workspace, generation).map(Some)
    })
    .await
}

#[tauri::command]
async fn choose_workspace(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
) -> CommandResult<Option<WorkspaceResponse>> {
    let shared = state.inner().clone();
    let (generation, cancel) = begin_scan(&shared)?;
    blocking(move || {
        let Some(path) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        let saved = lock(&shared)?
            .preferences
            .workspaces
            .get(&canonical.display().to_string())
            .cloned()
            .unwrap_or_default();
        let workspace = Workspace::scan_with_outputs(
            &path,
            saved.policy,
            saved.intents,
            BTreeSet::new(),
            saved.generated_outputs,
            &cancel,
        )
        .map_err(|e| e.to_string())?;
        publish(&shared, workspace, generation).map(Some)
    })
    .await
}

async fn rescan(
    shared: Shared,
    policy: Option<FilterPolicy>,
    browse: Option<String>,
) -> CommandResult<WorkspaceResponse> {
    let mut previous = lock(&shared)?
        .workspace
        .clone()
        .ok_or("choose a workspace first")?;
    if let Some(policy) = policy {
        previous.policy = policy;
    }
    if let Some(path) = browse {
        if !previous
            .view(0)
            .entries
            .iter()
            .any(|e| e.path == path && e.kind == "directory")
        {
            return Err("unknown directory".into());
        }
        previous.browsed.insert(path);
    }
    rescan_candidate(shared, previous).await
}

async fn rescan_candidate(shared: Shared, previous: Workspace) -> CommandResult<WorkspaceResponse> {
    let (generation, cancel) = begin_scan(&shared)?;
    blocking(move || {
        let workspace = Workspace::scan_pinned_with_outputs(
            previous.root_handle,
            previous.policy,
            previous.intents,
            previous.browsed,
            previous.generated_outputs,
            &cancel,
        )
        .map_err(|e| e.to_string())?;
        publish(&shared, workspace, generation)
    })
    .await
}

#[tauri::command]
async fn refresh_workspace(state: State<'_, Shared>) -> CommandResult<WorkspaceResponse> {
    rescan(state.inner().clone(), None, None).await
}
#[tauri::command]
async fn set_policy(
    policy: FilterPolicy,
    state: State<'_, Shared>,
) -> CommandResult<WorkspaceResponse> {
    rescan(state.inner().clone(), Some(policy), None).await
}
#[tauri::command]
async fn browse_ignored(
    path: String,
    state: State<'_, Shared>,
) -> CommandResult<WorkspaceResponse> {
    rescan(state.inner().clone(), None, Some(path)).await
}

#[tauri::command]
async fn set_intent(
    path: String,
    intent: Option<Intent>,
    state: State<'_, Shared>,
) -> CommandResult<WorkspaceResponse> {
    let shared = state.inner().clone();
    let mut workspace = lock(&shared)?
        .workspace
        .clone()
        .ok_or("choose a workspace first")?;
    if !path.is_empty() && !workspace.view(0).entries.iter().any(|e| e.path == path) {
        return Err("unknown workspace path".into());
    }
    match intent {
        Some(intent) => {
            workspace.intents.insert(path, intent);
        }
        None => {
            workspace.intents.remove(&path);
        }
    }
    if intent == Some(Intent::ForceInclude) {
        return rescan_candidate(shared, workspace).await;
    }
    let (generation, _) = begin_scan(&shared)?;
    blocking(move || publish(&shared, workspace, generation)).await
}

#[tauri::command]
async fn reset_selections(state: State<'_, Shared>) -> CommandResult<WorkspaceResponse> {
    let shared = state.inner().clone();
    let mut workspace = lock(&shared)?
        .workspace
        .clone()
        .ok_or("choose a workspace first")?;
    workspace.intents.clear();
    rescan_candidate(shared, workspace).await
}

#[tauri::command]
async fn preview_file(path: String, state: State<'_, Shared>) -> CommandResult<content::Preview> {
    let root = lock(state.inner())?
        .workspace
        .as_ref()
        .ok_or("choose a workspace first")?
        .root_handle
        .clone();
    blocking(move || content::preview(&root, &path, 256 * 1024).map_err(|e| e.to_string())).await
}

struct FrozenExport {
    root: contextpick_core::WorkspaceRoot,
    entries: Vec<contextpick_core::ManifestEntry>,
    cancel: Arc<AtomicBool>,
    generation: u64,
}

fn manifest(shared: &Shared) -> CommandResult<FrozenExport> {
    let mut state = lock(shared)?;
    state.cancel.store(true, Ordering::Relaxed);
    state.cancel = Arc::new(AtomicBool::new(false));
    let workspace = state.workspace.as_ref().ok_or("choose a workspace first")?;
    Ok(FrozenExport {
        root: workspace.root_handle.clone(),
        entries: workspace.manifest(),
        cancel: state.cancel.clone(),
        generation: state.generation,
    })
}

fn reserve_output(shared: &Shared, generation: u64, path: &str) -> CommandResult<()> {
    let mut state = lock(shared)?;
    if generation != state.generation || state.cancel.load(Ordering::Relaxed) {
        return Err("export superseded by a newer request".into());
    }
    let mut candidate = state.workspace.clone().ok_or("choose a workspace first")?;
    candidate.generated_outputs.insert(path.to_owned());
    persist_workspace(&mut state, &candidate)?;
    state.workspace = Some(candidate);
    Ok(())
}

#[tauri::command]
async fn export_markdown(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
) -> CommandResult<Option<ExportResult>> {
    let shared = state.inner().clone();
    let FrozenExport {
        root,
        entries,
        cancel,
        generation,
    } = manifest(&shared)?;
    blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name("context.md")
            .add_filter("Markdown", &["md"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let destination = path.into_path().map_err(|e| e.to_string())?;
        let overwrite = destination.exists();
        let prepared =
            Destination::prepare(&root, &destination, overwrite).map_err(|e| e.to_string())?;
        if overwrite
            && !app
                .dialog()
                .message("Replace the existing export file?")
                .title("Confirm overwrite")
                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
                .blocking_show()
        {
            return Ok(None);
        }
        {
            let state = lock(&shared)?;
            if state.generation != generation || cancel.load(Ordering::Relaxed) {
                return Err("export cancelled or superseded by a newer request".into());
            }
        }
        if let Some(path) = prepared.relative_path() {
            reserve_output(&shared, generation, path)?;
        }
        export::export_prepared(&root, &entries, prepared, &cancel)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn copy_markdown(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
) -> CommandResult<ExportResult> {
    let shared = state.inner().clone();
    let FrozenExport {
        root,
        entries,
        cancel,
        ..
    } = manifest(&shared)?;
    blocking(move || {
        const LIMIT: u64 = 8 * 1024 * 1024;
        clipboard_preflight(&entries, LIMIT)?;
        let temp = tempfile::Builder::new()
            .prefix(contextpick_core::destination::TEMP_PREFIX)
            .tempdir()
            .map_err(|e| e.to_string())?;
        let path = temp.path().join("clipboard.md");
        let mut result =
            export::export_to(&root, &entries, &path, false, &cancel).map_err(|e| e.to_string())?;
        if result.bytes > LIMIT {
            return Err("Markdown exceeds 8 MiB clipboard safety limit; export to a file".into());
        }
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        write_clipboard(&cancel, text, |text| {
            app.clipboard().write_text(text).map_err(|e| e.to_string())
        })?;
        result.destination = "Clipboard".into();
        Ok(result)
    })
    .await
}

fn clipboard_preflight(
    entries: &[contextpick_core::ManifestEntry],
    limit: u64,
) -> CommandResult<()> {
    entries.iter().try_fold(0u64, |total, entry| {
        total
            .checked_add(entry.size)
            .filter(|size| *size <= limit)
            .ok_or("selection exceeds 8 MiB clipboard safety limit; export to a file")
    })?;
    Ok(())
}

fn write_clipboard(
    cancel: &AtomicBool,
    text: String,
    write: impl FnOnce(String) -> CommandResult<()>,
) -> CommandResult<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err("copy cancelled".into());
    }
    write(text)
}

#[tauri::command]
async fn cancel_operation(state: State<'_, Shared>) -> CommandResult<Option<WorkspaceResponse>> {
    let shared = state.inner().clone();
    blocking(move || cancel_and_snapshot(&shared)).await
}

fn cancel_and_snapshot(shared: &Shared) -> CommandResult<Option<WorkspaceResponse>> {
    let (generation, workspace) = {
        let mut state = lock(shared)?;
        state.cancel.store(true, Ordering::Relaxed);
        state.generation += 1;
        state.cancel = Arc::new(AtomicBool::new(false));
        (state.generation, state.workspace.clone())
    };
    let snapshot = workspace.map(|workspace| Arc::new(workspace.view(generation)));
    let response = snapshot
        .as_ref()
        .map(|view| paging::initial(view))
        .transpose()?;
    let mut state = lock(shared)?;
    if state.generation != generation {
        return Err("cancellation superseded by a newer request".into());
    }
    state.snapshot = snapshot;
    Ok(response)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            #[cfg(debug_assertions)]
            let config = std::env::var_os("CONTEXTPICK_CONFIG_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(config);
            let settings_path = config.join("settings.json");
            let recovery = Preferences::load_with_recovery(&settings_path);
            let startup_notice = recovery.notice.map(|notice| {
                if recovery.saving_blocked {
                    format!("{notice} Close ContextPick, preserve the original, fix directory permissions and restart to recover.")
                } else {
                    format!("{notice} Open a folder to continue with defaults, or close the app to review the original.")
                }
            });
            app.manage(Arc::new(Mutex::new(Session {
                preferences: recovery.preferences,
                settings_path,
                startup_notice,
                settings_saving_blocked: recovery.saving_blocked,
                ..Default::default()
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            choose_workspace,
            restore_workspace,
            refresh_workspace,
            set_intent,
            set_policy,
            browse_ignored,
            preview_file,
            export_markdown,
            copy_markdown,
            cancel_operation,
            reset_selections,
            workspace_page
        ])
        .run(tauri::generate_context!())
        .expect("ContextPick desktop startup failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn fixture(root: &std::path::Path) -> Workspace {
        std::fs::write(root.join("file.rs"), "fn main() {}\n").unwrap();
        Workspace::scan(
            root,
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    #[test]
    fn stale_scan_cannot_publish_or_persist() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 2,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        assert!(publish(&shared, fixture(root.path()), 1).is_err());
        assert!(lock(&shared).unwrap().workspace.is_none());
        assert!(!config.path().join("settings.json").exists());
    }

    #[test]
    fn failed_save_does_not_commit_candidate_workspace() {
        let original = tempfile::tempdir().unwrap();
        let candidate = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let old = fixture(original.path());
        let expected = old.root.clone();
        std::fs::write(config.path().join("not-a-directory"), "synthetic").unwrap();
        let shared = Arc::new(Mutex::new(Session {
            workspace: Some(old),
            generation: 1,
            settings_path: config.path().join("not-a-directory/settings.json"),
            ..Default::default()
        }));
        assert!(publish(&shared, fixture(candidate.path()), 1).is_err());
        assert_eq!(
            lock(&shared).unwrap().workspace.as_ref().unwrap().root,
            expected
        );
        assert!(lock(&shared).unwrap().preferences.recent_root.is_none());
    }

    #[test]
    fn newer_scan_cancels_previous_generation() {
        let shared = Arc::new(Mutex::new(Session::default()));
        let (first, token) = begin_scan(&shared).unwrap();
        let (second, current) = begin_scan(&shared).unwrap();
        assert!(second > first);
        assert!(token.load(Ordering::Relaxed));
        assert!(!current.load(Ordering::Relaxed));
    }

    #[test]
    fn workspace_pages_require_the_current_published_generation() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        assert!(get_workspace_page(&shared, 1, 0).is_err());
        let first = publish(&shared, fixture(root.path()), 1).unwrap();
        assert_eq!(first.entry_count, 1);
        assert_eq!(get_workspace_page(&shared, 1, 0).unwrap().entries.len(), 1);
        let (next, _) = begin_scan(&shared).unwrap();
        assert!(get_workspace_page(&shared, 1, 0).is_err());
        assert!(get_workspace_page(&shared, next, 0).is_err());
        publish(&shared, fixture(root.path()), next).unwrap();
        assert!(get_workspace_page(&shared, next, usize::MAX).is_err());
        assert_eq!(
            get_workspace_page(&shared, next, 0).unwrap().generation,
            next
        );
    }

    #[test]
    fn cancellation_returns_already_published_root_even_if_original_response_is_in_flight() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        publish(&shared, fixture(first.path()), 1).unwrap();
        let (second_generation, token) = begin_scan(&shared).unwrap();
        let pending_ipc_response =
            publish(&shared, fixture(second.path()), second_generation).unwrap();
        // Cancellation is a view reconciliation, not another preferences write.
        lock(&shared).unwrap().settings_saving_blocked = true;
        let authoritative = cancel_and_snapshot(&shared).unwrap().unwrap();
        assert_eq!(authoritative.view.root, pending_ipc_response.view.root);
        assert!(authoritative.view.generation > pending_ipc_response.view.generation);
        assert!(token.load(Ordering::Relaxed));
        assert!(get_workspace_page(&shared, second_generation, 0).is_err());
        assert!(get_workspace_page(&shared, authoritative.view.generation, 0).is_ok());
        assert_eq!(
            manifest(&shared).unwrap().root.path().display().to_string(),
            authoritative.view.root
        );
    }

    #[test]
    fn cancellation_retains_previous_workspace_when_new_scan_has_not_published() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let original = publish(&shared, fixture(root.path()), 1).unwrap();
        let (pending_generation, token) = begin_scan(&shared).unwrap();
        let authoritative = cancel_and_snapshot(&shared).unwrap().unwrap();
        assert_eq!(authoritative.view.root, original.view.root);
        assert!(authoritative.view.generation > pending_generation);
        assert!(token.load(Ordering::Relaxed));
        assert!(get_workspace_page(&shared, authoritative.view.generation, 0).is_ok());
    }

    #[test]
    fn clipboard_limits_cannot_overflow() {
        let entries = [u64::MAX, 1].map(|size| contextpick_core::ManifestEntry {
            path: "synthetic.ts".into(),
            size,
            modified_ns: 0,
        });
        assert!(clipboard_preflight(&entries, 8 * 1024 * 1024).is_err());
    }

    #[test]
    fn cancellation_does_not_replace_clipboard() {
        let mut called = false;
        assert!(
            write_clipboard(&AtomicBool::new(true), "synthetic".into(), |_| {
                called = true;
                Ok(())
            })
            .is_err()
        );
        assert!(!called);
    }

    #[test]
    fn failed_settings_backup_never_allows_defaults_to_replace_original() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let path = config.path().join("settings.json");
        std::fs::write(&path, "{synthetic corrupt original").unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: path.clone(),
            settings_saving_blocked: true,
            ..Default::default()
        }));
        assert!(publish(&shared, fixture(root.path()), 1).is_err());
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "{synthetic corrupt original"
        );
        assert!(lock(&shared).unwrap().workspace.is_none());
    }

    #[test]
    fn output_reservation_is_persisted_before_any_file_is_created() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            workspace: Some(fixture(root.path())),
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        reserve_output(&shared, 1, "context.md").unwrap();
        let restored = Preferences::load(&config.path().join("settings.json")).unwrap();
        let key = std::fs::canonicalize(root.path())
            .unwrap()
            .display()
            .to_string();
        assert!(
            restored.workspaces[&key]
                .generated_outputs
                .contains("context.md")
        );
        assert!(
            lock(&shared)
                .unwrap()
                .workspace
                .as_ref()
                .unwrap()
                .generated_outputs
                .contains("context.md")
        );
        assert!(!root.path().join("context.md").exists());
    }

    #[test]
    fn stale_or_failed_output_reservation_does_not_mutate_state() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        std::fs::write(config.path().join("not-directory"), "fixture").unwrap();
        let shared = Arc::new(Mutex::new(Session {
            workspace: Some(fixture(root.path())),
            generation: 2,
            settings_path: config.path().join("not-directory/settings.json"),
            ..Default::default()
        }));
        assert!(reserve_output(&shared, 1, "stale.md").is_err());
        assert!(reserve_output(&shared, 2, "failed.md").is_err());
        assert!(
            lock(&shared)
                .unwrap()
                .workspace
                .as_ref()
                .unwrap()
                .generated_outputs
                .is_empty()
        );
        assert!(!root.path().join("failed.md").exists());
    }
}
