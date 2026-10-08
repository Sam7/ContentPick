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

## Bounded-index repeat and large export

After adding raw enumeration/retained-text budgets, sharing index clones through Arc, and removing allocated hierarchy sort keys, the same optimized large benchmark passed: **537 ms scan, 3 ms view, 139 ms for 100 manifest reevaluations**, 20,002 indexed/enumerated. This repeat was run by the focused implementation agent; no new memory sample was taken for that scan.

Root ran `cargo +stable-x86_64-pc-windows-msvc build -p contextpick-core --example export_benchmark --release --locked`, then launched the resulting example and sampled its process every25ms. The example creates a disposable **128 MiB** synthetic source, previews it with the native256KiB limit, streams it to a separate output, verifies actual output length and unchanged source size, and removes its own fixture afterward.

| Measurement | Result |
|---|---:|
| Source bytes | 134,217,728 |
| Actual Markdown bytes | 134,217,787 |
| Export elapsed | 861 ms |
| Preview output | 262,144 bytes, truncated |
| Observed OS peak working set | 8,007,680 bytes (7.64 MiB) |
| Sampled peak private memory | 1,208,320 bytes (1.15 MiB) |

Windows x64, optimized Rust core, local disk. The scanner elapsed rounded to0ms for this single known-extension file. Measurements include fixture creation/cleanup in memory observation; export timing excludes creation. Sampling can miss a final interval, and this does not include WebView or Tauri process memory. It demonstrates bounded core streaming for this fixture, not a universal latency guarantee. The later local-error completeness fix does not change this export path.
