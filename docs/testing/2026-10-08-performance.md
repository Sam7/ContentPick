# Windows core benchmark — 2026-10-08

Command: `. ./scripts/env.ps1; cargo +stable-x86_64-pc-windows-msvc run -p contextpick-core --example benchmark --release -- --large`.

Synthetic fixture: 20,000 Rust source files and 100,000 actual files spread across 100 ignored child directories. The `.gitignore` itself is eligible. Temporary fixture removed by the example after measurement. Windows x64, Rust 1.99.0 optimized build, local disk.

| Run | Scan | Build view | 100 manifest reevaluations | Enumerated / indexed |
|---|---:|---:|---:|---:|
| Initial | 440 ms | 3 ms | 141 ms | 20,002 |
| Repeat under concurrent build load | 910 ms | 5 ms | 428 ms | 20,002 |
| Memory observation | 510 ms | 3 ms | 142 ms | 20,002 |

All runs assert ignored-subtree pruning and exactly 20,002 enumerated entries. Fixture creation took 23.8–29.8 seconds and is excluded from scan time.

For the final run a PowerShell parent sampled the benchmark process every 50 ms using Process.Refresh(). Observed OS peak working set: **13,426,688 bytes (12.8 MiB)**. Sampled peak private memory: **11,751,424 bytes (11.2 MiB)**. These include fixture generation and cleanup. The first measurement attempted to read process memory after exit and returned null; it is not used as evidence. Sampling can miss the final interval and is not a hard memory guarantee.

Limits: this measures Rust core before subsequent folder-order changes. It does not measure WebView memory, Tauri serialization, IPC paging, UI latency or macOS. Repeat after changes that affect indexing. The separate browser tests demonstrate bounded rendered DOM for 10,000 entries; they are synthetic UI tests.
