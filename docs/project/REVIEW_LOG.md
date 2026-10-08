# Reviews

2026-10-08: charter/environment exploration delegated to Luna.

## M1 correctness / M2 architecture — 2026-10-08

Independent GPT-6.1 Sol review; supplementary Luna review and root reproduction. One pure selection evaluator and proportionate core/shell/UI boundaries confirmed; full gate is not yet closed.

| Severity | Finding | Disposition/evidence |
|---|---|---|
| High | Root path reopen could redirect later reads | Pinned capability; preview/export/refresh share it; Windows regression passes (handle prevents rename on host) |
| High | Forced child discovery lost custom parent exclusion | Inherited soft reasons/targeted traversal; regression failed with two files before fix, passes with only forced file |
| High | Policy editor not hydrated from saved settings | Fixed; policy echoed in view and 15-test RTL suite includes hydration regression |
| High | Persistence error could leave backend/UI diverged | Fixed; persist candidate before publication; native failed-save regression passes |
| Medium | Incomplete directory's own status omitted from partial state | Fixed; force-discovery test asserts incomplete+partial |
| Medium | Default native window clipped export controls | Fixed; persistent footer; 3 browser E2E include compact layout; native screenshot captured after restart |

Validation at initial checkpoint: 30 core + 3 native shell tests, 15 RTL + 3 browser E2E passed; native picker/preview/copy/file export demonstrated. No macOS host. Performance measurements now recorded separately; remaining P0 breadth and IPC work pending. Not release signoff.

## In-root export design review

Independent Sol read-only review recommends pinned, nofollow destination parent; atomic no-clobber hard-link publication for new in-root output; no replacement of existing in-root paths; persisted final-output reservation and reserved temporary prefix; reservation bound to captured root/generation. Implemented and tested. Subsequent reviews fixed cancellation after flush, post-publication cleanup semantics, canonical case spelling, and a stale canonicalization/junction replacement race. Deterministic race regression passes; final Sol source review found no material findings.59 Rust tests, strict Clippy/fmt/native build green. Native in-root output and repeated copy/relaunch verified separately.

## Recovery and visible outcomes

Luna implemented bounded settings recovery. Root review found unbounded backup copying; bounded to4MiB+1/16name attempts, reject oversized originals. Independent Sol review found oversized saves could create unloadable settings; shared4MiB limited writer and prior-file-preservation test fix this. Native save-block regression observed RED then GREEN. Recovery wording now correctly distinguishes blocked manual recovery. Final core source review closed.

Native smoke found successful outcome hidden in a clipped live region. Luna made it visible; independent review then found errors behind footer and narrow notice overlap. Shared notice/footer dock fixes both; actual browser geometry test observed RED then GREEN (18RTL/5E2E checkpoint). Long unbroken paths need wrapping; included in upcoming frontend paging slice. Search-revealed folders now announce actual expansion and preserve prior disclosure state. Raw filter drafts fix commas being lost during typing; extensionless sentinel supported and tested.

## Folder ordering and bounded fences slice

Independent Sol diff review: no remaining material findings. Found cancellation missing during unbounded fence emission; fixed with checks every 4 KiB and deterministic writer-triggered cancellation regression. Reviewer independently ran 13 workspace/Git fixture tests. Root ran 39 workspace Rust tests, formatting and strict clippy; frontend typecheck/lint/build, 15 RTL and 3 browser E2E all passed. Long-fence/tag and folder-order tests were observed RED before implementation. Native screenshot uses the previous successful binary; current core behavior is proven by automated tests, not that screenshot.
