# Native paged workspace — Windows, 2026-10-08

Disposable fixture `.tools/large-smoke`: **20,000 actual TypeScript source files** plus **100,000 actual ignored files** across 100 node_modules child directories. Root .gitignore excludes itself and node_modules/. Fixture generation took34,324ms, excluded from application timings. Isolated config `.tools/large-config` seeded with this recent root.

Actual MSVC Tauri debug binary, WebView2, localhost Vite. Native display reached **20,002 discovered /20,000 selected** with node_modules an unenumerated ignored placeholder. Initial view and subsequent pages used the real native bridge; each message is limited to512entries/256KiB serialized JSON by tested Rust adapter. A20k native unit fixture proves order and complete page coverage; no browser fixture substitution in this smoke.

At steady state, native accessibility exposed only16 tree rows near the beginning. Search `file-19999` revealed the final-page file; native preview displayed `export const value = 1;`. Count stayed20,000. [Screenshot](2026-10-08-native-large-ui.jpg).

Native parent process memory observation: working set45,031,424bytes; OS recorded peak49,152,000bytes; private15,003,648bytes. **This excludes WebView child processes** and is not a whole-application memory guarantee. Initial latency was not measured: automation observed after startup had already completed. Repeat timings and aggregate process-tree memory after final integration; do not infer sub-second load from this record.

Independent review then found cancellation reconciliation races. The running binary used the pre-reconciliation implementation for this smoke; the new native cancellation tests and frontend regressions must pass and be smoke-tested after rebuild. Diagnostic volume also needs a bounded header so malformed ignore files do not prevent opening an otherwise readable workspace.
