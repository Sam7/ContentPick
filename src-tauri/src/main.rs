#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use contextpick_core::{
    content,
    export::{self, ExportResult},
    preferences::{Preferences, SavedWorkspace},
    selection::Intent,
    workspace::{FilterPolicy, Workspace, WorkspaceView},
};
use std::{
    collections::{BTreeMap, BTreeSet},
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
    generation: u64,
    cancel: Arc<AtomicBool>,
    preferences: Preferences,
    settings_path: std::path::PathBuf,
    startup_notice: Option<String>,
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

fn publish(shared: &Shared, workspace: Workspace, generation: u64) -> CommandResult<WorkspaceView> {
    let mut state = lock(shared)?;
    if state.generation != generation {
        return Err("operation superseded by a newer request".into());
    }
    persist_workspace(&mut state, &workspace)?;
    state.workspace = Some(workspace);
    Ok(state
        .workspace
        .as_ref()
        .expect("workspace just assigned")
        .view(generation))
}

fn persist_workspace(state: &mut Session, workspace: &Workspace) -> CommandResult<()> {
    let mut preferences = state.preferences.clone();
    {
        let root = workspace.root.display().to_string();
        preferences.recent_root = Some(root.clone());
        preferences.workspaces.insert(
            root,
            SavedWorkspace {
                policy: workspace.policy.clone(),
                intents: workspace.intents.clone(),
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
async fn restore_workspace(state: State<'_, Shared>) -> CommandResult<Option<WorkspaceView>> {
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
            let saved =
                state
                    .preferences
                    .workspaces
                    .get(&root)
                    .cloned()
                    .unwrap_or(SavedWorkspace {
                        policy: FilterPolicy::default(),
                        intents: BTreeMap::new(),
                    });
            (root, saved, notice)
        };
        let mut workspace = Workspace::scan(
            std::path::Path::new(&root),
            saved.policy,
            saved.intents,
            BTreeSet::new(),
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
) -> CommandResult<Option<WorkspaceView>> {
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
            .unwrap_or(SavedWorkspace {
                policy: FilterPolicy::default(),
                intents: BTreeMap::new(),
            });
        let workspace =
            Workspace::scan(&path, saved.policy, saved.intents, BTreeSet::new(), &cancel)
                .map_err(|e| e.to_string())?;
        publish(&shared, workspace, generation).map(Some)
    })
    .await
}

async fn rescan(
    shared: Shared,
    policy: Option<FilterPolicy>,
    browse: Option<String>,
) -> CommandResult<WorkspaceView> {
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

async fn rescan_candidate(shared: Shared, previous: Workspace) -> CommandResult<WorkspaceView> {
    let (generation, cancel) = begin_scan(&shared)?;
    blocking(move || {
        let workspace = Workspace::scan_pinned(
            previous.root_handle,
            previous.policy,
            previous.intents,
            previous.browsed,
            &cancel,
        )
        .map_err(|e| e.to_string())?;
        publish(&shared, workspace, generation)
    })
    .await
}

#[tauri::command]
async fn refresh_workspace(state: State<'_, Shared>) -> CommandResult<WorkspaceView> {
    rescan(state.inner().clone(), None, None).await
}
#[tauri::command]
async fn set_policy(
    policy: FilterPolicy,
    state: State<'_, Shared>,
) -> CommandResult<WorkspaceView> {
    rescan(state.inner().clone(), Some(policy), None).await
}
#[tauri::command]
async fn browse_ignored(path: String, state: State<'_, Shared>) -> CommandResult<WorkspaceView> {
    rescan(state.inner().clone(), None, Some(path)).await
}

#[tauri::command]
async fn set_intent(
    path: String,
    intent: Option<Intent>,
    state: State<'_, Shared>,
) -> CommandResult<WorkspaceView> {
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
async fn reset_selections(state: State<'_, Shared>) -> CommandResult<WorkspaceView> {
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

fn manifest(
    shared: &Shared,
) -> CommandResult<(
    contextpick_core::WorkspaceRoot,
    Vec<contextpick_core::ManifestEntry>,
    Arc<AtomicBool>,
)> {
    let state = lock(shared)?;
    let workspace = state.workspace.as_ref().ok_or("choose a workspace first")?;
    Ok((
        workspace.root_handle.clone(),
        workspace.manifest(),
        Arc::new(AtomicBool::new(false)),
    ))
}

#[tauri::command]
async fn export_markdown(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
) -> CommandResult<Option<ExportResult>> {
    let shared = state.inner().clone();
    let (root, entries, cancel) = manifest(&shared)?;
    lock(&shared)?.cancel = cancel.clone();
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
        export::export_to(&root, &entries, &destination, overwrite, &cancel)
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
    let (root, entries, cancel) = manifest(&shared)?;
    lock(&shared)?.cancel = cancel.clone();
    blocking(move || {
        const LIMIT: u64 = 8 * 1024 * 1024;
        if entries.iter().map(|e| e.size).sum::<u64>() > LIMIT {
            return Err("selection exceeds 8 MiB clipboard safety limit; export to a file".into());
        }
        let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
        let path = temp.path().join("clipboard.md");
        let mut result =
            export::export_to(&root, &entries, &path, false, &cancel).map_err(|e| e.to_string())?;
        if result.bytes > LIMIT {
            return Err("Markdown exceeds 8 MiB clipboard safety limit; export to a file".into());
        }
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        app.clipboard()
            .write_text(text)
            .map_err(|e| e.to_string())?;
        result.destination = "Clipboard".into();
        Ok(result)
    })
    .await
}

#[tauri::command]
fn cancel_operation(state: State<'_, Shared>) -> CommandResult<()> {
    let mut state = lock(state.inner())?;
    state.cancel.store(true, Ordering::Relaxed);
    state.generation += 1;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let config=app.path().app_config_dir()?;
            #[cfg(debug_assertions)]
            let config=std::env::var_os("CONTEXTPICK_CONFIG_DIR").map(std::path::PathBuf::from).unwrap_or(config);
            let settings_path=config.join("settings.json");
            let (preferences,startup_notice)=match Preferences::load(&settings_path) {
                Ok(preferences)=>(preferences,None),
                Err(error)=>{
                    let backup=config.join(format!("settings-recovery-{}.json",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
                    std::fs::create_dir_all(&config)?;
                    std::fs::copy(&settings_path,&backup)?;
                    (Preferences::default(),Some(format!("{error}. Original settings backed up to {}. Open a folder to recover with defaults.",backup.display())))
                }
            };
            app.manage(Arc::new(Mutex::new(Session { preferences,settings_path,startup_notice,..Default::default() })));
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
            cancel_operation
            ,reset_selections
        ])
        .run(tauri::generate_context!())
        .expect("ContextPick desktop startup failed");
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
