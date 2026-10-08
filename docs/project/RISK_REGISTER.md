# Current risks

- **M2 remains open.** The current worktree contains a fix for the reproduced valid 200 kB custom-glob panic and explicit rule limits, but it needs full regression/review. Sol found recursive copies of ancestor `.gitignore` matchers can multiply retained pattern text to roughly 1 GiB for a bounded depth-128 fixture (128 × 64 KiB source files). No such giant repro was run. Use shared matcher ownership and cumulative ignore-input limits; test with an injected small budget.
- **P0/M3 remains incomplete.** The 20k actual native paging/search smoke predates cancellation reconciliation. Current native Playwright covers 605 real entries, not the final 20k timing/cancel/process-tree memory gate. Keep scale and whole-app memory claims scoped to existing evidence.
- **Legacy filter state needs migration.** Settings version 1 persists active `excludeExtensions`. M3.5 must convert values to visible exclude-path rules transactionally, preserve originals on unrepresentable rules or failed backup, and prove idempotent restart behavior before removing the runtime field.
- **Platform/release evidence is Windows-only.** macOS runtime/build, remote CI, installers, signing/notarization and public release are not verified. Do not claim these gates complete.
- Credentials and public publishing are later release gates; they are not blockers for local implementation.
