# Domain and boundaries

Workspace owns a canonical root and metadata index; relative path identity preserves OS spelling. Presentation paths use `/`; lossy non-UTF-8 names are rejected with an explicit diagnostic rather than colliding. Links/reparse points are hard rejected by default. Filesystem case is not inferred from OS name.

Selection is a pure evaluation of metadata/text eligibility, soft filter reason, and the nearest saved path intent. Hard rejection wins; nearest force include/exclude wins over soft filters; ordinary inclusion cannot bypass filters; no intent defaults to eligible inclusion. A descendant intent may override an ancestor intent; same-path replacement is the latest action. Directory state is derived from known descendants and records incomplete enumeration.

Scan records metadata and bounded samples, never eagerly reads complete source files. Ignored directories remain placeholders. Content classification is provisional until export validates decoding. Preview is capped; export freezes a sorted manifest, rechecks paths and metadata, writes literal UTF-8 with safe fences, then publishes atomically. Sources remain read-only.

Core modules own rules and I/O. Shell owns native picker, clipboard, task scheduling and local preferences location. UI owns disclosure, focus and current preview only. Typed DTOs carry decisions and reasons; frontend must not recreate selection rules.
