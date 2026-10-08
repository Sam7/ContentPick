# Resume

1. Read `AGENTS.md`, `STATUS.md`, and `docs/plans/active-m1.md`.
2. Run `git status --short` and inspect recent commits before edits.
3. Charter is `docs/PRODUCT_CHARTER.md`; do not duplicate it at root.
4. Node is at `C:\Program Files\nodejs`; prepend it to process PATH if needed.
5. MSVC now installed and Rust 1.99.0 under .tools. `. ./scripts/env.ps1` sets process paths; use MSVC for native builds.
6. Native Windows picker/preview/copy/save demonstrated: 10 files / 615 bytes; ignored sentinel absent. See docs/testing evidence.
7. Last core suite: 24 pass. Frontend before virtualisation: 12 component / 2 E2E pass. Browser fixture tests don't prove native behavior.
8. Frontend Luna owns src/package files (virtualisation, policy hydration, footer). Test Luna owns contract_fixtures.rs and benchmark.rs.
9. Root owns native/core integration: safe in-root export support + excluded output registry, long-fence bounds, persistence regression.
10. WorkspaceRoot pins selected directory; never reopen roots ambiently. Refresh uses scan_pinned.
11. Native dev session 64314 may still run with isolated CONTEXTPICK_CONFIG_DIR under .tools. HMR can interrupt smoke interactions.
12. Full checks/review/checkpoint then IPC paging/progressive scan, remaining P0 gaps. No macOS/installer/signing evidence. MVP not complete.
