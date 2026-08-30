# Changelog

## 0.5.0 — 2026-08-30

The language grew; the extension keeps up. Lexer and mirror track the compiler's 2026-08-30
grammar (gap-closure batch), commit-for-commit.

- **Binding expressions**: `<-` takes operators (`! == != < <= > >= && || + - * %`), calls with
  arguments, bare variables and dotted `Item.Member` — all highlighted, every call coloured as a
  function and every bare name as a variable. Inside an `each` body, `Item.Member`'s first
  segment colours as the loop parameter it uses. A `-` after an operand is subtraction now;
  `a < -1` compares (the space matters — `a <-1` is still an arrow, exactly as the compiler
  reads it).
- **Two-way `<->`**: its own token, operator scope and property form; the right side colours as
  the variable it is. After `Value <-> ` the bridge stays silent instead of offering functions —
  the right side is a variable, and a wrong list is worse than none.
- **`use "path"` imports**: keyword + path highlighting, recorded by the structure layer
  (`imports`), and F12 on the spelling opens the imported file when exactly one workspace file
  matches it, segment-aligned. `use` is a reserved word now (DUI3002 knows).
- **Loop sources both ways**: `each Row in GetRows()` calls, `each Item in Rows` reads a
  FieldNotify-able variable — header highlighting distinguishes them.
- **Code table**: DUI2011/2012/5011/5012 explained in Chinese; 2005/2010/3002/5004/5007
  refreshed to the new grammar (each landed; for still pending).
- Snippets: `bind2`, `each`, `use`; `bind`'s "every frame" description retired — bindings are
  event-driven now.

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
