# Changelog

## 0.4.0 — 2026-08-30

The bridge release: the Unreal editor becomes this language's preview surface.

- **Drop-folder bridge** to a running Unreal editor (`Saved/DreamGUI/Bridge/`): heartbeat + pid
  liveness, ordered draining, crash-safe take-then-delete, every request answered.
- **`<-` / `->` function completion** — the class's bindable functions and handler candidates,
  asked of the editor that holds the per-Blueprint truth; cached a minute per class.
- **Nested-tag completion** — type `/` and every widget class offers itself: the asset registry's
  answer when the editor is up, the workspace's class lines when it is not.
- **Reveal in Unreal Designer** — opens the class's designer and selects the node under the
  cursor. **Compile This File** — saves, compiles, and the verdicts land in Problems.

## 0.3.0 — 2026-08-30

The workspace release.

- Workspace symbols, cross-file go-to-definition (nested tag → declaring class line), find
  references.
- **Rename that speaks the language**: F2 on a node id writes `(was: OldId)` so the next compile
  migrates references; renaming back removes it. Localization-key advice included.
- Extract literal → resource (one or all), extract properties → style, inline a worn style.
- **Compiler diagnostics live**: the editor writes `DUI/.dui-diagnostics.json` after every
  compile of a text-backed class; they appear in Problems beside the local checks.
- Hover and completion carry UPROPERTY tooltips and pasteable class defaults.

## 0.2.0 — 2026-08-30

The foundations release.

- The compiler's lexer, ported line for line (DUI1001–1005), and a token-driven structural layer
  raising the codes one file settles (2002/2003/2004/2006, 3001–3015 in part) at the compiler's
  own severities and wording.
- Colour chips with a style-preserving picker; semantic identity highlighting; token-accurate
  folding and smart selection; a language icon and a symbols status-bar item.
- Quickfixes (declare the unknown resource, create the unknown style) and a bundled explanation
  for every DUInnnn code.
- A real test rig: 90+ node tests, the TextMate grammar actually tokenized, a corpus sweep
  holding real project files to zero diagnostics.

## 0.1.0 — 2026-08-30

First shape: grammar, snippets, symbols-driven completion, hover, outline, go-to-definition and
the first diagnostics, all driven by the `.dui-symbols.json` the Unreal plugin exports.
