use notify::Config;
use notify::{Event, Watcher};
use serde::Serialize;
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const SIGNAL_CAPACITY: usize = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WatchSignal {
    /// The index may be stale; the consumer should reconcile from disk.
    Changed,
    /// Notify reports that events may have been missed; force a full reconcile.
    FullReconcile,
    /// The watcher encountered a runtime failure and recovery is required.
    RuntimeError(String),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchHealth {
    pub(crate) root: String,
    pub(crate) epoch: u64,
    pub(crate) revision: u64,
    pub(crate) state: WatchState,
    pub(crate) message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WatchState {
    Watching,
    Stale,
    Unavailable,
}

type PublishHealth = Arc<dyn Fn(WatchHealth) + Send + Sync>;

/// Owns the single watcher for the active workspace and publishes health only.
pub(crate) struct WatchService {
    lifecycle: Mutex<()>,
    state: Arc<Mutex<ServiceState>>,
    publish: PublishHealth,
}

#[derive(Default)]
struct ServiceState {
    next_epoch: u64,
    next_health_revision: u64,
    workspace_generation: u64,
    health: Option<WatchHealth>,
    invalidation_revision: Option<Arc<Mutex<u64>>>,
    worker: Option<WatchWorker>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WatchCheckpoint {
    epoch: u64,
    invalidation_revision: u64,
}

struct WatchWorker {
    stop: Sender<()>,
    join: Option<JoinHandle<()>>,
}

impl Drop for WatchWorker {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl WatchService {
    pub(crate) fn new(publish: impl Fn(WatchHealth) + Send + Sync + 'static) -> Self {
        Self {
            lifecycle: Mutex::new(()),
            state: Arc::new(Mutex::new(ServiceState::default())),
            publish: Arc::new(publish),
        }
    }

    pub(crate) fn status(&self) -> Option<WatchHealth> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .health
            .clone()
    }

    #[cfg(debug_assertions)]
    pub(crate) fn fail_for_test(&self) -> Option<WatchHealth> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (worker, current) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let current = state
                .health
                .clone()
                .filter(|health| health.state == WatchState::Watching)?;
            (state.worker.take(), current)
        };
        drop(worker);
        let current = self.status().filter(|health| {
            health.epoch == current.epoch && health.state != WatchState::Unavailable
        })?;
        let health = apply_signal(
            &self.state,
            current.epoch,
            WatchSignal::RuntimeError("Synthetic watcher failure for native test.".into()),
        )?;
        (self.publish)(health.clone());
        Some(health)
    }

    /// Start a watcher for a successfully published workspace, replacing any old root.
    pub(crate) fn activate(&self, root: &Path, generation: u64) -> Option<WatchHealth> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.activate_locked(root, generation)
    }

    fn activate_locked(&self, root: &Path, generation: u64) -> Option<WatchHealth> {
        let root = root.to_string_lossy().into_owned();
        let (epoch, previous) =
            {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if generation < state.workspace_generation {
                    return state.health.clone();
                }
                if state.health.as_ref().is_some_and(|health| {
                    health.root == root && health.state == WatchState::Watching
                }) {
                    state.workspace_generation = generation;
                    return state.health.clone();
                }
                state.workspace_generation = generation;
                state.next_epoch = state.next_epoch.saturating_add(1);
                state.health = None;
                state.invalidation_revision = None;
                (state.next_epoch, state.worker.take())
            };

        // Dropping the previous worker sends its stop signal and joins it without
        // holding the shared state lock that the worker may need to finish.
        drop(previous);

        let watcher = match WorkspaceWatcher::start(Path::new(&root)) {
            Ok(watcher) => watcher,
            Err(error) => {
                let health = self.set_health(
                    WatchHealth {
                        root,
                        epoch,
                        revision: 0,
                        state: WatchState::Unavailable,
                        message: Some(bounded_error(&error.to_string())),
                    },
                    None,
                );
                return Some(health);
            }
        };

        let health = self.set_health(
            WatchHealth {
                root: root.clone(),
                epoch,
                revision: 0,
                state: WatchState::Watching,
                message: None,
            },
            Some(Arc::clone(&watcher.invalidation_revision)),
        );

        let state = Arc::clone(&self.state);
        let publish = Arc::clone(&self.publish);
        let (stop, stop_receiver) = mpsc::channel();
        let join = thread::spawn(move || {
            run_worker(watcher, epoch, stop_receiver, state, publish);
        });
        let mut service_state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if service_state
            .health
            .as_ref()
            .is_some_and(|current| current.epoch == epoch)
        {
            service_state.worker = Some(WatchWorker {
                stop,
                join: Some(join),
            });
        } else {
            drop(service_state);
            let _ = stop.send(());
            let _ = join.join();
        }
        Some(health)
    }

    /// Capture changes reported by the active watcher before an authoritative scan starts.
    pub(crate) fn checkpoint(&self, root: &Path) -> Option<WatchCheckpoint> {
        let root = root.to_string_lossy();
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let health = state
            .health
            .as_ref()
            .filter(|health| health.root == root && health.state != WatchState::Unavailable)?;
        let invalidation_revision = state
            .invalidation_revision
            .as_ref()?
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .to_owned();
        Some(WatchCheckpoint {
            epoch: health.epoch,
            invalidation_revision,
        })
    }

    /// Request an authoritative reconcile after the host regains focus.
    ///
    /// This only advances the active watcher's invalidation checkpoint and
    /// publishes health. It does not scan the workspace or alter user intent.
    pub(crate) fn request_reconcile(&self, root: &Path) -> Option<WatchHealth> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = root.to_string_lossy();
        let (health, should_publish) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let current = state
                .health
                .as_ref()
                .filter(|health| health.root == root)?
                .clone();

            if let Some(invalidation_revision) = &state.invalidation_revision {
                let mut invalidation_revision = invalidation_revision
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *invalidation_revision = invalidation_revision.saturating_add(1);
            }

            match current.state {
                WatchState::Unavailable => (current, false),
                WatchState::Watching | WatchState::Stale => {
                    let health = Self::next_health_revision(
                        &mut state,
                        WatchHealth {
                            state: WatchState::Stale,
                            message: Some("Workspace focus regained. Refresh to reconcile.".into()),
                            ..current
                        },
                    );
                    state.health = Some(health.clone());
                    (health, true)
                }
            }
        };
        drop(_lifecycle);
        if should_publish {
            (self.publish)(health.clone());
        }
        Some(health)
    }

    /// A successful explicit refresh clears a dirty state only if no observed edit
    /// arrived after the scan began.
    pub(crate) fn revalidated(
        &self,
        root: &Path,
        generation: u64,
        checkpoint: Option<WatchCheckpoint>,
    ) -> Option<WatchHealth> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = root.to_string_lossy().into_owned();
        let updated = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if generation < state.workspace_generation {
                return state.health.clone();
            }
            state.workspace_generation = generation;
            if let Some(current) = state.health.clone().filter(|health| health.root == root) {
                if current.state == WatchState::Unavailable {
                    None
                } else if let Some(checkpoint) =
                    checkpoint.filter(|checkpoint| checkpoint.epoch == current.epoch)
                {
                    let invalidation_revision = state.invalidation_revision.as_ref()?.clone();
                    let _invalidation_guard = invalidation_revision
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let latest = *_invalidation_guard;
                    if latest != checkpoint.invalidation_revision {
                        let updated = Self::next_health_revision(
                            &mut state,
                            WatchHealth {
                                state: WatchState::Stale,
                                message: Some(
                                    "Files changed during refresh. Refresh again to reconcile."
                                        .into(),
                                ),
                                ..current
                            },
                        );
                        state.health = Some(updated.clone());
                        Some(updated)
                    } else if current.state == WatchState::Stale {
                        let updated = Self::next_health_revision(
                            &mut state,
                            WatchHealth {
                                state: WatchState::Watching,
                                message: None,
                                ..current
                            },
                        );
                        state.health = Some(updated.clone());
                        Some(updated)
                    } else {
                        Some(current)
                    }
                } else {
                    Some(current)
                }
            } else {
                None
            }
        };
        if let Some(updated) = updated {
            (self.publish)(updated.clone());
            return Some(updated);
        }
        self.activate_locked(Path::new(&root), generation)
    }

    fn next_health_revision(state: &mut ServiceState, mut health: WatchHealth) -> WatchHealth {
        state.next_health_revision = state.next_health_revision.saturating_add(1);
        health.revision = state.next_health_revision;
        health
    }

    fn set_health(
        &self,
        health: WatchHealth,
        invalidation_revision: Option<Arc<Mutex<u64>>>,
    ) -> WatchHealth {
        let publish = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let health = Self::next_health_revision(&mut state, health);
            state.invalidation_revision = invalidation_revision;
            state.health = Some(health.clone());
            (health, Arc::clone(&self.publish))
        };
        (publish.1)(publish.0.clone());
        publish.0
    }
}

impl Drop for WatchService {
    fn drop(&mut self) {
        let worker = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .worker
            .take();
        drop(worker);
    }
}

fn run_worker(
    watcher: WorkspaceWatcher,
    epoch: u64,
    stop: Receiver<()>,
    state: Arc<Mutex<ServiceState>>,
    publish: PublishHealth,
) {
    loop {
        if stop.try_recv().is_ok() {
            return;
        }
        let signal = match watcher.recv_timeout(Duration::from_millis(100)) {
            Ok(signal) => signal,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        let Some(health) = apply_signal(&state, epoch, signal) else {
            continue;
        };
        publish(health.clone());
        if health.state == WatchState::Unavailable {
            return;
        }
    }
}

fn apply_signal(
    state: &Arc<Mutex<ServiceState>>,
    epoch: u64,
    signal: WatchSignal,
) -> Option<WatchHealth> {
    let mut state = state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let current = state
        .health
        .as_ref()
        .filter(|health| health.epoch == epoch)?
        .clone();
    let (next_state, message) = match signal {
        WatchSignal::Changed | WatchSignal::FullReconcile => (
            WatchState::Stale,
            Some("Workspace files changed. Refresh to reconcile.".into()),
        ),
        WatchSignal::RuntimeError(message) => (WatchState::Unavailable, Some(message)),
    };
    if current.state == next_state
        && (next_state == WatchState::Stale || current.message == message)
    {
        return None;
    }
    let updated = WatchService::next_health_revision(
        &mut state,
        WatchHealth {
            state: next_state,
            message,
            ..current
        },
    );
    state.health = Some(updated.clone());
    Some(updated)
}

/// A recursive filesystem watcher that reports bounded invalidation hints.
///
/// Events are deliberately coalesced: consumers must reconcile from disk and
/// must not interpret these signals as a complete path-by-path event history.
pub(crate) struct WorkspaceWatcher {
    _watcher: notify::RecommendedWatcher,
    receiver: Receiver<WatchSignal>,
    sticky_signals: Arc<Mutex<StickySignals>>,
    invalidation_revision: Arc<Mutex<u64>>,
}

#[derive(Default)]
struct StickySignals {
    full_reconcile: bool,
    runtime_error: Option<String>,
}

impl WorkspaceWatcher {
    pub(crate) fn start(root: &Path) -> Result<Self, notify::Error> {
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky_signals = Arc::new(Mutex::new(StickySignals::default()));
        let callback_signals = Arc::clone(&sticky_signals);
        let invalidation_revision = Arc::new(Mutex::new(0));
        let callback_revision = Arc::clone(&invalidation_revision);
        let callback_root = root.to_path_buf();
        let mut watcher = notify::RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                forward_result(
                    result,
                    &callback_root,
                    &sender,
                    &callback_signals,
                    &callback_revision,
                );
            },
            Config::default().with_follow_symlinks(false),
        )?;
        watcher.watch(root, notify::RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            receiver,
            sticky_signals,
            invalidation_revision,
        })
    }

    /// Wait briefly for the next coalesced hint.
    pub(crate) fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<WatchSignal, mpsc::RecvTimeoutError> {
        if let Some(error) = self
            .sticky_signals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take_next()
        {
            return Ok(error);
        }
        match self.receiver.recv_timeout(timeout) {
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(error) = self
                    .sticky_signals
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take_next()
                {
                    Ok(error)
                } else {
                    Err(mpsc::RecvTimeoutError::Timeout)
                }
            }
            result => result,
        }
    }
}

impl StickySignals {
    fn take_next(&mut self) -> Option<WatchSignal> {
        if let Some(error) = self.runtime_error.take() {
            Some(WatchSignal::RuntimeError(error))
        } else if std::mem::take(&mut self.full_reconcile) {
            Some(WatchSignal::FullReconcile)
        } else {
            None
        }
    }
}

fn forward_result(
    result: notify::Result<Event>,
    root: &Path,
    sender: &SyncSender<WatchSignal>,
    sticky_signals: &Mutex<StickySignals>,
    invalidation_revision: &Mutex<u64>,
) {
    let signal = match result {
        Ok(event) if event.need_rescan() => WatchSignal::FullReconcile,
        Ok(event) if reserved_export_temporary_activity(root, &event) => return,
        // Reads and handle opens do not change the indexed files; previewing or
        // exporting content must not make the workspace appear stale.
        Ok(event)
            if event.kind.is_access()
                || matches!(
                    event.kind,
                    notify::EventKind::Modify(notify::event::ModifyKind::Metadata(
                        notify::event::MetadataKind::AccessTime
                    ))
                ) =>
        {
            return;
        }
        // FSEvents reports access-time updates as Metadata(Any), and can pair
        // child changes with metadata notifications for their parent directory.
        // Its explicit data/name/create/remove and rescan events still invalidate.
        #[cfg(target_os = "macos")]
        Ok(event) if metadata_only_index_change(&event) => return,
        Ok(event) if directory_metadata_only(&event) => return,
        // No path history is promised. Normal events are only invalidation hints.
        Ok(_) => WatchSignal::Changed,
        Err(error) => WatchSignal::RuntimeError(bounded_error(&error.to_string())),
    };
    if matches!(signal, WatchSignal::Changed | WatchSignal::FullReconcile) {
        let mut revision = invalidation_revision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *revision = revision.saturating_add(1);
    }
    match sender.try_send(signal) {
        Ok(()) => {}
        Err(TrySendError::Full(WatchSignal::RuntimeError(message))) => {
            let mut pending = sticky_signals
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if pending.runtime_error.is_none() {
                pending.runtime_error = Some(message);
            }
        }
        Err(TrySendError::Full(WatchSignal::FullReconcile)) => {
            sticky_signals
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .full_reconcile = true;
        }
        // A queued change hint already covers any dropped ordinary event.
        // Disconnection means the owning watcher has been dropped.
        Err(TrySendError::Full(WatchSignal::Changed) | TrySendError::Disconnected(_)) => {}
    }
}

#[cfg(target_os = "macos")]
fn metadata_only_index_change(event: &Event) -> bool {
    !event.paths.is_empty()
        && matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Metadata(
                notify::event::MetadataKind::Any
            ))
        )
}

fn reserved_export_temporary_activity(root: &Path, event: &Event) -> bool {
    !event.need_rescan()
        && !event.paths.is_empty()
        && event.paths.iter().all(|path| {
            path.strip_prefix(root)
                .is_ok_and(contextpick_core::destination::is_export_temporary_path)
        })
}

fn directory_metadata_only(event: &Event) -> bool {
    matches!(
        event.kind,
        notify::EventKind::Modify(notify::event::ModifyKind::Any)
    ) && !event.paths.is_empty()
        && event.paths.iter().all(|path| path.is_dir())
}

fn bounded_error(message: &str) -> String {
    message.chars().take(512).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use contextpick_core::workspace::{FilterPolicy, Workspace};
    use notify::{
        Error, ErrorKind, EventKind,
        event::{AccessKind, Flag},
    };
    use std::{
        collections::{BTreeMap, BTreeSet},
        fs,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc::TryRecvError,
        },
        time::{Instant, SystemTime, UNIX_EPOCH},
    };

    fn event(kind: EventKind) -> notify::Result<Event> {
        Ok(Event::new(kind))
    }

    // FSEvents may deliver queued pre-watch hints after registration. Establish a
    // quiet baseline before asserting that subsequent reads do not invalidate.
    #[cfg(target_os = "macos")]
    fn drain_startup_hints(watcher: &WorkspaceWatcher) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < deadline, "startup hints did not settle");
            match watcher.recv_timeout(Duration::from_millis(500)) {
                Ok(WatchSignal::RuntimeError(message)) => panic!("watcher failed: {message}"),
                Ok(WatchSignal::Changed | WatchSignal::FullReconcile) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => return,
                Err(mpsc::RecvTimeoutError::Disconnected) => panic!("watcher stopped"),
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn drain_startup_hints(_: &WorkspaceWatcher) {}

    // The live service publishes startup hints conservatively. Reconcile that
    // backend startup burst before testing the new-root lifecycle itself.
    #[cfg(target_os = "macos")]
    fn reconcile_startup_hints(service: &WatchService, root: &Path, generation: u64) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < deadline, "startup hints did not settle");
            let checkpoint = service.checkpoint(root).expect("active watcher checkpoint");
            std::thread::sleep(Duration::from_millis(500));
            let after_quiet = service.checkpoint(root).expect("active watcher checkpoint");
            if after_quiet.invalidation_revision != checkpoint.invalidation_revision {
                continue;
            }

            Workspace::scan(
                root,
                FilterPolicy::default(),
                BTreeMap::new(),
                BTreeSet::new(),
                &AtomicBool::new(false),
            )
            .expect("startup reconciliation should succeed");
            let Some(health) = service.revalidated(root, generation, Some(checkpoint)) else {
                panic!("active watcher should remain available");
            };
            if health.state != WatchState::Watching {
                continue;
            }

            std::thread::sleep(Duration::from_millis(500));
            let settled = service.checkpoint(root).expect("active watcher checkpoint");
            if settled.invalidation_revision == after_quiet.invalidation_revision
                && service
                    .status()
                    .is_some_and(|current| current.state == WatchState::Watching)
            {
                return;
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn reconcile_startup_hints(_: &WatchService, _: &Path, _: u64) {}

    fn forward_result(
        result: notify::Result<Event>,
        sender: &SyncSender<WatchSignal>,
        sticky_signals: &Mutex<StickySignals>,
    ) {
        super::forward_result(
            result,
            Path::new("workspace"),
            sender,
            sticky_signals,
            &Mutex::new(0),
        );
    }

    #[test]
    fn coalesces_events_and_keeps_runtime_error_sticky_when_queue_is_full() {
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        forward_result(event(EventKind::Any), &sender, &sticky);
        forward_result(event(EventKind::Any), &sender, &sticky);
        forward_result(
            Err(Error::new(ErrorKind::Generic(
                "synthetic watcher fault".into(),
            ))),
            &sender,
            &sticky,
        );

        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::Changed);
        assert_eq!(
            sticky.lock().unwrap().take_next(),
            Some(WatchSignal::RuntimeError("synthetic watcher fault".into()))
        );
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn reserved_export_temporary_activity_does_not_invalidate_workspace() {
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        let revision = Mutex::new(0);
        let mut event = Event::new(EventKind::Any);
        event.paths.push(std::path::PathBuf::from(
            "workspace/.contextpick-export-a1b2.tmp",
        ));

        super::forward_result(
            Ok(event),
            Path::new("workspace"),
            &sender,
            &sticky,
            &revision,
        );

        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
        assert_eq!(*revision.lock().unwrap(), 0);

        let mut mixed_event = Event::new(EventKind::Any);
        mixed_event.paths.extend([
            std::path::PathBuf::from("workspace/.contextpick-export-a1b2.tmp"),
            std::path::PathBuf::from("workspace/source.rs"),
        ]);
        super::forward_result(
            Ok(mixed_event),
            Path::new("workspace"),
            &sender,
            &sticky,
            &revision,
        );
        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::Changed);

        let mut overflow = Event::new(EventKind::Any).set_flag(Flag::Rescan);
        overflow.paths.push(std::path::PathBuf::from(
            "workspace/.contextpick-export-a1b2.tmp",
        ));
        super::forward_result(
            Ok(overflow),
            Path::new("workspace"),
            &sender,
            &sticky,
            &revision,
        );
        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::FullReconcile);
        assert_eq!(*revision.lock().unwrap(), 2);
    }

    #[test]
    fn reserved_prefix_in_workspace_root_does_not_hide_source_changes() {
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        let revision = Mutex::new(0);
        let root = std::path::PathBuf::from("workspace/.contextpick-export-project");
        let mut event = Event::new(EventKind::Any);
        event.paths.push(root.join("src/main.rs"));

        super::forward_result(Ok(event), &root, &sender, &sticky, &revision);

        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::Changed);
        assert_eq!(*revision.lock().unwrap(), 1);
    }

    #[test]
    fn notify_rescan_event_maps_to_full_reconcile() {
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        let event = Event::new(EventKind::Any).set_flag(Flag::Rescan);
        assert!(event.need_rescan());
        forward_result(Ok(event), &sender, &sticky);
        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::FullReconcile);
    }

    #[test]
    fn read_access_does_not_mark_the_workspace_dirty() {
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        let read = Event::new(EventKind::Access(AccessKind::Read));
        forward_result(Ok(read), &sender, &sticky);
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
        assert_eq!(sticky.lock().unwrap().take_next(), None);

        let access_time = Event::new(EventKind::Modify(notify::event::ModifyKind::Metadata(
            notify::event::MetadataKind::AccessTime,
        )));
        forward_result(Ok(access_time), &sender, &sticky);
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn metadata_only_events_do_not_invalidate_indexed_content() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("source.rs");
        fs::write(&file, "fn source() {}\n").unwrap();
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        let revision = Mutex::new(0);

        for path in [root.path(), file.as_path()] {
            let metadata = Event::new(EventKind::Modify(notify::event::ModifyKind::Metadata(
                notify::event::MetadataKind::Any,
            )))
            .add_path(path.to_path_buf());
            super::forward_result(Ok(metadata), root.path(), &sender, &sticky, &revision);
        }

        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
        assert_eq!(*revision.lock().unwrap(), 0);

        let content_change = Event::new(EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Content,
        )))
        .add_path(file);
        super::forward_result(Ok(content_change), root.path(), &sender, &sticky, &revision);

        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::Changed);
        assert_eq!(*revision.lock().unwrap(), 1);
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn generic_metadata_events_still_invalidate_on_other_backends() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("source.rs");
        fs::write(&file, "fn source() {}\n").unwrap();
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        let revision = Mutex::new(0);
        let metadata = Event::new(EventKind::Modify(notify::event::ModifyKind::Metadata(
            notify::event::MetadataKind::Any,
        )))
        .add_path(file);

        super::forward_result(Ok(metadata), root.path(), &sender, &sticky, &revision);

        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::Changed);
        assert_eq!(*revision.lock().unwrap(), 1);
    }

    #[test]
    fn explicit_ownership_metadata_still_invalidates() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("source.rs");
        fs::write(&file, "fn source() {}\n").unwrap();
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        let revision = Mutex::new(0);
        let ownership = Event::new(EventKind::Modify(notify::event::ModifyKind::Metadata(
            notify::event::MetadataKind::Ownership,
        )))
        .add_path(file);

        super::forward_result(Ok(ownership), root.path(), &sender, &sticky, &revision);

        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::Changed);
        assert_eq!(*revision.lock().unwrap(), 1);
    }

    #[test]
    fn observed_changes_advance_invalidation_even_when_the_signal_queue_is_full() {
        let (sender, _receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        let invalidation_revision = Mutex::new(0);
        super::forward_result(
            event(EventKind::Any),
            Path::new("workspace"),
            &sender,
            &sticky,
            &invalidation_revision,
        );
        super::forward_result(
            event(EventKind::Any),
            Path::new("workspace"),
            &sender,
            &sticky,
            &invalidation_revision,
        );
        assert_eq!(*invalidation_revision.lock().unwrap(), 2);
    }

    #[test]
    fn directory_only_metadata_is_ignored_but_file_mutations_are_kept() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file.txt");
        fs::write(&file, "content").unwrap();
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());

        let directory_event = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(root.path().to_path_buf());
        forward_result(Ok(directory_event), &sender, &sticky);
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));

        let file_event =
            Event::new(EventKind::Modify(notify::event::ModifyKind::Any)).add_path(file);
        forward_result(Ok(file_event), &sender, &sticky);
        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::Changed);
    }

    #[test]
    fn missing_root_is_reported_as_a_startup_error() {
        let root = std::env::temp_dir().join(format!(
            "contextpick-missing-watch-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let error = match WorkspaceWatcher::start(&root) {
            Ok(_) => panic!("watcher unexpectedly started for a missing root"),
            Err(error) => error,
        };
        assert!(!error.to_string().is_empty());
    }

    #[test]
    fn rescan_signal_is_sticky_when_queue_is_full() {
        let (sender, receiver) = mpsc::sync_channel(SIGNAL_CAPACITY);
        let sticky = Mutex::new(StickySignals::default());
        forward_result(event(EventKind::Any), &sender, &sticky);
        let rescan = Event::new(EventKind::Any).set_flag(Flag::Rescan);
        forward_result(Ok(rescan), &sender, &sticky);

        assert_eq!(receiver.try_recv().unwrap(), WatchSignal::Changed);
        assert_eq!(
            sticky.lock().unwrap().take_next(),
            Some(WatchSignal::FullReconcile)
        );
        assert_eq!(sticky.lock().unwrap().take_next(), None);
    }

    #[test]
    fn service_recovers_after_startup_failure_and_marks_workspace_dirty() {
        let root = tempfile::tempdir().unwrap();
        let missing_root = root.path().join("created-later");
        let (published, events) = mpsc::channel();
        let service = WatchService::new(move |health| published.send(health).unwrap());

        let unavailable = service.activate(&missing_root, 1).unwrap();
        assert_eq!(unavailable.state, WatchState::Unavailable);
        assert_eq!(service.status(), Some(unavailable.clone()));

        fs::create_dir(&missing_root).unwrap();
        let watching = service.revalidated(&missing_root, 2, None).unwrap();
        assert_eq!(watching.state, WatchState::Watching);
        assert!(watching.epoch > 0);
        assert!(watching.revision > unavailable.revision);
        assert_eq!(
            events.recv_timeout(Duration::from_secs(1)).unwrap().state,
            WatchState::Unavailable
        );
        assert_eq!(
            events.recv_timeout(Duration::from_secs(1)).unwrap().state,
            WatchState::Watching
        );

        fs::write(missing_root.join("created.txt"), "content").unwrap();
        let dirty = events.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(dirty.root, missing_root.to_string_lossy());
        assert_eq!(dirty.epoch, watching.epoch);
        assert_eq!(dirty.state, WatchState::Stale);
        assert_eq!(service.status(), Some(dirty));
    }

    #[test]
    fn refresh_does_not_clear_stale_after_a_change_arrives_during_the_scan() {
        let root = tempfile::tempdir().unwrap();
        let service = WatchService::new(|_| {});
        let watching = service.activate(root.path(), 1).unwrap();
        let checkpoint = service.checkpoint(root.path()).unwrap();
        assert_eq!(checkpoint.epoch, watching.epoch);

        let revision = service
            .state
            .lock()
            .unwrap()
            .invalidation_revision
            .as_ref()
            .unwrap()
            .clone();
        *revision.lock().unwrap() += 1;

        let still_stale = service
            .revalidated(root.path(), 2, Some(checkpoint))
            .unwrap();
        assert_eq!(still_stale.state, WatchState::Stale);
        assert!(
            still_stale
                .message
                .as_deref()
                .unwrap()
                .contains("during refresh")
        );
        assert!(still_stale.revision > watching.revision);
    }

    #[test]
    fn focus_revalidation_marks_matching_watcher_stale_and_advances_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let (published, events) = mpsc::channel();
        let service = WatchService::new(move |health| published.send(health).unwrap());
        let watching = service.activate(root.path(), 1).unwrap();
        while events.try_recv().is_ok() {}
        let before = service.checkpoint(root.path()).unwrap();

        let stale = service.request_reconcile(root.path()).unwrap();

        let after = service.checkpoint(root.path()).unwrap();
        assert_eq!(stale.root, watching.root);
        assert_eq!(stale.epoch, watching.epoch);
        assert_eq!(stale.state, WatchState::Stale);
        assert!(stale.revision > watching.revision);
        assert!(after.invalidation_revision > before.invalidation_revision);
        assert_eq!(events.try_recv().unwrap(), stale);
    }

    #[test]
    fn focus_revalidation_revisions_an_already_stale_watcher_for_retry() {
        let root = tempfile::tempdir().unwrap();
        let (published, events) = mpsc::channel();
        let service = WatchService::new(move |health| published.send(health).unwrap());
        let watching = service.activate(root.path(), 1).unwrap();
        while events.try_recv().is_ok() {}
        let stale = apply_signal(&service.state, watching.epoch, WatchSignal::Changed).unwrap();
        let before = service.checkpoint(root.path()).unwrap();

        let retry = service.request_reconcile(root.path()).unwrap();

        let after = service.checkpoint(root.path()).unwrap();
        assert_eq!(retry.state, WatchState::Stale);
        assert_eq!(retry.epoch, stale.epoch);
        assert!(retry.revision > stale.revision);
        assert!(after.invalidation_revision > before.invalidation_revision);
        assert_eq!(events.try_recv().unwrap(), retry);
    }

    #[test]
    fn focus_revalidation_keeps_unavailable_watcher_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let (published, events) = mpsc::channel();
        let service = WatchService::new(move |health| published.send(health).unwrap());
        let watching = service.activate(root.path(), 1).unwrap();
        while events.try_recv().is_ok() {}
        let unavailable = apply_signal(
            &service.state,
            watching.epoch,
            WatchSignal::RuntimeError("synthetic failure".into()),
        )
        .unwrap();
        let invalidation = service
            .state
            .lock()
            .unwrap()
            .invalidation_revision
            .as_ref()
            .unwrap()
            .clone();
        let before = *invalidation.lock().unwrap();

        let result = service.request_reconcile(root.path()).unwrap();

        assert_eq!(result, unavailable);
        assert_eq!(result.state, WatchState::Unavailable);
        assert_eq!(*invalidation.lock().unwrap(), before + 1);
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn focus_revalidation_ignores_a_non_active_root() {
        let roots = tempfile::tempdir().unwrap();
        let active = roots.path().join("active");
        let other = roots.path().join("other");
        fs::create_dir(&active).unwrap();
        fs::create_dir(&other).unwrap();
        let service = WatchService::new(|_| {});
        let watching = service.activate(&active, 1).unwrap();
        let before = service.checkpoint(&active).unwrap();

        assert!(service.request_reconcile(&other).is_none());

        assert_eq!(service.status(), Some(watching));
        assert_eq!(service.checkpoint(&active), Some(before));
    }

    #[test]
    fn dirty_event_during_refresh_advances_stale_revision_for_one_follow_up() {
        let root = tempfile::tempdir().unwrap();
        let service = WatchService::new(|_| {});
        let watching = service.activate(root.path(), 1).unwrap();
        let invalidation = service
            .state
            .lock()
            .unwrap()
            .invalidation_revision
            .as_ref()
            .unwrap()
            .clone();

        *invalidation.lock().unwrap() += 1;
        let already_stale =
            apply_signal(&service.state, watching.epoch, WatchSignal::Changed).unwrap();
        let checkpoint = service.checkpoint(root.path()).unwrap();
        *invalidation.lock().unwrap() += 1;

        let follow_up = service
            .revalidated(root.path(), 2, Some(checkpoint))
            .unwrap();
        assert_eq!(follow_up.state, WatchState::Stale);
        assert!(follow_up.revision > already_stale.revision);
        assert!(
            follow_up
                .message
                .as_deref()
                .unwrap()
                .contains("during refresh")
        );
    }

    #[test]
    fn scan_with_an_observed_edit_stays_stale_until_one_stable_follow_up_scan() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("before.ts"), "before").unwrap();
        let service = WatchService::new(|_| {});
        let root_string = root.path().to_string_lossy().into_owned();
        {
            let mut state = service.state.lock().unwrap();
            state.next_epoch = 1;
            state.next_health_revision = 1;
            state.workspace_generation = 1;
            state.invalidation_revision = Some(Arc::new(Mutex::new(0)));
            state.health = Some(WatchHealth {
                root: root_string,
                epoch: 1,
                revision: 1,
                state: WatchState::Watching,
                message: None,
            });
        }

        let checkpoint = service.checkpoint(root.path()).unwrap();
        let (candidate_tx, candidate_rx) = mpsc::sync_channel(0);
        let (resume_tx, resume_rx) = mpsc::sync_channel(0);
        let scan_count = AtomicUsize::new(0);
        let scan_service = &service;
        let scan_root = root.path().to_path_buf();
        let scan_count_ref = &scan_count;
        let follow_up_candidate = std::thread::scope(|scope| {
            let scan = scope.spawn(move || {
                let candidate = Workspace::scan(
                    &scan_root,
                    FilterPolicy::default(),
                    BTreeMap::new(),
                    BTreeSet::new(),
                    &AtomicBool::new(false),
                )
                .unwrap();
                scan_count_ref.fetch_add(1, Ordering::SeqCst);
                let paths = candidate
                    .view(1)
                    .entries
                    .into_iter()
                    .map(|entry| entry.path)
                    .collect::<BTreeSet<_>>();
                candidate_tx.send(paths).unwrap();
                resume_rx.recv().unwrap();
                let health = scan_service
                    .revalidated(&scan_root, 2, Some(checkpoint))
                    .unwrap();
                (candidate, health)
            });

            let first_paths = candidate_rx.recv().unwrap();
            assert!(first_paths.contains("before.ts"));
            assert!(!first_paths.contains("after.ts"));

            // Deterministically model a burst while the first candidate is
            // complete but not yet accepted. The rescan signal overflows the
            // bounded queue and remains sticky for the consumer.
            fs::write(root.path().join("after.ts"), "after").unwrap();
            let invalidation = service
                .state
                .lock()
                .unwrap()
                .invalidation_revision
                .as_ref()
                .unwrap()
                .clone();
            let (signals, pending) = mpsc::sync_channel(SIGNAL_CAPACITY);
            let sticky = Mutex::new(StickySignals::default());
            super::forward_result(
                event(EventKind::Any),
                root.path(),
                &signals,
                &sticky,
                &invalidation,
            );
            super::forward_result(
                event(EventKind::Any),
                root.path(),
                &signals,
                &sticky,
                &invalidation,
            );
            let overflow = Event::new(EventKind::Any).set_flag(Flag::Rescan);
            super::forward_result(Ok(overflow), root.path(), &signals, &sticky, &invalidation);
            assert_eq!(*invalidation.lock().unwrap(), 3);

            let dirty = apply_signal(&service.state, 1, pending.try_recv().unwrap()).unwrap();
            assert_eq!(dirty.state, WatchState::Stale);
            assert_eq!(
                sticky.lock().unwrap().take_next(),
                Some(WatchSignal::FullReconcile)
            );
            assert!(apply_signal(&service.state, 1, WatchSignal::FullReconcile).is_none());
            resume_tx.send(()).unwrap();

            let (first_candidate, first_health) = scan.join().unwrap();
            assert!(
                !first_candidate
                    .view(1)
                    .entries
                    .iter()
                    .any(|entry| entry.path == "after.ts")
            );
            assert_eq!(first_health.state, WatchState::Stale);
            assert_eq!(service.status(), Some(first_health));

            let follow_up_checkpoint = service.checkpoint(root.path()).unwrap();
            let follow_up = Workspace::scan(
                root.path(),
                FilterPolicy::default(),
                BTreeMap::new(),
                BTreeSet::new(),
                &AtomicBool::new(false),
            )
            .unwrap();
            scan_count.fetch_add(1, Ordering::SeqCst);
            assert_eq!(scan_count.load(Ordering::SeqCst), 2);
            assert!(
                follow_up
                    .view(1)
                    .entries
                    .iter()
                    .any(|entry| entry.path == "after.ts")
            );
            let watching = service
                .revalidated(root.path(), 3, Some(follow_up_checkpoint))
                .unwrap();
            assert_eq!(watching.state, WatchState::Watching);
            assert_eq!(service.status(), Some(watching));
            follow_up
        });

        assert!(
            follow_up_candidate
                .view(1)
                .entries
                .iter()
                .any(|entry| entry.path == "after.ts")
        );
    }

    #[test]
    fn runtime_failure_reports_unavailable_and_manual_refresh_restarts_watching() {
        let root = tempfile::tempdir().unwrap();
        let service = WatchService::new(|_| {});
        let watching = service.activate(root.path(), 1).unwrap();

        let unavailable = apply_signal(
            &service.state,
            watching.epoch,
            WatchSignal::RuntimeError("synthetic backend failure".into()),
        )
        .unwrap();
        (service.publish)(unavailable.clone());
        assert_eq!(unavailable.state, WatchState::Unavailable);
        assert_eq!(service.status(), Some(unavailable.clone()));

        let recovered = service.revalidated(root.path(), 2, None).unwrap();
        assert_eq!(recovered.state, WatchState::Watching);
        assert!(recovered.epoch > unavailable.epoch);
        assert!(recovered.revision > unavailable.revision);
        assert_eq!(service.status(), Some(recovered));
    }

    #[test]
    fn simulated_runtime_failure_stops_the_watcher_until_manual_recovery() {
        let root = tempfile::tempdir().unwrap();
        let service = WatchService::new(|_| {});
        let watching = service.activate(root.path(), 1).unwrap();

        let unavailable = service.fail_for_test().unwrap();
        assert_eq!(unavailable.state, WatchState::Unavailable);
        assert_eq!(service.status(), Some(unavailable.clone()));
        assert!(service.state.lock().unwrap().worker.is_none());

        fs::write(root.path().join("changed.txt"), "changed").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(service.status(), Some(unavailable));

        let recovered = service.revalidated(root.path(), 2, None).unwrap();
        assert_eq!(recovered.state, WatchState::Watching);
        assert!(recovered.epoch > watching.epoch);
    }

    #[test]
    fn replacing_root_stops_old_watcher_and_deduplicates_dirty_health() {
        let roots = tempfile::tempdir().unwrap();
        let old_root = roots.path().join("old");
        let new_root = roots.path().join("new");
        fs::create_dir(&old_root).unwrap();
        fs::create_dir(&new_root).unwrap();
        let (published, events) = mpsc::channel();
        let service = WatchService::new(move |health| published.send(health).unwrap());

        let old_health = service.activate(&old_root, 1).unwrap();
        let new_health = service.activate(&new_root, 2).unwrap();
        assert!(new_health.epoch > old_health.epoch);
        reconcile_startup_hints(&service, &new_root, 2);
        let watching = service.status().unwrap();
        assert_eq!(watching.state, WatchState::Watching);
        while events.try_recv().is_ok() {}

        fs::write(old_root.join("ignored.txt"), "old root").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(service.status(), Some(watching.clone()));
        assert!(events.try_recv().is_err());

        fs::write(new_root.join("current.txt"), "new root").unwrap();
        let dirty = events.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(dirty.root, new_root.to_string_lossy());
        assert_eq!(dirty.state, WatchState::Stale);
        fs::write(new_root.join("current.txt"), "more content").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            events.try_recv().is_err(),
            "repeated filesystem events should not flood health updates"
        );
    }

    #[test]
    fn delayed_refresh_from_an_older_generation_cannot_replace_the_active_root() {
        let roots = tempfile::tempdir().unwrap();
        let old_root = roots.path().join("old");
        let new_root = roots.path().join("new");
        fs::create_dir(&old_root).unwrap();
        fs::create_dir(&new_root).unwrap();
        let service = WatchService::new(|_| {});

        service.activate(&old_root, 4).unwrap();
        let current = service.activate(&new_root, 8).unwrap();
        let delayed = service.revalidated(&old_root, 7, None).unwrap();

        assert_eq!(delayed, current);
        assert_eq!(service.status(), Some(current));
    }

    #[test]
    fn watches_recursive_tempdir_for_create_modify_delete() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("nested")).unwrap();
        let watcher = WorkspaceWatcher::start(root.path()).expect("watcher startup should succeed");
        let path = root.path().join("nested/change.ts");

        for (operation, write_content) in [
            ("create", Some("first")),
            ("modify", Some("modified content")),
            ("delete", None),
        ] {
            if let Some(content) = write_content {
                fs::write(&path, content).unwrap();
            } else {
                fs::remove_file(&path).unwrap();
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut received = false;
            while Instant::now() < deadline {
                if matches!(
                    watcher.recv_timeout(Duration::from_millis(100)),
                    Ok(WatchSignal::Changed | WatchSignal::FullReconcile)
                ) {
                    received = true;
                    break;
                }
            }
            assert!(
                received,
                "filesystem {operation} did not trigger reconciliation"
            );
        }

        drop(watcher);
    }

    #[test]
    fn recursive_read_activity_does_not_invalidate_but_writes_do() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("preview.txt");
        fs::write(&path, "preview content").unwrap();
        let watcher = WorkspaceWatcher::start(root.path()).expect("watcher startup should succeed");
        drain_startup_hints(&watcher);

        assert_eq!(fs::read_to_string(&path).unwrap(), "preview content");
        assert_eq!(
            watcher.recv_timeout(Duration::from_millis(750)),
            Err(mpsc::RecvTimeoutError::Timeout),
            "read-only preview activity must not mark the workspace stale"
        );

        fs::write(&path, "changed content").unwrap();
        assert!(matches!(
            watcher.recv_timeout(Duration::from_secs(5)),
            Ok(WatchSignal::Changed | WatchSignal::FullReconcile)
        ));
    }

    #[test]
    fn authoritative_workspace_scan_does_not_mark_its_own_reads_dirty() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/main.ts"), "export const value = 1;\n").unwrap();
        fs::write(root.path().join("README.md"), "# Scan fixture\n").unwrap();
        let watcher = WorkspaceWatcher::start(root.path()).expect("watcher startup should succeed");
        drain_startup_hints(&watcher);

        Workspace::scan(
            root.path(),
            FilterPolicy::default(),
            BTreeMap::new(),
            BTreeSet::new(),
            &AtomicBool::new(false),
        )
        .expect("workspace scan should succeed");
        assert_eq!(
            watcher.recv_timeout(Duration::from_millis(750)),
            Err(mpsc::RecvTimeoutError::Timeout),
            "enumerating and reading a workspace must not invalidate its own snapshot"
        );
    }
}
