# Current risks

- Windows compiler prerequisite resolved: user-authorized Visual Studio 2022 C++ Build Tools installed; native MSVC test, build and app smoke passed.
- P0 remains incomplete: bounded IPC transfer, complete contract/fault fixtures, native ignore/force/recovery and large workspace acceptance still need evidence. Safe in-root output/deep selection/relaunch are now verified. These are implementation tasks, not external blockers.
- Scanner has a 200,000-entry safety limit and 128-level depth limit. It reports incomplete state; performance evidence must distinguish enumerated entries from pruned files.
- macOS runtime/build/signing cannot be verified on this Windows host. Add CI; do not claim platform success without execution evidence.
- Credentials and public publishing are release gates, not permission to stop P0 implementation.
