# Reviews

2026-10-08: charter/environment exploration delegated to Luna.

## M1 correctness / M2 architecture — 2026-10-08

Independent GPT-6.1 Sol review; supplementary Luna review and root reproduction. One pure selection evaluator and proportionate core/shell/UI boundaries confirmed; full gate is not yet closed.

| Severity | Finding | Disposition/evidence |
|---|---|---|
| High | Root path reopen could redirect later reads | Pinned capability; preview/export/refresh share it; Windows regression passes (handle prevents rename on host) |
| High | Forced child discovery lost custom parent exclusion | Inherited soft reasons/targeted traversal; regression failed with two files before fix, passes with only forced file |
| High | Policy editor not hydrated from saved settings | Policy echoed in view; frontend regression/fix underway |
| High | Persistence error could leave backend/UI diverged | Persist candidate before publication; force/reset candidate scan; native regression pending |
| Medium | Incomplete directory's own status omitted from partial state | Fixed; force-discovery test asserts incomplete+partial |
| Medium | Default native window clipped export controls | Observed native screenshot; frontend persistent footer fix underway |

Validation: MSVC core suite 24 passes; native picker/preview/copy/file export demonstrated. No macOS host, broader fixtures/performance and native failure tests pending. Not release signoff.
