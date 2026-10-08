# Resume

1. Read AGENTS.md, STATUS.md and `docs/plans/active-p0-hardening.md`; inspect git status/log before editing. Charter: `docs/PRODUCT_CHARTER.md`.
2. Windows MSVC Build Tools installed with user authorization; Rust1.99 and Node24 available. `. ./scripts/env.ps1` changes only process environment. Use explicit MSVC toolchain for native work.
3. Latest workspace suite: 39 Rust tests (36 core, 3 shell); 15 RTL and 3 browser E2E pass. Browser fixtures do not prove native filesystem behavior. Check STATUS for final clippy result.
4. Native folder/preview/copy/save demonstrated on ten-file fixture (615 bytes before language-tag update). Recent root restored on restart; user-requested screenshot is in docs/testing. Native manual selection/filter/error journeys remain.
5. WorkspaceRoot pins the selected directory. Never reopen its path ambiently. Refresh uses scan_pinned. Root owns native/core integration and commits.
6. Next: safe in-root export with persistent hard exclusions; bounded IPC pages; remaining acceptance fixtures/native journeys; broader M2 review. Arbitrarily long fences and folder ordering are now fixed/tested.
7. In-root design review: pin parent with single-component nofollow opens; reserve/persist output before writing; reserved temporary prefix; publish new in-root file via no-clobber hard link, never replacing an existing workspace path. Bind reservation to captured root/generation. Outside-root explicit overwrite remains supported. Implementation pending.
8. Benchmark20k sources +100k ignored actual files: scan440–910ms, enumerate20,002; observed core peak working set12.8MiB. See performance evidence and limits; repeat after indexing changes.
9. HMR session64314 ended. Vite45064 and last built native binary may run using .tools/smoke-config. Observe actual processes/ports before restarting. Avoid hot-reload rebuilds during native UI automation.
10. Reuse Luna agents charter_contract/toolchain for focused implementation and Sol core_security_review for independent review, with disjoint ownership. No agents should be editing currently.
11. No macOS, installer/signing or remote CI execution evidence. No public publishing authorized. Full P0 and release readiness remain incomplete; continue safe work autonomously.
