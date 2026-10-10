# Microsoft Store listing draft

Use this copy for the first English (United States) listing. Confirm all fields in Partner Center before submission. Microsoft requires a description and at least one screenshot, and recommends four or more desktop screenshots. Current screenshot files are 3046 × 1978 PNGs, under 1 MB each, meeting the documented desktop minimum.

## Listing fields

- **Product name:** ContextPick
- **Short description:** Choose files from a local project and combine them into one readable Markdown context file for the AI assistant you already use.
- **Description:**

  ContextPick helps you prepare useful project context without collecting files one at a time. Choose a local repository or document folder, review its searchable file tree, and select the files that belong in your context.

  ContextPick respects `.gitignore`, lets you include all supported text files or limit the selection by extension, and explains why files are included, ignored, or excluded. Preview text files before export and see estimated file count, output size, and token count.

  Export the selected content as one organized Markdown file, copy it to your clipboard, or configure a fixed output folder for repeat use. The result is tool-agnostic: use it with ChatGPT, Claude, Gemini, or another service that accepts text files.

  ContextPick runs locally. It has no account requirement, telemetry, cloud processing, or source upload. Project files are read-only; review the generated content before sharing it with another service. Service upload rules and context limits still apply.

- **Features** (one item per field; no manual bullets):
  - Combine selected project files into one organized Markdown export.
  - Browse and search a large local project with a virtualized file tree.
  - Respect `.gitignore` and explain file selection states.
  - Preview text files and check estimated output size and token count.
  - Copy context or export it to a chosen file or fixed folder.
  - Keep source files local and unchanged; no account or telemetry.
- **Search keywords:** project files; code context; Markdown export; repository browser; AI context; source file selection; local file export
- **Website:** https://sam7.github.io/ContentPick/
- **Support:** https://github.com/Sam7/ContentPick/issues
- **Privacy policy:** https://sam7.github.io/ContentPick/#privacy
- **What's new:** Leave blank for the first Store submission.
- **Copyright/trademark:** `© 2026 DotSam` (confirm publisher's preferred legal display).
- **License terms:** Leave blank to use Microsoft's Standard Application License Terms. This is a Store purchase license choice; the open-source license remains in the repository.
- **Age rating and audience declarations:** Complete truthfully in Partner Center; the owner must answer the questionnaire.
- **Supported device family:** Windows Desktop only. Do not enable Xbox or HoloLens.
- **Minimum OS:** Windows 11 25H2 (`10.0.26200.0`) per the approved Store scope.

## Desktop screenshots

Upload these in order and use the captions below. They are captured from the Store-identity installed app against the ContextPick repository, with its real nested project tree. They are UI evidence, not a claim of Store certification.

| File | Caption |
|---|---|
| [`store-assets/01-workspace-and-preview.png`](store-assets/01-workspace-and-preview.png) | Browse a real project tree, search files, and preview source text before export. |
| [`store-assets/02-selected-files.png`](store-assets/02-selected-files.png) | Review the selected project files and understand what will be included. |
| [`store-assets/03-extension-filters.png`](store-assets/03-extension-filters.png) | Include supported text files or narrow the selection to useful extensions. |
| [`store-assets/04-export-settings.png`](store-assets/04-export-settings.png) | Check export settings, output size, token estimate, and destination options. |

## Submission boundary

The package identity is `DotSam.ContextPick`, publisher `CN=9CF819D8-048A-42F9-91C4-E85E76577891`, Store ID `9NJ3T87DK1SJ`. These values identify the reserved app; they do not indicate a submission. Upload the reviewed, unsigned x64 MSIX in Partner Center, then record the submission/certification status separately from local build and WACK results. Do not publish until Microsoft accepts the first submission.

## Current Microsoft references

- [MSIX Store listing fields](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info): description limit 10,000 characters, feature limit 200 characters each, up to 20 features; one screenshot required, four or more recommended.
- [MSIX screenshots and images](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images): desktop PNG screenshots must be at least 1366 × 768 and no larger than 50 MB; captions may be up to 200 characters.
- [MSIX additional listing information](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-additional-information): up to seven keywords, 40 characters each and 21 words total.
