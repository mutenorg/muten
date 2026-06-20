# Muten — VS Code language support

Full editor support for **`.muten`** files (the [Muten](../../README.md) AI-first framework):

- **Syntax highlighting** — generated from the language manifest, so it never drifts.
- **Live linting** — project-aware: on each keystroke it loads the parts, composes, and
  validates the whole app, underlining errors with a suggestion ("did you mean…?").
- **Smart autocomplete** — context-aware: primitives & control flow at node position,
  state after `@` (queries offer `.loading/.error/.data`), actions after `->`, style
  tokens inside `style(...)`, and the project's reusable parts with their signatures.
- **File icons** — the Muten icon for `.muten` (enable via *Preferences: File Icon Theme → Muten*).

## Commands
- **Muten: Lint active file** — lint on demand; results in *Output → Muten*.

The lint/autocomplete engine is bundled under `engine/` (a copy of the framework's
compiler, kept in sync by `tools/sync-engine.mjs`).
