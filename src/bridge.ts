import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type WatchHealth = {
  root: string;
  epoch: number;
  revision: number;
  state: 'watching' | 'stale' | 'unavailable';
  message: string | null;
};

export type Entry = {
  path: string;
  kind: 'directory' | 'file' | 'blocked';
  size: number;
  selected: boolean;
  forceIncluded: boolean;
  gitIgnored: boolean;
  reason: string | null;
  enumerated: boolean;
  partial: boolean;
};

export type WorkspaceView = {
  root: string;
  generation: number;
  entries: Entry[];
  entryCount: number;
  nextOffset: number | null;
  selectedCount: number;
  estimatedBytes: number;
  policy: FilterPolicy;
  profileCatalog: ProfileCatalog;
  incomplete: boolean;
  diagnostics: string[];
};

export type ProfileCatalog = {
  root: string;
  generation: number;
  names: string[];
  activeProfile: string | null;
};

export type WorkspacePage = {
  root: string;
  generation: number;
  offset: number;
  entries: Entry[];
  nextOffset: number | null;
};

export type SelectionIntent = 'include' | 'exclude' | 'forceInclude' | 'forceExclude' | null;

export type FilterPolicy = {
  gitignore: boolean;
  includeExtensions: string[];
  includePaths: string[];
  excludePaths: string[];
};

export type Preview = { text: string; truncated: boolean };
export type ExportResult = { bytes: number; files: number; destination: string };
export type SensitiveWarning = {
  path: string;
  category: 'environmentFile' | 'pemMaterial' | 'privateKey' | 'credentialFile';
};
export type SensitiveWarningSummary = { total: number; omitted: number; warnings: SensitiveWarning[] };
export type OutputResponse = ExportResult | null | {
  confirmationRequired: true;
  ticket: string;
  summary: SensitiveWarningSummary;
};
export type TokenEstimate = {
  requestId: string;
  generation: number;
  tokens: number;
  files: number;
  reusedFiles: number;
  computedFiles: number;
  tokenizerId: string;
};

export type ContextPickBridge = {
  get_watch_status(): Promise<WatchHealth | null>;
  on_watch_status(handler: (health: WatchHealth) => void): Promise<() => void>;
  on_window_focus(handler: () => void): Promise<() => void>;
  request_focus_reconcile(root: string): Promise<WatchHealth | null>;
  restore_workspace(): Promise<WorkspaceView | null>;
  choose_workspace(): Promise<WorkspaceView | null>;
  refresh_workspace(): Promise<WorkspaceView>;
  browse_ignored(args: { path: string }): Promise<WorkspaceView>;
  set_intent(args: { path: string; intent: SelectionIntent }): Promise<WorkspaceView>;
  reset_selections(): Promise<WorkspaceView>;
  set_policy(args: { policy: FilterPolicy }): Promise<WorkspaceView>;
  create_profile(args: { name: string }): Promise<ProfileCatalog>;
  update_profile(args: { name: string }): Promise<ProfileCatalog>;
  rename_profile(args: { currentName: string; newName: string }): Promise<ProfileCatalog>;
  delete_profile(args: { name: string }): Promise<ProfileCatalog>;
  load_profile(args: { name: string }): Promise<WorkspaceView>;
  workspace_page(args: { generation: number; offset: number }): Promise<WorkspacePage>;
  preview_file(args: { path: string }): Promise<Preview>;
  estimate_tokens(args: { generation: number; requestId: string }): Promise<TokenEstimate>;
  cancel_token_estimate(args: { generation: number; requestId: string }): Promise<void>;
  export_markdown(): Promise<OutputResponse>;
  copy_markdown(): Promise<OutputResponse>;
  confirm_sensitive_output(args: { ticket: string }): Promise<ExportResult | null>;
  cancel_sensitive_output(args: { ticket: string }): Promise<boolean>;
  cancel_operation(): Promise<WorkspaceView | null>;
};

const nativeBridge: ContextPickBridge = {
  get_watch_status: () => invoke('get_watch_status'),
  on_watch_status: async (handler) => listen<WatchHealth>('watch-status', (event) => handler(event.payload)),
  on_window_focus: async (handler) => listen<void>('window-focus', handler),
  request_focus_reconcile: (root) => invoke('request_focus_reconcile', { root }),
  restore_workspace: () => invoke('restore_workspace'),
  choose_workspace: () => invoke('choose_workspace'),
  refresh_workspace: () => invoke('refresh_workspace'),
  browse_ignored: (args) => invoke('browse_ignored', args),
  set_intent: (args) => invoke('set_intent', args),
  reset_selections: () => invoke('reset_selections'),
  set_policy: (args) => invoke('set_policy', args),
  create_profile: (args) => invoke('create_profile', args),
  update_profile: (args) => invoke('update_profile', args),
  rename_profile: (args) => invoke('rename_profile', args),
  delete_profile: (args) => invoke('delete_profile', args),
  load_profile: (args) => invoke('load_profile', args),
  workspace_page: (args) => invoke('workspace_page', args),
  preview_file: (args) => invoke('preview_file', args),
  estimate_tokens: (args) => invoke('estimate_tokens', args),
  cancel_token_estimate: (args) => invoke('cancel_token_estimate', args),
  export_markdown: () => invoke('export_markdown'),
  copy_markdown: () => invoke('copy_markdown'),
  confirm_sensitive_output: (args) => invoke('confirm_sensitive_output', args),
  cancel_sensitive_output: (args) => invoke('cancel_sensitive_output', args),
  cancel_operation: () => invoke('cancel_operation'),
};

const fixtureWorkspace: WorkspaceView = {
  root: '/workspace/patchwork',
  generation: 1,
  entries: [
    { path: 'src', kind: 'directory', size: 0, selected: true, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false },
    { path: 'src/main.ts', kind: 'file', size: 1540, selected: true, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false },
    { path: 'src/main.generated.ts', kind: 'file', size: 512, selected: false, forceIncluded: false, gitIgnored: false, reason: 'custom exclude (*.generated.ts)', enumerated: true, partial: false },
    { path: 'src/components', kind: 'directory', size: 0, selected: true, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false },
    { path: 'src/components/Picker.tsx', kind: 'file', size: 1830, selected: true, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false },
    { path: 'assets', kind: 'directory', size: 0, selected: false, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false },
    { path: 'assets/logo.png', kind: 'file', size: 12_480, selected: false, forceIncluded: false, gitIgnored: false, reason: 'Binary image', enumerated: true, partial: false },
    { path: 'dist', kind: 'directory', size: 0, selected: false, forceIncluded: false, gitIgnored: true, reason: '.gitignore (dist/)', enumerated: false, partial: false },
    { path: 'README.md', kind: 'file', size: 923, selected: true, forceIncluded: false, gitIgnored: false, reason: null, enumerated: true, partial: false },
  ],
  entryCount: 9,
  nextOffset: null,
  selectedCount: 3,
  estimatedBytes: 6240,
  policy: { gitignore: true, includeExtensions: [], includePaths: [], excludePaths: [] },
  profileCatalog: { root: '/workspace/patchwork', generation: 1, names: ['Documentation', 'Rust'], activeProfile: 'Rust' },
  incomplete: true,
  diagnostics: [],
};

const fixturePreviews: Record<string, Preview> = {
  'src/main.ts': { text: "import { mount } from './ui';\n\nmount(document.getElementById('root'));\n", truncated: false },
  'src/components/Picker.tsx': { text: 'export function Picker() {\n  return <button>Choose a folder</button>;\n}\n', truncated: false },
  'README.md': { text: '# Patchwork\n\nA tiny demo repository for exploring ContextPick.\n', truncated: false },
};

const fixtureReadmeExcluded: WorkspaceView = {
  ...fixtureWorkspace,
  entries: fixtureWorkspace.entries.map((entry) => entry.path === 'README.md' ? { ...entry, selected: false } : { ...entry }),
  selectedCount: 2,
  estimatedBytes: 5317,
};

const fixtureGeneratedForced: WorkspaceView = {
  ...fixtureWorkspace,
  entries: fixtureWorkspace.entries.map((entry) => entry.path === 'src/main.generated.ts' ? { ...entry, selected: true, forceIncluded: true, reason: null } : { ...entry }),
  selectedCount: 4,
  estimatedBytes: 6752,
};

export type BrowserBridgeOptions = { cancelPicker?: boolean; failExport?: boolean; failPreview?: boolean };

/** Static, synthetic responses for UI development. This deliberately contains no selection/filter policy. */
export function createBrowserBridge(options: BrowserBridgeOptions = {}): ContextPickBridge {
  const profileCatalog = structuredClone(fixtureWorkspace.profileCatalog);
  let workspaceGeneration = fixtureWorkspace.generation;
  const withCatalog = (view: WorkspaceView): WorkspaceView => ({
    ...structuredClone(view),
    generation: workspaceGeneration,
    profileCatalog: { ...structuredClone(profileCatalog), generation: workspaceGeneration },
  });
  const profileResponse = (): ProfileCatalog => ({ ...structuredClone(profileCatalog), generation: workspaceGeneration });
  const currentWorkspace = () => withCatalog(fixtureWorkspace);
  const watchHealth: WatchHealth = {
    root: fixtureWorkspace.root,
    epoch: 1,
    revision: 1,
    state: 'watching',
    message: null,
  };
  return {
    get_watch_status: async () => watchHealth,
    on_watch_status: async () => () => {},
    on_window_focus: async () => () => {},
    request_focus_reconcile: async () => null,
    restore_workspace: async () => null,
    choose_workspace: async () => options.cancelPicker ? null : currentWorkspace(),
    refresh_workspace: async () => currentWorkspace(),
    set_intent: async ({ path, intent }) => {
      profileCatalog.activeProfile = null;
      if (path === 'README.md' && (intent === 'exclude' || intent === 'forceExclude')) return withCatalog(fixtureReadmeExcluded);
      if (path === 'src/main.generated.ts' && intent === 'forceInclude') return withCatalog(fixtureGeneratedForced);
      return currentWorkspace();
    },
    reset_selections: async () => { profileCatalog.activeProfile = null; return currentWorkspace(); },
    set_policy: async () => { profileCatalog.activeProfile = null; return currentWorkspace(); },
    create_profile: async ({ name }) => {
      const normalized = name.trim();
      if (!normalized) throw new Error('profile name cannot be empty');
      if (profileCatalog.names.includes(normalized)) throw new Error(`a profile named ${JSON.stringify(normalized)} already exists`);
      if (profileCatalog.names.length >= 20) throw new Error('a workspace can contain at most 20 profiles');
      profileCatalog.names = [...profileCatalog.names, normalized].sort();
      profileCatalog.activeProfile = normalized;
      return profileResponse();
    },
    update_profile: async ({ name }) => {
      if (!profileCatalog.names.includes(name)) throw new Error(`profile ${JSON.stringify(name)} does not exist`);
      profileCatalog.activeProfile = name;
      return profileResponse();
    },
    rename_profile: async ({ currentName, newName }) => {
      const normalized = newName.trim();
      if (!profileCatalog.names.includes(currentName)) throw new Error(`profile ${JSON.stringify(currentName)} does not exist`);
      if (!normalized) throw new Error('profile name cannot be empty');
      if (normalized !== currentName && profileCatalog.names.includes(normalized)) throw new Error(`a profile named ${JSON.stringify(normalized)} already exists`);
      profileCatalog.names = profileCatalog.names.map((name) => name === currentName ? normalized : name).sort();
      if (profileCatalog.activeProfile === currentName) profileCatalog.activeProfile = normalized;
      return profileResponse();
    },
    delete_profile: async ({ name }) => {
      if (!profileCatalog.names.includes(name)) throw new Error(`profile ${JSON.stringify(name)} does not exist`);
      profileCatalog.names = profileCatalog.names.filter((profile) => profile !== name);
      if (profileCatalog.activeProfile === name) profileCatalog.activeProfile = null;
      return profileResponse();
    },
    load_profile: async ({ name }) => {
      if (!profileCatalog.names.includes(name)) throw new Error(`profile ${JSON.stringify(name)} does not exist`);
      profileCatalog.activeProfile = name;
      workspaceGeneration += 1;
      return currentWorkspace();
    },
    workspace_page: async () => { throw new Error('The browser fixture does not paginate workspaces.'); },
    preview_file: async ({ path }) => {
      if (options.failPreview) throw new Error('Preview could not be read.');
      return fixturePreviews[path] ?? { text: '', truncated: false };
    },
    estimate_tokens: async ({ generation, requestId }) => ({
      requestId,
      generation,
      tokens: 1_234,
      files: fixtureWorkspace.selectedCount,
      reusedFiles: 0,
      computedFiles: fixtureWorkspace.selectedCount,
      tokenizerId: 'o200k_base',
    }),
    cancel_token_estimate: async () => {},
    browse_ignored: async ({ path }) => {
      if (path !== 'dist') return currentWorkspace();
      return {
        ...currentWorkspace(),
        entries: [
          ...structuredClone(fixtureWorkspace.entries).map((entry) => entry.path === 'dist' ? { ...entry, enumerated: true } : entry),
          { path: 'dist/report.md', kind: 'file', size: 404, selected: false, forceIncluded: false, gitIgnored: true, reason: '.gitignore (dist/)', enumerated: true, partial: false },
        ],
        entryCount: fixtureWorkspace.entryCount + 1,
        incomplete: false,
      };
    },
    export_markdown: async () => {
      if (options.failExport) throw new Error('The fixture export failed.');
      return { destination: '/workspace/patchwork/context.md', bytes: 6240, files: 3 };
    },
    copy_markdown: async () => ({ destination: 'clipboard', bytes: 6240, files: 3 }),
    confirm_sensitive_output: async () => ({ destination: 'clipboard', bytes: 6240, files: 3 }),
    cancel_sensitive_output: async () => true,
    cancel_operation: async () => currentWorkspace(),
  };
}

export function getBridge(): { bridge: ContextPickBridge; fixtureMode: boolean } {
  return isTauri()
    ? { bridge: nativeBridge, fixtureMode: false }
    : { bridge: createBrowserBridge(), fixtureMode: true };
}
