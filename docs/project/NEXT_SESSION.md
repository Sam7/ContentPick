# Resume

1. Read AGENTS.md, STATUS.md, active-p0-hardening plan and Git status/log. Charter remains docs/PRODUCT_CHARTER.md.
2. Windows prerequisites installed with authorization. `. ./scripts/env.ps1`; use explicit stable-x86_64-pc-windows-msvc. Latest reviewed core suite59 tests, strict Clippy/fmt/native build pass. Frontend checkpoint18 RTL/5 browser E2E; paging currently underway, rerun after integration.
3. Native in-root export, preview and copy verified:10files673UTF8bytes, generated output blocked after refresh/relaunch, deep intent persisted. Screenshot/docs in docs/testing. User requested screenshot delivered; continue goal.
4. WorkspaceRoot pins source directory; never reopen ambient source root. Destination pins parent; in-root outputs new filenames only, persisted hard exclusions before publication, no-clobber hard link. Settings backup/save bounded4MiB; preserve original and blocksave on backupfailure.
5. Next: bounded IPC pages (512entries/256KiB serialized message), cached generation snapshots, stale offsets/generations rejected. Root native; Luna toolchain frontend bridge/App/tests. Verify actual 20k native transfer, then native ignore/force/recovery journeys and remaining fault fixtures.
6. Clipboard preflight sum overflow/final cancellation before clipboard write remain noticed followups. Scanner diagnostics/index memory budget needs explicit review; performance benchmark only measures core currently.
7. Agents: toolchain active frontend paging/longpathnotices; charter_contract released prefs; core_security_review released latest core review. Reuse agents with disjoint ownership.
8. Native app closed before last build. Vite45064 may run. Launch debug binary with CONTEXTPICK_CONFIG_DIR=.tools/smoke-config for isolated synthetic checks; observe processes/windows fresh. Do not trust old UI handles.
9. Full P0 incomplete. No watcher/tokenizer/macOSexecution/installers/signing/remoteCI/publicpublishing evidence. Close M2 architecture gate before broad P1. Continue safe implementation, no routine approval request.
