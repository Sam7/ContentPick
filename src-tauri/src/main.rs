#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod paging;
mod watcher;

use contextpick_core::{
    ManifestEntry, WorkspaceRoot, content,
    destination::Destination,
    export::{self, ExportResult},
    preferences::{Preferences, SavedWorkspace},
    selection::Intent,
    sensitive::{SensitiveFileWarning, sensitive_file_warnings},
    token_count::{TokenEstimate, TokenEstimateCache},
    workspace::{FilterPolicy, Workspace, WorkspaceView},
};
use paging::{WorkspacePage, WorkspaceResponse};
use serde::Serialize;
#[cfg(debug_assertions)]
use std::sync::Condvar;
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};
use watcher::{WatchHealth, WatchService};

struct Session {
    workspace: Option<Workspace>,
    snapshot: Option<Arc<WorkspaceView>>,
    generation: u64,
    cancel: Arc<AtomicBool>,
    preferences: Preferences,
    settings_path: std::path::PathBuf,
    startup_notice: Option<String>,
    settings_saving_blocked: bool,
    watch_health: Option<WatchHealth>,
    token_estimate_cache: Arc<TokenEstimateCache>,
    token_estimate_gate: Arc<Semaphore>,
    active_token_estimate: Option<ActiveTokenEstimate>,
    active_output: Option<ActiveOutput>,
    pending_sensitive_output: Option<PendingSensitiveOutput>,
    latest_token_estimate_order: Option<(u64, (u64, u64))>,
}

struct ActiveTokenEstimate {
    request_id: String,
    generation: u64,
    cancel: Arc<AtomicBool>,
    watch_root: String,
    watch_epoch: u64,
    watch_revision: u64,
}

struct ActiveOutput {
    cancel: Arc<AtomicBool>,
    generation: u64,
    root: String,
    watch_epoch: u64,
    watch_revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenEstimateResponse {
    request_id: String,
    generation: u64,
    tokens: u64,
    files: usize,
    reused_files: usize,
    computed_files: usize,
    tokenizer_id: &'static str,
}

struct TokenEstimateWork {
    request_id: String,
    generation: u64,
    root: WorkspaceRoot,
    root_display: String,
    entries: Vec<ManifestEntry>,
    cancel: Arc<AtomicBool>,
    watch_epoch: u64,
    watch_revision: u64,
    cache: Arc<TokenEstimateCache>,
    gate: Arc<Semaphore>,
}

type Shared = Arc<Mutex<Session>>;
type WatchShared = Arc<WatchService>;
type CommandResult<T> = std::result::Result<T, String>;

impl Default for Session {
    fn default() -> Self {
        Self {
            workspace: None,
            snapshot: None,
            generation: 0,
            cancel: Arc::new(AtomicBool::new(false)),
            preferences: Preferences::default(),
            settings_path: std::path::PathBuf::new(),
            startup_notice: None,
            settings_saving_blocked: false,
            watch_health: None,
            token_estimate_cache: Arc::new(TokenEstimateCache::default()),
            token_estimate_gate: Arc::new(Semaphore::new(1)),
            active_token_estimate: None,
            active_output: None,
            pending_sensitive_output: None,
            latest_token_estimate_order: None,
        }
    }
}

#[cfg(debug_assertions)]
#[derive(Default)]
struct CopyBarrier {
    state: Mutex<CopyBarrierState>,
    changed: Condvar,
}

#[cfg(debug_assertions)]
#[derive(Default)]
struct CopyBarrierState {
    armed: bool,
    reached: bool,
    released: bool,
}

#[cfg(debug_assertions)]
impl CopyBarrier {
    fn arm(&self) -> CommandResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "copy test barrier unavailable".to_string())?;
        if state.armed || state.reached {
            return Err("copy test barrier is already armed".into());
        }
        *state = CopyBarrierState {
            armed: true,
            ..Default::default()
        };
        Ok(())
    }

    fn reached(&self) -> CommandResult<bool> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "copy test barrier unavailable".to_string())?
            .reached)
    }

    fn release(&self) -> CommandResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "copy test barrier unavailable".to_string())?;
        state.released = true;
        self.changed.notify_all();
        Ok(())
    }

    fn wait_if_armed(&self) -> CommandResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "copy test barrier unavailable".to_string())?;
        if !state.armed {
            return Ok(());
        }
        state.reached = true;
        self.changed.notify_all();
        let (mut state, timeout) = self
            .changed
            .wait_timeout_while(state, std::time::Duration::from_secs(30), |state| {
                !state.released
            })
            .map_err(|_| "copy test barrier unavailable".to_string())?;
        let released = state.released;
        *state = CopyBarrierState::default();
        if timeout.timed_out() && !released {
            return Err("copy test barrier timed out".into());
        }
        Ok(())
    }
}

fn activate_watcher(service: &WatchService, response: &WorkspaceResponse) {
    let _ = service.activate(
        std::path::Path::new(&response.view.root),
        response.view.generation,
    );
}

fn choose_workspace_at(
    shared: &Shared,
    watcher: &WatchService,
    path: &std::path::Path,
    generation: u64,
    cancel: &AtomicBool,
) -> CommandResult<WorkspaceResponse> {
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let saved = lock(shared)?
        .preferences
        .workspaces
        .get(&canonical.display().to_string())
        .cloned()
        .unwrap_or_default();
    let workspace = Workspace::scan_with_outputs(
        &canonical,
        saved.policy,
        saved.intents,
        BTreeSet::new(),
        saved.generated_outputs,
        cancel,
    )
    .map_err(|e| e.to_string())?;
    let response = publish(shared, workspace, generation)?;
    activate_watcher(watcher, &response);
    Ok(response)
}

fn lock(shared: &Shared) -> CommandResult<std::sync::MutexGuard<'_, Session>> {
    shared
        .lock()
        .map_err(|_| "application state unavailable".into())
}

fn cancel_active_token_estimate(state: &mut Session) {
    if let Some(active) = state.active_token_estimate.take() {
        active.cancel.store(true, Ordering::Relaxed);
    }
}

fn cancel_active_output(state: &mut Session) {
    if let Some(active) = state.active_output.take() {
        active.cancel.store(true, Ordering::Relaxed);
    }
    if let Some(pending) = state.pending_sensitive_output.take() {
        pending.frozen.cancel.store(true, Ordering::Relaxed);
    }
}

fn record_watch_health(state: &mut Session, health: &WatchHealth) {
    if state.watch_health.as_ref().is_some_and(|current| {
        health.epoch < current.epoch
            || (health.epoch == current.epoch
                && (health.root != current.root || health.revision <= current.revision))
    }) {
        return;
    }
    state.watch_health = Some(health.clone());
    if health.state != watcher::WatchState::Watching
        && state.active_token_estimate.as_ref().is_some_and(|active| {
            active.watch_root == health.root
                && active.watch_epoch == health.epoch
                && health.revision > active.watch_revision
        })
    {
        cancel_active_token_estimate(state);
    }
    if health.state != watcher::WatchState::Watching
        && state.active_output.as_ref().is_some_and(|active| {
            active.root == health.root
                && active.watch_epoch == health.epoch
                && health.revision > active.watch_revision
        })
    {
        cancel_active_output(state);
    }
}

fn handle_watch_health(shared: &Shared, health: &WatchHealth) {
    if let Ok(mut state) = shared.lock() {
        record_watch_health(&mut state, health);
    }
}

fn active_token_estimate_is_current(state: &Session, work: &TokenEstimateWork) -> bool {
    !work.cancel.load(Ordering::Relaxed)
        && state.generation == work.generation
        && state
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.generation == work.generation)
        && state.workspace.as_ref().is_some_and(|workspace| {
            workspace.root_handle.same_identity(&work.root)
                && workspace.root.display().to_string() == work.root_display
        })
        && state.active_token_estimate.as_ref().is_some_and(|active| {
            active.generation == work.generation
                && active.request_id == work.request_id
                && Arc::ptr_eq(&active.cancel, &work.cancel)
                && active.watch_root == work.root_display
                && active.watch_epoch == work.watch_epoch
                && active.watch_revision == work.watch_revision
        })
        && state.watch_health.as_ref().is_some_and(|health| {
            health.root == work.root_display
                && health.epoch == work.watch_epoch
                && health.revision == work.watch_revision
                && health.state == watcher::WatchState::Watching
        })
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
    cancel_active_token_estimate(&mut state);
    cancel_active_output(&mut state);
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
        state
            .snapshot
            .clone()
            .filter(|view| view.generation == generation)
            .ok_or("workspace page superseded by a newer published snapshot")?
    };
    let response = paging::page(&snapshot, offset)?;
    if lock(shared)?
        .snapshot
        .as_ref()
        .is_none_or(|current| current.generation != generation)
    {
        return Err("workspace page superseded by a newer published snapshot".into());
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
async fn restore_workspace(
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
) -> CommandResult<Option<WorkspaceResponse>> {
    let shared = state.inner().clone();
    let watcher = watcher.inner().clone();
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
        let result = publish(&shared, workspace, generation).map(Some);
        if let Ok(Some(response)) = &result {
            activate_watcher(&watcher, response);
        }
        result
    })
    .await
}

#[tauri::command]
async fn choose_workspace(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
) -> CommandResult<Option<WorkspaceResponse>> {
    let shared = state.inner().clone();
    let watcher = watcher.inner().clone();
    let (generation, cancel) = begin_scan(&shared)?;
    blocking(move || {
        let Some(path) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        choose_workspace_at(&shared, &watcher, &path, generation, &cancel).map(Some)
    })
    .await
}

#[cfg(debug_assertions)]
#[tauri::command]
async fn debug_choose_workspace(
    path: String,
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
) -> CommandResult<WorkspaceResponse> {
    let shared = state.inner().clone();
    let watcher = watcher.inner().clone();
    let path = std::path::PathBuf::from(path);
    let (generation, cancel) = begin_scan(&shared)?;
    blocking(move || choose_workspace_at(&shared, &watcher, &path, generation, &cancel)).await
}

#[cfg(debug_assertions)]
#[tauri::command]
fn debug_fail_watcher(watcher: State<'_, WatchShared>) -> CommandResult<WatchHealth> {
    watcher
        .inner()
        .fail_for_test()
        .ok_or_else(|| "no active watcher to fail".into())
}

#[cfg(debug_assertions)]
#[tauri::command]
fn debug_arm_copy_barrier(barrier: State<'_, Arc<CopyBarrier>>) -> CommandResult<()> {
    barrier.arm()
}

#[cfg(debug_assertions)]
#[tauri::command]
fn debug_copy_barrier_status(barrier: State<'_, Arc<CopyBarrier>>) -> CommandResult<bool> {
    barrier.reached()
}

#[cfg(debug_assertions)]
#[tauri::command]
fn debug_release_copy_barrier(barrier: State<'_, Arc<CopyBarrier>>) -> CommandResult<()> {
    barrier.release()
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
async fn refresh_workspace(
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
) -> CommandResult<WorkspaceResponse> {
    let checkpoint = watcher.inner().status().and_then(|health| {
        watcher
            .inner()
            .checkpoint(std::path::Path::new(&health.root))
    });
    let response = rescan(state.inner().clone(), None, None).await?;
    let _ = watcher.inner().revalidated(
        std::path::Path::new(&response.view.root),
        response.view.generation,
        checkpoint,
    );
    Ok(response)
}

#[tauri::command]
fn get_watch_status(watcher: State<'_, WatchShared>) -> Option<WatchHealth> {
    watcher.status()
}

#[tauri::command]
fn request_focus_reconcile(root: String, watcher: State<'_, WatchShared>) -> Option<WatchHealth> {
    watcher
        .inner()
        .request_reconcile(std::path::Path::new(&root))
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

fn start_token_estimate(
    shared: &Shared,
    watcher: &WatchService,
    generation: u64,
    request_id: String,
) -> CommandResult<TokenEstimateWork> {
    if request_id.len() > 64 {
        return Err("invalid token estimate request identity".into());
    }
    let order = parse_token_estimate_order(&request_id)
        .ok_or_else(|| "invalid token estimate request identity".to_string())?;
    let health = watcher
        .status()
        .filter(|health| health.state == watcher::WatchState::Watching)
        .ok_or_else(|| {
            "workspace watcher is stale; refresh before estimating tokens".to_string()
        })?;
    let mut state = lock(shared)?;
    if state.generation != generation
        || state
            .snapshot
            .as_ref()
            .is_none_or(|snapshot| snapshot.generation != generation)
    {
        return Err("token estimate superseded by a newer workspace".into());
    }
    if state
        .latest_token_estimate_order
        .is_some_and(|(latest_generation, latest_order)| {
            latest_generation == generation && order <= latest_order
        })
    {
        return Err("token estimate superseded by a newer request".into());
    }
    let (root, root_display, entries) = {
        let workspace = state.workspace.as_ref().ok_or("choose a workspace first")?;
        (
            workspace.root_handle.clone(),
            workspace.root.display().to_string(),
            workspace.manifest(),
        )
    };
    if health.root != root_display {
        return Err("workspace watcher is stale; refresh before estimating tokens".into());
    }
    record_watch_health(&mut state, &health);
    if !state.watch_health.as_ref().is_some_and(|current| {
        current.root == health.root
            && current.epoch == health.epoch
            && current.revision == health.revision
            && current.state == watcher::WatchState::Watching
    }) {
        return Err("workspace watcher is stale; refresh before estimating tokens".into());
    }
    cancel_active_token_estimate(&mut state);
    state.latest_token_estimate_order = Some((generation, order));
    let cancel = Arc::new(AtomicBool::new(false));
    state.active_token_estimate = Some(ActiveTokenEstimate {
        request_id: request_id.clone(),
        generation,
        cancel: cancel.clone(),
        watch_root: health.root.clone(),
        watch_epoch: health.epoch,
        watch_revision: health.revision,
    });
    Ok(TokenEstimateWork {
        request_id,
        generation,
        root,
        root_display,
        entries,
        cancel,
        watch_epoch: health.epoch,
        watch_revision: health.revision,
        cache: state.token_estimate_cache.clone(),
        gate: state.token_estimate_gate.clone(),
    })
}

fn parse_token_estimate_order(request_id: &str) -> Option<(u64, u64)> {
    let (timestamp, sequence) = request_id.split_once(':')?;
    Some((timestamp.parse().ok()?, sequence.parse().ok()?))
}

fn watcher_is_current(watcher: &WatchService, work: &TokenEstimateWork) -> bool {
    watcher.status().is_some_and(|health| {
        health.root == work.root_display
            && health.epoch == work.watch_epoch
            && health.revision == work.watch_revision
            && health.state == watcher::WatchState::Watching
    })
}

fn cancel_token_estimate_for_request(shared: &Shared, generation: u64, request_id: &str) {
    let Ok(mut state) = shared.lock() else {
        return;
    };
    if state
        .active_token_estimate
        .as_ref()
        .is_some_and(|active| active.generation == generation && active.request_id == request_id)
    {
        cancel_active_token_estimate(&mut state);
    }
}

fn clear_token_estimate_if_current(shared: &Shared, work: &TokenEstimateWork) {
    let Ok(mut state) = shared.lock() else {
        return;
    };
    if state.active_token_estimate.as_ref().is_some_and(|active| {
        active.generation == work.generation
            && active.request_id == work.request_id
            && Arc::ptr_eq(&active.cancel, &work.cancel)
    }) {
        state.active_token_estimate = None;
    }
}

fn complete_token_estimate(
    shared: &Shared,
    watcher: &WatchService,
    work: TokenEstimateWork,
    _permit: OwnedSemaphorePermit,
) -> CommandResult<TokenEstimateResponse> {
    let estimate = if work.cancel.load(Ordering::Relaxed) {
        Err("token estimate cancelled".to_string())
    } else {
        work.cache
            .estimate_selected(&work.root, &work.entries, &work.cancel)
            .map_err(|error| error.to_string())
    };
    let estimate = match estimate {
        Ok(estimate) => estimate,
        Err(error) => {
            clear_token_estimate_if_current(shared, &work);
            return Err(error);
        }
    };
    let watcher_current = watcher_is_current(watcher, &work);
    let mut state = lock(shared)?;
    if watcher_current && active_token_estimate_is_current(&state, &work) {
        state.active_token_estimate = None;
        return Ok(token_estimate_response(&work, estimate));
    }
    if state.active_token_estimate.as_ref().is_some_and(|active| {
        active.generation == work.generation && active.request_id == work.request_id
    }) {
        cancel_active_token_estimate(&mut state);
    }
    if !watcher_current {
        Err("workspace watcher is stale; refresh before estimating tokens".into())
    } else {
        Err("token estimate superseded by a newer workspace".into())
    }
}

fn token_estimate_response(
    work: &TokenEstimateWork,
    estimate: TokenEstimate,
) -> TokenEstimateResponse {
    TokenEstimateResponse {
        request_id: work.request_id.clone(),
        generation: work.generation,
        tokens: estimate.tokens,
        files: estimate.files,
        reused_files: estimate.reused_files,
        computed_files: estimate.computed_files,
        tokenizer_id: estimate.tokenizer_id,
    }
}

#[tauri::command]
async fn estimate_tokens(
    generation: u64,
    request_id: String,
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
) -> CommandResult<TokenEstimateResponse> {
    let shared = state.inner().clone();
    let watcher = watcher.inner().clone();
    let work = start_token_estimate(&shared, &watcher, generation, request_id)?;
    if !watcher_is_current(&watcher, &work) {
        cancel_token_estimate_for_request(&shared, generation, &work.request_id);
        return Err("workspace watcher is stale; refresh before estimating tokens".into());
    }
    let permit = loop {
        if work.cancel.load(Ordering::Relaxed) {
            return Err("token estimate cancelled".into());
        }
        match work.gate.clone().try_acquire_owned() {
            Ok(permit) => break permit,
            Err(TryAcquireError::NoPermits) => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(TryAcquireError::Closed) => {
                return Err("token estimate worker unavailable".into());
            }
        }
    };
    blocking(move || complete_token_estimate(&shared, &watcher, work, permit)).await
}

#[tauri::command]
fn cancel_token_estimate(
    generation: u64,
    request_id: String,
    state: State<'_, Shared>,
) -> CommandResult<()> {
    let mut state = lock(state.inner())?;
    if state
        .active_token_estimate
        .as_ref()
        .is_some_and(|active| active.generation == generation && active.request_id == request_id)
    {
        cancel_active_token_estimate(&mut state);
    }
    Ok(())
}

struct FrozenExport {
    root: contextpick_core::WorkspaceRoot,
    entries: Vec<contextpick_core::ManifestEntry>,
    cancel: Arc<AtomicBool>,
    generation: u64,
    root_display: String,
    watch_epoch: u64,
    watch_revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputKind {
    Copy,
    Export,
}

struct PendingSensitiveOutput {
    ticket: String,
    expires_at: Instant,
    kind: OutputKind,
    frozen: FrozenExport,
}

const MAX_WARNING_PATHS: usize = 100;
const MAX_WARNING_SUMMARY_BYTES: usize = 192 * 1024;
const SENSITIVE_CONFIRMATION_TTL: Duration = Duration::from_secs(120);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SensitiveWarningSummary {
    total: usize,
    omitted: usize,
    warnings: Vec<SensitiveFileWarning>,
}

enum OutputStart {
    Ready(FrozenExport),
    ConfirmationRequired {
        ticket: String,
        summary: SensitiveWarningSummary,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
enum OutputResponse {
    Completed(Option<ExportResult>),
    ConfirmationRequired {
        #[serde(rename = "confirmationRequired")]
        confirmation_required: bool,
        ticket: String,
        summary: SensitiveWarningSummary,
    },
}

fn bounded_warning_summary(
    warnings: Vec<SensitiveFileWarning>,
) -> CommandResult<SensitiveWarningSummary> {
    let total = warnings.len();
    let mut shown = Vec::with_capacity(total.min(MAX_WARNING_PATHS));
    let mut bytes: usize = 2; // JSON array brackets.
    for warning in warnings.into_iter().take(MAX_WARNING_PATHS) {
        let entry_bytes = serde_json::to_vec(&warning)
            .map_err(|error| format!("could not format sensitive-file warning: {error}"))?
            .len();
        let cost = entry_bytes.saturating_add(usize::from(!shown.is_empty()));
        if bytes.saturating_add(cost) > MAX_WARNING_SUMMARY_BYTES {
            break;
        }
        bytes += cost;
        shown.push(warning);
    }
    let omitted = total - shown.len();
    Ok(SensitiveWarningSummary {
        total,
        omitted,
        warnings: shown,
    })
}

fn manifest(shared: &Shared, watcher: &WatchService) -> CommandResult<FrozenExport> {
    let health = watcher
        .status()
        .filter(|health| health.state == watcher::WatchState::Watching)
        .ok_or_else(|| "workspace watcher is stale; refresh before exporting".to_string())?;
    let mut state = lock(shared)?;
    if state
        .snapshot
        .as_ref()
        .is_none_or(|snapshot| snapshot.generation != state.generation)
    {
        return Err("workspace is still refreshing; wait before exporting".into());
    }
    let (root, root_display, entries) = {
        let workspace = state.workspace.as_ref().ok_or("choose a workspace first")?;
        (
            workspace.root_handle.clone(),
            workspace.root.display().to_string(),
            workspace.manifest(),
        )
    };
    if health.root != root_display {
        return Err("workspace watcher is stale; refresh before exporting".into());
    }
    record_watch_health(&mut state, &health);
    if !state.watch_health.as_ref().is_some_and(|current| {
        current.root == health.root
            && current.epoch == health.epoch
            && current.revision == health.revision
            && current.state == watcher::WatchState::Watching
    }) {
        return Err("workspace watcher is stale; refresh before exporting".into());
    }
    cancel_active_output(&mut state);
    state.cancel.store(true, Ordering::Relaxed);
    state.cancel = Arc::new(AtomicBool::new(false));
    let cancel = state.cancel.clone();
    let frozen = FrozenExport {
        root,
        entries,
        cancel: cancel.clone(),
        generation: state.generation,
        root_display: root_display.clone(),
        watch_epoch: health.epoch,
        watch_revision: health.revision,
    };
    state.active_output = Some(ActiveOutput {
        cancel,
        generation: frozen.generation,
        root: frozen.root_display.clone(),
        watch_epoch: frozen.watch_epoch,
        watch_revision: frozen.watch_revision,
    });
    drop(state);
    if !output_is_current(shared, watcher, &frozen) {
        clear_active_output(shared, &frozen.cancel);
        frozen.cancel.store(true, Ordering::Relaxed);
        return Err("workspace watcher is stale; refresh before exporting".into());
    }
    Ok(frozen)
}

fn start_output(
    shared: &Shared,
    watcher: &WatchService,
    kind: OutputKind,
) -> CommandResult<OutputStart> {
    let frozen = manifest(shared, watcher)?;
    let warnings = match sensitive_file_warnings(&frozen.entries) {
        Ok(warnings) => warnings,
        Err(error) => {
            frozen.cancel.store(true, Ordering::Relaxed);
            clear_active_output(shared, &frozen.cancel);
            return Err(error.to_string());
        }
    };
    if warnings.is_empty() {
        return Ok(OutputStart::Ready(frozen));
    }

    let summary = match bounded_warning_summary(warnings) {
        Ok(summary) => summary,
        Err(error) => {
            frozen.cancel.store(true, Ordering::Relaxed);
            clear_active_output(shared, &frozen.cancel);
            return Err(error);
        }
    };
    let ticket = uuid::Uuid::new_v4().to_string();
    let Some(health) = watcher.status() else {
        frozen.cancel.store(true, Ordering::Relaxed);
        clear_active_output(shared, &frozen.cancel);
        return Err("workspace watcher is stale; refresh before confirming output".into());
    };
    let mut state = lock(shared)?;
    if !output_is_current_with_health(&state, &health, &frozen) {
        drop(state);
        frozen.cancel.store(true, Ordering::Relaxed);
        clear_active_output(shared, &frozen.cancel);
        return Err(
            "workspace changed before sensitive-file confirmation; refresh and try again".into(),
        );
    }
    state.pending_sensitive_output = Some(PendingSensitiveOutput {
        ticket: ticket.clone(),
        expires_at: Instant::now() + SENSITIVE_CONFIRMATION_TTL,
        kind,
        frozen,
    });
    Ok(OutputStart::ConfirmationRequired { ticket, summary })
}

fn take_sensitive_output_confirmation(
    shared: &Shared,
    watcher: &WatchService,
    ticket: &str,
) -> CommandResult<PendingSensitiveOutput> {
    let pending = {
        let mut state = lock(shared)?;
        if !state
            .pending_sensitive_output
            .as_ref()
            .is_some_and(|pending| pending.ticket == ticket)
        {
            return Err(
                "sensitive-file confirmation expired or was superseded; review and try again"
                    .into(),
            );
        }
        if state
            .pending_sensitive_output
            .as_ref()
            .is_some_and(|pending| pending.expires_at <= Instant::now())
        {
            cancel_active_output(&mut state);
            return Err("sensitive-file confirmation expired; review and try again".into());
        }
        state.pending_sensitive_output.take().unwrap()
    };

    if !output_is_current(shared, watcher, &pending.frozen) {
        pending.frozen.cancel.store(true, Ordering::Relaxed);
        clear_active_output(shared, &pending.frozen.cancel);
        return Err(
            "workspace changed while confirmation was open; refresh and review the files again"
                .into(),
        );
    }
    if export::validate_manifest(&pending.frozen.root, &pending.frozen.entries).is_err() {
        pending.frozen.cancel.store(true, Ordering::Relaxed);
        clear_active_output(shared, &pending.frozen.cancel);
        return Err(
            "a selected file changed while confirmation was open; refresh and confirm again".into(),
        );
    }
    Ok(pending)
}

fn cancel_sensitive_output_ticket(shared: &Shared, ticket: &str) -> CommandResult<bool> {
    let mut state = lock(shared)?;
    if !state
        .pending_sensitive_output
        .as_ref()
        .is_some_and(|pending| pending.ticket == ticket)
    {
        return Ok(false);
    }
    let pending = state.pending_sensitive_output.take().unwrap();
    pending.frozen.cancel.store(true, Ordering::Relaxed);
    if state
        .active_output
        .as_ref()
        .is_some_and(|active| Arc::ptr_eq(&active.cancel, &pending.frozen.cancel))
    {
        state.active_output = None;
    }
    Ok(true)
}

fn output_watch_matches(watcher: &WatchService, root: &str, epoch: u64, revision: u64) -> bool {
    watcher.status().is_some_and(|health| {
        health.root == root
            && health.epoch == epoch
            && health.revision == revision
            && health.state == watcher::WatchState::Watching
    })
}

fn output_error_after_watch_change(
    watcher: &WatchService,
    expected_watch: &(String, u64, u64),
    error: String,
) -> String {
    if error.contains("file changed since manifest") {
        "a selected file changed during output; refresh and start again, then review the warning if shown".into()
    } else if !output_watch_matches(
        watcher,
        &expected_watch.0,
        expected_watch.1,
        expected_watch.2,
    ) && (error == "export cancelled" || error == "copy cancelled")
    {
        "workspace changed while exporting; refresh before trying again".into()
    } else {
        error
    }
}

fn output_is_current(shared: &Shared, watcher: &WatchService, frozen: &FrozenExport) -> bool {
    let Some(health) = watcher.status() else {
        return false;
    };
    let Ok(state) = shared.lock() else {
        return false;
    };
    output_is_current_with_health(&state, &health, frozen)
}

fn output_is_current_with_health(
    state: &Session,
    health: &WatchHealth,
    frozen: &FrozenExport,
) -> bool {
    health.root == frozen.root_display
        && health.epoch == frozen.watch_epoch
        && health.revision == frozen.watch_revision
        && health.state == watcher::WatchState::Watching
        && !frozen.cancel.load(Ordering::Relaxed)
        && state.generation == frozen.generation
        && state.workspace.as_ref().is_some_and(|workspace| {
            workspace.root_handle.same_identity(&frozen.root)
                && workspace.root.display().to_string() == frozen.root_display
        })
        && state.watch_health.as_ref().is_some_and(|current| {
            current.root == health.root
                && current.epoch == health.epoch
                && current.revision == health.revision
                && current.state == watcher::WatchState::Watching
        })
        && state.active_output.as_ref().is_some_and(|active| {
            active.generation == frozen.generation
                && active.root == frozen.root_display
                && active.watch_epoch == frozen.watch_epoch
                && active.watch_revision == frozen.watch_revision
                && Arc::ptr_eq(&active.cancel, &frozen.cancel)
        })
}

fn clear_active_output(shared: &Shared, cancel: &Arc<AtomicBool>) {
    if let Ok(mut state) = shared.lock()
        && state
            .active_output
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(&active.cancel, cancel))
    {
        state.active_output = None;
        if state
            .pending_sensitive_output
            .as_ref()
            .is_some_and(|pending| Arc::ptr_eq(&pending.frozen.cancel, cancel))
        {
            state.pending_sensitive_output = None;
        }
    }
}

fn reserve_output(
    shared: &Shared,
    watcher: &WatchService,
    frozen: &FrozenExport,
    path: &str,
) -> CommandResult<()> {
    let mut state = lock(shared)?;
    let health = watcher.status();
    if !health.is_some_and(|health| {
        health.root == frozen.root_display
            && health.epoch == frozen.watch_epoch
            && health.revision == frozen.watch_revision
            && health.state == watcher::WatchState::Watching
    }) || !state.watch_health.as_ref().is_some_and(|health| {
        health.root == frozen.root_display
            && health.epoch == frozen.watch_epoch
            && health.revision == frozen.watch_revision
            && health.state == watcher::WatchState::Watching
    }) {
        return Err("workspace watcher is stale; refresh before exporting".into());
    }
    if frozen.cancel.load(Ordering::Relaxed)
        || frozen.generation != state.generation
        || state.active_output.as_ref().is_none_or(|active| {
            active.generation != frozen.generation
                || active.root != frozen.root_display
                || active.watch_epoch != frozen.watch_epoch
                || active.watch_revision != frozen.watch_revision
                || !Arc::ptr_eq(&active.cancel, &frozen.cancel)
        })
    {
        return Err("export cancelled or superseded by a newer request".into());
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
    watcher: State<'_, WatchShared>,
) -> CommandResult<OutputResponse> {
    let shared = state.inner().clone();
    let watcher = watcher.inner().clone();
    match start_output(&shared, &watcher, OutputKind::Export)? {
        OutputStart::ConfirmationRequired { ticket, summary } => {
            Ok(OutputResponse::ConfirmationRequired {
                confirmation_required: true,
                ticket,
                summary,
            })
        }
        OutputStart::Ready(frozen) => run_export_frozen(app, shared, watcher, frozen)
            .await
            .map(OutputResponse::Completed),
    }
}

async fn run_export_frozen(
    app: tauri::AppHandle,
    shared: Shared,
    watcher: WatchShared,
    frozen: FrozenExport,
) -> CommandResult<Option<ExportResult>> {
    let cleanup_shared = Arc::clone(&shared);
    let cleanup_cancel = Arc::clone(&frozen.cancel);
    let outcome_watch = (
        frozen.root_display.clone(),
        frozen.watch_epoch,
        frozen.watch_revision,
    );
    let outcome_watcher = Arc::clone(&watcher);
    let result = blocking(move || {
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
        let prepared = Destination::prepare(&frozen.root, &destination, overwrite)
            .map_err(|e| e.to_string())?;
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
        if !output_is_current(&shared, &watcher, &frozen) {
            return Err("workspace watcher is stale; refresh before exporting".into());
        }
        export::validate_manifest(&frozen.root, &frozen.entries).map_err(|_| {
            "a selected file changed; refresh and start the output operation again".to_string()
        })?;
        if let Some(path) = prepared.relative_path() {
            reserve_output(&shared, &watcher, &frozen, path)?;
        }
        if !output_is_current(&shared, &watcher, &frozen) {
            return Err("workspace watcher is stale; refresh before exporting".into());
        }
        export::export_prepared(&frozen.root, &frozen.entries, prepared, &frozen.cancel)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await;
    let result = result
        .map_err(|error| output_error_after_watch_change(&outcome_watcher, &outcome_watch, error));
    clear_active_output(&cleanup_shared, &cleanup_cancel);
    result
}

#[cfg(debug_assertions)]
#[tauri::command]
async fn copy_markdown(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
    barrier: State<'_, Arc<CopyBarrier>>,
) -> CommandResult<OutputResponse> {
    copy_markdown_impl(
        app,
        state.inner().clone(),
        watcher.inner().clone(),
        barrier.inner().clone(),
    )
    .await
}

#[cfg(not(debug_assertions))]
#[tauri::command]
async fn copy_markdown(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
) -> CommandResult<OutputResponse> {
    copy_markdown_impl(app, state.inner().clone(), watcher.inner().clone()).await
}

async fn copy_markdown_impl(
    app: tauri::AppHandle,
    shared: Shared,
    watcher: WatchShared,
    #[cfg(debug_assertions)] copy_barrier: Arc<CopyBarrier>,
) -> CommandResult<OutputResponse> {
    match start_output(&shared, &watcher, OutputKind::Copy)? {
        OutputStart::ConfirmationRequired { ticket, summary } => {
            Ok(OutputResponse::ConfirmationRequired {
                confirmation_required: true,
                ticket,
                summary,
            })
        }
        OutputStart::Ready(frozen) => run_copy_frozen(
            app,
            shared,
            watcher,
            frozen,
            #[cfg(debug_assertions)]
            copy_barrier,
        )
        .await
        .map(|result| OutputResponse::Completed(Some(result))),
    }
}

async fn run_copy_frozen(
    app: tauri::AppHandle,
    shared: Shared,
    watcher: WatchShared,
    frozen: FrozenExport,
    #[cfg(debug_assertions)] copy_barrier: Arc<CopyBarrier>,
) -> CommandResult<ExportResult> {
    let cleanup_shared = Arc::clone(&shared);
    let cleanup_cancel = Arc::clone(&frozen.cancel);
    let outcome_watch = (
        frozen.root_display.clone(),
        frozen.watch_epoch,
        frozen.watch_revision,
    );
    let outcome_watcher = Arc::clone(&watcher);
    let result = blocking(move || {
        const LIMIT: u64 = 8 * 1024 * 1024;
        clipboard_preflight(&frozen.entries, LIMIT)?;
        export::validate_manifest(&frozen.root, &frozen.entries).map_err(|_| {
            "a selected file changed; refresh and start the output operation again".to_string()
        })?;
        #[cfg(debug_assertions)]
        copy_barrier.wait_if_armed()?;
        let temp = tempfile::Builder::new()
            .prefix(contextpick_core::destination::TEMP_PREFIX)
            .tempdir()
            .map_err(|e| e.to_string())?;
        let path = temp.path().join("clipboard.md");
        let mut result =
            export::export_to(&frozen.root, &frozen.entries, &path, false, &frozen.cancel)
                .map_err(|e| e.to_string())?;
        if result.bytes > LIMIT {
            return Err("Markdown exceeds 8 MiB clipboard safety limit; export to a file".into());
        }
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        if !output_is_current(&shared, &watcher, &frozen) {
            return Err("workspace watcher is stale; refresh before copying".into());
        }
        write_clipboard(&frozen.cancel, text, |text| {
            app.clipboard().write_text(text).map_err(|e| e.to_string())
        })?;
        result.destination = "Clipboard".into();
        Ok(result)
    })
    .await;
    let result = result
        .map_err(|error| output_error_after_watch_change(&outcome_watcher, &outcome_watch, error));
    clear_active_output(&cleanup_shared, &cleanup_cancel);
    result
}

#[cfg(debug_assertions)]
#[tauri::command]
async fn confirm_sensitive_output(
    app: tauri::AppHandle,
    ticket: String,
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
    barrier: State<'_, Arc<CopyBarrier>>,
) -> CommandResult<Option<ExportResult>> {
    confirm_sensitive_output_impl(
        app,
        state.inner().clone(),
        watcher.inner().clone(),
        ticket,
        barrier.inner().clone(),
    )
    .await
}

#[cfg(not(debug_assertions))]
#[tauri::command]
async fn confirm_sensitive_output(
    app: tauri::AppHandle,
    ticket: String,
    state: State<'_, Shared>,
    watcher: State<'_, WatchShared>,
) -> CommandResult<Option<ExportResult>> {
    confirm_sensitive_output_impl(app, state.inner().clone(), watcher.inner().clone(), ticket).await
}

async fn confirm_sensitive_output_impl(
    app: tauri::AppHandle,
    shared: Shared,
    watcher: WatchShared,
    ticket: String,
    #[cfg(debug_assertions)] copy_barrier: Arc<CopyBarrier>,
) -> CommandResult<Option<ExportResult>> {
    let pending = take_sensitive_output_confirmation(&shared, &watcher, &ticket)?;
    match pending.kind {
        OutputKind::Export => run_export_frozen(app, shared, watcher, pending.frozen).await,
        OutputKind::Copy => run_copy_frozen(
            app,
            shared,
            watcher,
            pending.frozen,
            #[cfg(debug_assertions)]
            copy_barrier,
        )
        .await
        .map(Some),
    }
}

#[tauri::command]
fn cancel_sensitive_output(ticket: String, state: State<'_, Shared>) -> CommandResult<bool> {
    cancel_sensitive_output_ticket(state.inner(), &ticket)
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
        cancel_active_token_estimate(&mut state);
        cancel_active_output(&mut state);
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
    let builder = tauri::Builder::default()
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
            let app_handle = app.handle().clone();
            let session = app.state::<Shared>().inner().clone();
            app.manage(Arc::new(WatchService::new(move |health| {
                handle_watch_health(&session, &health);
                let _ = app_handle.emit("watch-status", health);
            })));
            #[cfg(debug_assertions)]
            app.manage(Arc::new(CopyBarrier::default()));
            Ok(())
        });

    let builder = builder.on_window_event(|window, event| {
        if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(true)) {
            let _ = window.emit("window-focus", ());
        }
    });

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        choose_workspace,
        restore_workspace,
        refresh_workspace,
        get_watch_status,
        request_focus_reconcile,
        set_intent,
        set_policy,
        browse_ignored,
        preview_file,
        estimate_tokens,
        cancel_token_estimate,
        export_markdown,
        copy_markdown,
        confirm_sensitive_output,
        cancel_sensitive_output,
        cancel_operation,
        reset_selections,
        workspace_page,
        debug_choose_workspace,
        debug_fail_watcher,
        debug_arm_copy_barrier,
        debug_copy_barrier_status,
        debug_release_copy_barrier
    ]);

    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        choose_workspace,
        restore_workspace,
        refresh_workspace,
        get_watch_status,
        request_focus_reconcile,
        set_intent,
        set_policy,
        browse_ignored,
        preview_file,
        estimate_tokens,
        cancel_token_estimate,
        export_markdown,
        copy_markdown,
        confirm_sensitive_output,
        cancel_sensitive_output,
        cancel_operation,
        reset_selections,
        workspace_page
    ]);

    builder
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

    fn sensitive_fixture(root: &std::path::Path, count: usize) -> Workspace {
        std::fs::write(root.join("file.rs"), "fn main() {}\n").unwrap();
        for index in 0..count {
            std::fs::write(root.join(format!(".env.{index}")), "SYNTHETIC=value\n").unwrap();
        }
        Workspace::scan(
            root,
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    fn publish_watching_fixture(
        shared: &Shared,
        root: &std::path::Path,
        generation: u64,
    ) -> (WorkspaceResponse, WatchService) {
        let response = publish(shared, fixture(root), generation).unwrap();
        let health_shared = Arc::clone(shared);
        let watcher = WatchService::new(move |health| handle_watch_health(&health_shared, &health));
        watcher.activate(std::path::Path::new(&response.view.root), generation);
        (response, watcher)
    }

    fn publish_watching_sensitive_fixture(
        shared: &Shared,
        root: &std::path::Path,
        generation: u64,
        warning_count: usize,
    ) -> (WorkspaceResponse, WatchService) {
        let response = publish(shared, sensitive_fixture(root, warning_count), generation).unwrap();
        let health_shared = Arc::clone(shared);
        let watcher = WatchService::new(move |health| handle_watch_health(&health_shared, &health));
        watcher.activate(std::path::Path::new(&response.view.root), generation);
        (response, watcher)
    }

    #[test]
    fn sensitive_output_keeps_the_frozen_manifest_behind_an_operation_bound_ticket() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 1);

        let OutputStart::ConfirmationRequired { ticket, summary } =
            start_output(&shared, &watcher, OutputKind::Copy).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        assert_eq!(summary.total, 1);
        assert_eq!(summary.omitted, 0);
        assert_eq!(summary.warnings.len(), 1);
        assert_eq!(summary.warnings[0].path, ".env.0");
        assert!(ticket.len() >= 32);

        let confirmed = take_sensitive_output_confirmation(&shared, &watcher, &ticket).unwrap();
        assert_eq!(confirmed.kind, OutputKind::Copy);
        assert!(
            confirmed
                .frozen
                .entries
                .iter()
                .any(|entry| entry.path == ".env.0")
        );
        assert!(output_is_current(&shared, &watcher, &confirmed.frozen));
    }

    #[test]
    fn warning_confirmation_payload_is_bounded_and_discloses_omissions() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 105);

        let OutputStart::ConfirmationRequired { ticket, summary } =
            start_output(&shared, &watcher, OutputKind::Export).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        assert_eq!(summary.total, 105);
        assert_eq!(summary.warnings.len(), 100);
        assert_eq!(summary.omitted, 5);
        assert!(ticket.len() >= 32);
    }

    #[test]
    fn warning_summary_respects_serialized_byte_budget_for_long_paths() {
        let warnings = (0..105)
            .map(|index| SensitiveFileWarning {
                path: format!("nested/{}/{index}.env", "a".repeat(3_000)),
                category: contextpick_core::sensitive::SensitiveFileCategory::EnvironmentFile,
            })
            .collect();

        let summary = bounded_warning_summary(warnings).unwrap();
        assert_eq!(summary.total, 105);
        assert_eq!(summary.omitted, summary.total - summary.warnings.len());
        assert!(summary.warnings.len() < MAX_WARNING_PATHS);
        assert!(serde_json::to_vec(&summary).unwrap().len() <= MAX_WARNING_SUMMARY_BYTES);

        let response = OutputResponse::ConfirmationRequired {
            confirmation_required: true,
            ticket: "opaque-ticket".into(),
            summary,
        };
        assert!(serde_json::to_vec(&response).unwrap().len() <= paging::PAGE_BYTE_LIMIT);
    }

    #[test]
    fn confirmation_response_uses_the_frontend_camel_case_contract() {
        let response = OutputResponse::ConfirmationRequired {
            confirmation_required: true,
            ticket: "opaque-ticket".into(),
            summary: bounded_warning_summary(vec![SensitiveFileWarning {
                path: ".env".into(),
                category: contextpick_core::sensitive::SensitiveFileCategory::EnvironmentFile,
            }])
            .unwrap(),
        };
        let json = serde_json::to_value(response).unwrap();

        assert_eq!(
            json.get("confirmationRequired"),
            Some(&serde_json::Value::Bool(true))
        );
        assert!(json.get("confirmation_required").is_none());
        assert_eq!(json["summary"]["warnings"][0]["path"], ".env");
    }

    #[test]
    fn wrong_or_delayed_cancel_cannot_cancel_a_newer_pending_output() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 1);

        let OutputStart::ConfirmationRequired { ticket: old, .. } =
            start_output(&shared, &watcher, OutputKind::Copy).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        let OutputStart::ConfirmationRequired {
            ticket: current, ..
        } = start_output(&shared, &watcher, OutputKind::Export).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        assert_ne!(old, current);
        assert!(!cancel_sensitive_output_ticket(&shared, &old).unwrap());

        let state = lock(&shared).unwrap();
        let pending = state.pending_sensitive_output.as_ref().unwrap();
        assert_eq!(pending.ticket, current);
        assert_eq!(pending.kind, OutputKind::Export);
        assert!(!pending.frozen.cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn cancel_sensitive_output_clears_only_its_ticket_without_persisting_or_publishing() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 1);
        let before = std::fs::read(config.path().join("settings.json")).unwrap();

        let OutputStart::ConfirmationRequired { ticket, .. } =
            start_output(&shared, &watcher, OutputKind::Export).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        let cancel = lock(&shared)
            .unwrap()
            .pending_sensitive_output
            .as_ref()
            .unwrap()
            .frozen
            .cancel
            .clone();

        assert!(cancel_sensitive_output_ticket(&shared, &ticket).unwrap());
        assert!(!cancel_sensitive_output_ticket(&shared, &ticket).unwrap());
        assert!(cancel.load(Ordering::Relaxed));
        assert!(lock(&shared).unwrap().active_output.is_none());
        assert!(lock(&shared).unwrap().pending_sensitive_output.is_none());
        assert_eq!(
            std::fs::read(config.path().join("settings.json")).unwrap(),
            before
        );
        assert!(!root.path().join("context.md").exists());
    }

    #[test]
    fn source_changed_while_prompted_invalidates_confirmation_before_output_side_effects() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 1);
        let before = std::fs::read(config.path().join("settings.json")).unwrap();

        let OutputStart::ConfirmationRequired { ticket, .. } =
            start_output(&shared, &watcher, OutputKind::Export).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        std::fs::write(root.path().join(".env.0"), "SYNTHETIC=changed-value\n").unwrap();

        assert!(take_sensitive_output_confirmation(&shared, &watcher, &ticket).is_err());
        assert!(lock(&shared).unwrap().active_output.is_none());
        assert!(lock(&shared).unwrap().pending_sensitive_output.is_none());
        assert_eq!(
            std::fs::read(config.path().join("settings.json")).unwrap(),
            before
        );
        assert!(!root.path().join("context.md").exists());
    }

    #[test]
    fn deleted_source_while_prompted_invalidates_confirmation_before_output_side_effects() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 1);
        let before = std::fs::read(config.path().join("settings.json")).unwrap();

        let OutputStart::ConfirmationRequired { ticket, .. } =
            start_output(&shared, &watcher, OutputKind::Export).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        std::fs::remove_file(root.path().join(".env.0")).unwrap();

        assert!(take_sensitive_output_confirmation(&shared, &watcher, &ticket).is_err());
        assert!(lock(&shared).unwrap().active_output.is_none());
        assert!(lock(&shared).unwrap().pending_sensitive_output.is_none());
        assert_eq!(
            std::fs::read(config.path().join("settings.json")).unwrap(),
            before
        );
        assert!(!root.path().join("context.md").exists());
    }

    #[test]
    fn expired_ticket_is_consumed_and_unknown_ticket_does_not_affect_current_output() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 1);
        let OutputStart::ConfirmationRequired { ticket, .. } =
            start_output(&shared, &watcher, OutputKind::Copy).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        assert!(take_sensitive_output_confirmation(&shared, &watcher, "unknown-ticket").is_err());
        assert_eq!(
            lock(&shared)
                .unwrap()
                .pending_sensitive_output
                .as_ref()
                .unwrap()
                .ticket,
            ticket
        );

        lock(&shared)
            .unwrap()
            .pending_sensitive_output
            .as_mut()
            .unwrap()
            .expires_at = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let result = take_sensitive_output_confirmation(&shared, &watcher, &ticket);
        assert!(result.is_err_and(|error| error.contains("expired")));
        assert!(lock(&shared).unwrap().pending_sensitive_output.is_none());
        assert!(lock(&shared).unwrap().active_output.is_none());
    }

    #[test]
    fn concurrent_confirmation_consumes_a_ticket_exactly_once() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 1);
        let watcher = Arc::new(watcher);
        let OutputStart::ConfirmationRequired { ticket, .. } =
            start_output(&shared, &watcher, OutputKind::Copy).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };

        let gate = Arc::new(std::sync::Barrier::new(3));
        let confirmers = (0..2)
            .map(|_| {
                let shared = Arc::clone(&shared);
                let watcher = Arc::clone(&watcher);
                let gate = Arc::clone(&gate);
                let ticket = ticket.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    take_sensitive_output_confirmation(&shared, &watcher, &ticket).is_ok()
                })
            })
            .collect::<Vec<_>>();
        gate.wait();

        let successes = confirmers
            .into_iter()
            .map(|confirmer| confirmer.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successes, 1);
        let state = lock(&shared).unwrap();
        assert!(state.pending_sensitive_output.is_none());
        assert!(state.active_output.is_some());
    }

    #[test]
    fn scans_and_watcher_invalidation_revoke_pending_sensitive_output() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_sensitive_fixture(&shared, root.path(), 1, 1);

        let OutputStart::ConfirmationRequired {
            ticket: scan_ticket,
            ..
        } = start_output(&shared, &watcher, OutputKind::Copy).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        let scan_cancel = lock(&shared)
            .unwrap()
            .pending_sensitive_output
            .as_ref()
            .unwrap()
            .frozen
            .cancel
            .clone();
        begin_scan(&shared).unwrap();
        assert!(scan_cancel.load(Ordering::Relaxed));
        assert!(lock(&shared).unwrap().pending_sensitive_output.is_none());
        assert!(take_sensitive_output_confirmation(&shared, &watcher, &scan_ticket).is_err());

        drop(watcher);

        let watcher_root = tempfile::tempdir().unwrap();
        let watcher_config = tempfile::tempdir().unwrap();
        let watcher_shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: watcher_config.path().join("settings.json"),
            ..Default::default()
        }));
        let (published, watcher) =
            publish_watching_sensitive_fixture(&watcher_shared, watcher_root.path(), 1, 1);
        let OutputStart::ConfirmationRequired {
            ticket: watcher_ticket,
            ..
        } = start_output(&watcher_shared, &watcher, OutputKind::Export).unwrap()
        else {
            panic!("sensitive selection must require confirmation")
        };
        let watcher_cancel = lock(&watcher_shared)
            .unwrap()
            .pending_sensitive_output
            .as_ref()
            .unwrap()
            .frozen
            .cancel
            .clone();

        watcher
            .request_reconcile(std::path::Path::new(&published.view.root))
            .expect("active root should become stale");

        assert!(watcher_cancel.load(Ordering::Relaxed));
        assert!(
            lock(&watcher_shared)
                .unwrap()
                .pending_sensitive_output
                .is_none()
        );
        assert!(
            take_sensitive_output_confirmation(&watcher_shared, &watcher, &watcher_ticket).is_err()
        );
    }

    #[test]
    fn export_manifest_is_rejected_when_authoritative_watcher_is_stale() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (published, watcher) = publish_watching_fixture(&shared, root.path(), 1);

        watcher
            .request_reconcile(std::path::Path::new(&published.view.root))
            .expect("active root should become stale");

        let error = manifest(&shared, &watcher)
            .err()
            .expect("stale manifests must not be exported");
        assert!(error.contains("watcher is stale"));
        assert!(lock(&shared).unwrap().active_output.is_none());
    }

    #[test]
    fn watcher_transition_cancels_an_already_started_output() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (published, watcher) = publish_watching_fixture(&shared, root.path(), 1);
        let frozen = manifest(&shared, &watcher).unwrap();
        assert!(output_is_current(&shared, &watcher, &frozen));

        watcher
            .request_reconcile(std::path::Path::new(&published.view.root))
            .expect("active root should become stale");

        assert!(frozen.cancel.load(Ordering::Relaxed));
        assert!(!output_is_current(&shared, &watcher, &frozen));
        assert!(lock(&shared).unwrap().active_output.is_none());
    }

    #[test]
    fn watcher_invalidated_output_reports_workspace_change_but_user_cancel_does_not() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (published, watcher) = publish_watching_fixture(&shared, root.path(), 1);
        let frozen = manifest(&shared, &watcher).unwrap();

        let expected_watch = (
            frozen.root_display.clone(),
            frozen.watch_epoch,
            frozen.watch_revision,
        );
        for error in ["export cancelled", "copy cancelled"] {
            assert_eq!(
                output_error_after_watch_change(&watcher, &expected_watch, error.into()),
                error
            );
        }

        watcher
            .request_reconcile(std::path::Path::new(&published.view.root))
            .expect("active root should become stale");

        for error in ["export cancelled", "copy cancelled"] {
            assert!(
                output_error_after_watch_change(&watcher, &expected_watch, error.into())
                    .contains("workspace changed")
            );
        }
    }

    #[test]
    fn export_temporary_artifacts_do_not_stale_in_root_output() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_fixture(&shared, root.path(), 1);
        #[cfg(target_os = "macos")]
        watcher::reconcile_test_startup_hints(&watcher, root.path(), 1);
        let frozen = manifest(&shared, &watcher).unwrap();

        let temp_path = root.path().join(".contextpick-export-watcher-probe.tmp");
        std::fs::write(&temp_path, "synthetic export activity").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(
            watcher.status().unwrap().state,
            watcher::WatchState::Watching
        );
        assert!(!frozen.cancel.load(Ordering::Relaxed));
        std::fs::remove_file(temp_path).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(
            watcher.status().unwrap().state,
            watcher::WatchState::Watching
        );
        assert!(!frozen.cancel.load(Ordering::Relaxed));

        let path = root.path().join("context.md");
        let prepared = Destination::prepare(&frozen.root, &path, false).unwrap();
        reserve_output(&shared, &watcher, &frozen, "context.md").unwrap();
        let result =
            export::export_prepared(&frozen.root, &frozen.entries, prepared, &frozen.cancel)
                .expect("an in-root export must survive its own transaction activity");

        assert!(result.bytes > 0);
        assert!(path.is_file());
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .contains("## file.rs")
        );
    }

    #[test]
    fn tauri_estimate_reuses_unchanged_file_after_unrelated_workspace_generation() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let initial = publish(&shared, fixture(root.path()), 1).unwrap();
        let watcher = WatchService::new(|_| {});
        watcher.activate(std::path::Path::new(&initial.view.root), 1);

        let first = start_token_estimate(&shared, &watcher, 1, "100:1".into()).unwrap();
        let permit = first.gate.clone().try_acquire_owned().unwrap();
        let first = complete_token_estimate(&shared, &watcher, first, permit).unwrap();
        assert_eq!(first.computed_files, 1);
        assert_eq!(first.reused_files, 0);

        std::fs::write(root.path().join("unrelated.rs"), "fn unrelated() {}\n").unwrap();
        let (generation, _) = begin_scan(&shared).unwrap();
        let next_workspace = Workspace::scan(
            root.path(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            &AtomicBool::new(false),
        )
        .unwrap();
        let next = publish(&shared, next_workspace, generation).unwrap();
        watcher.activate(std::path::Path::new(&next.view.root), generation);

        let second = start_token_estimate(&shared, &watcher, generation, "100:2".into()).unwrap();
        let permit = second.gate.clone().try_acquire_owned().unwrap();
        let second = complete_token_estimate(&shared, &watcher, second, permit).unwrap();
        assert_eq!(second.files, 2);
        assert_eq!(second.computed_files, 1);
        assert_eq!(second.reused_files, 1);
    }

    #[test]
    fn older_estimate_request_cannot_supersede_the_current_request() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let published = publish(&shared, fixture(root.path()), 1).unwrap();
        let watcher = WatchService::new(|_| {});
        watcher.activate(std::path::Path::new(&published.view.root), 1);

        let current = start_token_estimate(&shared, &watcher, 1, "100:2".into()).unwrap();
        let stale = start_token_estimate(&shared, &watcher, 1, "100:1".into());

        assert!(stale.is_err());
        assert!(!current.cancel.load(Ordering::Relaxed));
        let state = lock(&shared).unwrap();
        let active = state.active_token_estimate.as_ref().unwrap();
        assert_eq!(active.request_id, "100:2");
    }

    #[test]
    fn delayed_health_from_an_older_root_or_revision_cannot_cancel_estimate() {
        let root = tempfile::tempdir().unwrap();
        let old_root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let published = publish(&shared, fixture(root.path()), 1).unwrap();
        let watcher = WatchService::new(|_| {});
        watcher.activate(std::path::Path::new(&published.view.root), 1);
        let work = start_token_estimate(&shared, &watcher, 1, "100:1".into()).unwrap();

        handle_watch_health(
            &shared,
            &WatchHealth {
                root: old_root.path().display().to_string(),
                epoch: 0,
                revision: 99,
                state: watcher::WatchState::Stale,
                message: Some("delayed old root event".into()),
            },
        );
        handle_watch_health(
            &shared,
            &WatchHealth {
                root: work.root_display.clone(),
                epoch: work.watch_epoch,
                revision: work.watch_revision.saturating_sub(1),
                state: watcher::WatchState::Stale,
                message: Some("delayed old revision".into()),
            },
        );

        assert!(!work.cancel.load(Ordering::Relaxed));
        assert!(active_token_estimate_is_current(
            &lock(&shared).unwrap(),
            &work
        ));
    }

    #[test]
    fn scan_and_stale_watcher_cancel_only_the_active_token_estimate() {
        let root = tempfile::tempdir().unwrap();
        let other_root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let published = publish(&shared, fixture(root.path()), 1).unwrap();
        let watcher_shared = shared.clone();
        let watcher = WatchService::new(move |health| {
            handle_watch_health(&watcher_shared, &health);
        });
        watcher.activate(std::path::Path::new(&published.view.root), 1);

        let work = start_token_estimate(&shared, &watcher, 1, "100:1".into()).unwrap();
        assert!(active_token_estimate_is_current(
            &lock(&shared).unwrap(),
            &work
        ));
        watcher.request_reconcile(std::path::Path::new(&published.view.root));
        assert!(work.cancel.load(Ordering::Relaxed));
        assert!(!active_token_estimate_is_current(
            &lock(&shared).unwrap(),
            &work
        ));

        watcher.revalidated(
            std::path::Path::new(&published.view.root),
            1,
            watcher.checkpoint(std::path::Path::new(&published.view.root)),
        );
        let work = start_token_estimate(&shared, &watcher, 1, "100:2".into()).unwrap();
        let (next_generation, _) = begin_scan(&shared).unwrap();
        assert!(work.cancel.load(Ordering::Relaxed));
        assert!(!active_token_estimate_is_current(
            &lock(&shared).unwrap(),
            &work
        ));

        let replacement = publish(&shared, fixture(other_root.path()), next_generation).unwrap();
        watcher.activate(
            std::path::Path::new(&replacement.view.root),
            next_generation,
        );
        assert!(!active_token_estimate_is_current(
            &lock(&shared).unwrap(),
            &work
        ));
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
    fn delayed_scan_cannot_publish_after_a_newer_generation_wins_the_barrier() {
        let stale_root = tempfile::tempdir().unwrap();
        let active_root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let shared = Arc::new(Mutex::new(Session {
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let stale_candidate = fixture(stale_root.path());
        let (stale_generation, stale_cancel) = begin_scan(&shared).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(0);
        let (publish_tx, publish_rx) = std::sync::mpsc::sync_channel(0);
        let stale_shared = Arc::clone(&shared);
        let stale_scan = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            publish_rx.recv().unwrap();
            publish(&stale_shared, stale_candidate, stale_generation)
        });

        ready_rx.recv().unwrap();
        let (active_generation, _) = begin_scan(&shared).unwrap();
        assert!(stale_cancel.load(Ordering::Relaxed));
        let active = publish(&shared, fixture(active_root.path()), active_generation).unwrap();
        publish_tx.send(()).unwrap();

        assert!(stale_scan.join().unwrap().is_err());
        assert_eq!(
            lock(&shared).unwrap().workspace.as_ref().unwrap().root,
            active.view.root
        );
        assert_eq!(
            active.view.root,
            std::fs::canonicalize(active_root.path())
                .unwrap()
                .display()
                .to_string()
        );
        assert!(config.path().join("settings.json").exists());
    }

    #[test]
    fn workspace_pages_follow_the_current_published_snapshot() {
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
        assert_eq!(
            get_workspace_page(&shared, 1, 0).unwrap().generation,
            first.view.generation,
            "the last published snapshot remains pageable while a scan is in progress"
        );
        assert!(get_workspace_page(&shared, next, 0).is_err());
        publish(&shared, fixture(root.path()), next).unwrap();
        assert!(get_workspace_page(&shared, first.view.generation, 0).is_err());
        assert!(get_workspace_page(&shared, next, usize::MAX).is_err());
        assert_eq!(
            get_workspace_page(&shared, next, 0).unwrap().generation,
            next
        );
    }

    #[test]
    fn failed_scan_keeps_the_last_published_snapshot_available_for_paging() {
        let root = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let previous = fixture(root.path());
        let shared = Arc::new(Mutex::new(Session {
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let published = publish(&shared, previous.clone(), 1).unwrap();
        let (failed_generation, cancel) = begin_scan(&shared).unwrap();
        cancel.store(true, Ordering::Relaxed);

        let failed = Workspace::scan_pinned_with_outputs(
            previous.root_handle,
            previous.policy,
            previous.intents,
            previous.browsed,
            previous.generated_outputs,
            &cancel,
        );
        assert!(failed.is_err(), "the cancelled refresh must fail");
        assert_eq!(
            lock(&shared).unwrap().snapshot.as_ref().unwrap().generation,
            published.view.generation,
            "a failed refresh must not replace the last good snapshot"
        );
        assert_eq!(
            get_workspace_page(&shared, published.view.generation, 0)
                .unwrap()
                .generation,
            published.view.generation
        );
        assert!(get_workspace_page(&shared, failed_generation, 0).is_err());
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
        let health_shared = Arc::clone(&shared);
        let watcher = WatchService::new(move |health| handle_watch_health(&health_shared, &health));
        watcher.activate(
            std::path::Path::new(&pending_ipc_response.view.root),
            second_generation,
        );
        // Cancellation is a view reconciliation, not another preferences write.
        lock(&shared).unwrap().settings_saving_blocked = true;
        let authoritative = cancel_and_snapshot(&shared).unwrap().unwrap();
        watcher.activate(
            std::path::Path::new(&authoritative.view.root),
            authoritative.view.generation,
        );
        assert_eq!(authoritative.view.root, pending_ipc_response.view.root);
        assert!(authoritative.view.generation > pending_ipc_response.view.generation);
        assert!(token.load(Ordering::Relaxed));
        assert!(get_workspace_page(&shared, second_generation, 0).is_err());
        assert!(get_workspace_page(&shared, authoritative.view.generation, 0).is_ok());
        assert_eq!(
            manifest(&shared, &watcher)
                .unwrap()
                .root
                .path()
                .display()
                .to_string(),
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
            generation: 1,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_fixture(&shared, root.path(), 1);
        let frozen = manifest(&shared, &watcher).unwrap();
        reserve_output(&shared, &watcher, &frozen, "context.md").unwrap();
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
            generation: 2,
            settings_path: config.path().join("settings.json"),
            ..Default::default()
        }));
        let (_, watcher) = publish_watching_fixture(&shared, root.path(), 2);
        let frozen = manifest(&shared, &watcher).unwrap();
        lock(&shared).unwrap().generation = 1;
        assert!(reserve_output(&shared, &watcher, &frozen, "stale.md").is_err());
        lock(&shared).unwrap().generation = 2;
        lock(&shared).unwrap().settings_path = config.path().join("not-directory/settings.json");
        assert!(reserve_output(&shared, &watcher, &frozen, "failed.md").is_err());
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
