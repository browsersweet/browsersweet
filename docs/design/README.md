# Design handoff

Keep visual implementation references here. Read the accepted specs first and,
when present, [the design brief](../DESIGN.md) before UI work. Specs define
behavior; boards and screenshots illustrate it. Flag disagreements rather than
silently changing the requirements.

## Contents

- [manifest.md](manifest.md): map boards and screenshots to specs, states,
  acceptance tests, platforms, viewport sizes, and capture dates.
- `boards/`: editable mockups and measurement references, not application code.
- `screenshots/`: reviewed visual targets and comparison captures. Label target
  versus actual captures, themes, accessibility variants, and sample content.
- Optional `tokens.json`: shared design values. Declare whether it is the
  authoritative source or an export from an existing theme, and document the
  generation direction. Do not maintain competing sources of truth.

Use project subdirectories when multiple surfaces need separate handoffs. Keep
assets sanitized and repository-owned; these files are not automatically public.
No lifecycle frontmatter is required here. Requirements belong in specs,
implementation work in plans, and durable choices in decisions.

Megamono seeds this structure without replacing existing files. It does not
compile tokens, port boards into components, or run visual comparisons for you.
