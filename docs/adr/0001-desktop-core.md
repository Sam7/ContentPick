# ADR 0001: Tauri shell and one Rust domain core

Date: 2026-10-08. Status: accepted for initial implementation.

Use Tauri 2, React/TypeScript/Vite and a small Rust workspace. The core owns safe discovery, selection, content, metrics and export; Tauri coordinates blocking work and dialogs; React renders typed results. No server or database is needed for a local file packaging tool.

Electron offers a simpler single-language boundary but adds a larger runtime and duplicates the charter's preferred core strategy. A browser-only app cannot meet native filesystem requirements. Use `ignore` instead of implementing Gitignore syntax.

Keep ordinary CSS initially; add a styling/component dependency only when it reduces actual repetition. Keep `.ignore`, global ignore and parent ignore disabled by documented default; Gitignore enabled, hidden files visible, links never followed. No speculative Codex config is installed: this runtime already supports explicit Luna/Sol subagent selection, and repository config cannot change the active root model.

Vendor references checked: https://v2.tauri.app/start/prerequisites/ ; https://v2.tauri.app/develop/calling-rust/ ; https://learn.chatgpt.com/docs/agent-configuration/subagents . Revisit stack only after a concrete native feasibility or performance finding.
