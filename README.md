# DreamUI Language Support

English | [简体中文](README.zh-CN.md)

Language support for DreamGUI `.dui` widget hierarchies.

## What it does

- **Syntax highlighting** for the whole grammar — binding expressions (`Enabled <- !IsBusy() &&
  Count() > 0`), the two-way arrow (`Value <-> Volume`), `use "…"` imports and both loop-source
  shapes included — plus **semantic highlighting** for identity: node ids render as the member
  variables they become, styles as classes, resources as readonly constants, `->` events and
  handlers, loop variables (`Item.Member` in an `each` body colours as the parameter it uses),
  calls as functions, bare names as variables, components.
- **Completion** for built-in tags, component classes, per-class properties, enum values, slot
  properties, resource types, `@` resource references and `->` event names.
- **Colour chips and a picker** on every `#hex` literal -- properties, styles and resources alike.
  The picker keeps your digit style (`#F00` stays short) and never rewrites an `@` reference.
- **Hover** with property types and enum values; **outline** of the widget tree, named slots,
  loops, styles and resources; **go to definition** for `@Name` and style uses; token-accurate
  **folding** (comment runs included) and **smart selection**.
- **Diagnostics** with the compiler's own codes and wording, at the compiler's own severities:
  the six lexical codes (DUI1001–1006), the structural ones a single file settles
  (DUI2002/2003/2004/2006/2013, 3001/3002/3004/3005/3008/3014/3015, and the rename-clause checks
  as warnings), plus symbol-driven checks. The compiler stays the authority — anything it might
  accept is a warning here at most, and the project's real files sweep clean by test.
- **Explanations**: every diagnostic offers an "解释 DUInnnn" action opening the bundled
  code-table entry — what it means, why it fired, how to fix it.
- **Quickfixes**: declare the unknown resource (DUI4007), create the unknown style (DUI3004).
- **A new-file command** ("DreamUI: New .dui File", also on a folder's context menu) writing the
  same starter the Unreal editor's "Create Source File..." writes — a root plus one centred
  label, so the first compile answers "did this work" by appearing.
- **A status bar item** showing whether symbols are loaded — a missing `.dui-symbols.json` is a
  visible warning with instructions, not a silent downgrade.
- **Workspace navigation**: Ctrl+T over every id, style and resource in every .dui; F12 on a
  nested `/Game/X` tag lands on the file whose class line declares it, and F12 on a `use "…"`
  spelling opens the imported file when exactly one workspace file matches it; find-references
  for styles, resources and class paths.
- **Rename (F2) that speaks the language**: styles and resources rename with every use; renaming
  a node id **writes the `(was: OldId)` clause** so the next compile migrates graph references,
  bindings and animations — and renaming back removes it. You are told when localization keys
  change and how `@key` pins the old ones.
- **Extract and inline**: a literal becomes an `@resource` (one occurrence or all of them),
  selected property lines become a style the node wears, a worn style inlines back
  base-first-derived-overriding.
- **Compiler diagnostics, live**: with the Unreal editor running, every compile of a text-backed
  class delivers its verdicts to `DUI/.dui-diagnostics.json`, and they appear in Problems as
  `dui-compiler` — the semantic layer (unknown properties, bad values, missing binding functions)
  beside the grammar-level checks, without this extension growing a second compiler. Hover shows
  UPROPERTY tooltips and pasteable class defaults from the widened symbols dump.
- **A bridge to the running editor**: `<-` and `->` completion ask the editor what the class
  really declares; typing `/` offers every nestable widget class (asset registry when the editor
  is up, the workspace's class lines when it is not); **Reveal in Unreal Designer** opens the
  designer and selects the node under the cursor; **Compile This File** compiles now, verdicts in
  Problems. The Unreal designer is this language's preview surface — the bridge just takes you
  there.
- **Inside binding expressions**, the editor's knowledge reaches the cursor: signature help on
  every call (`(` and `,`), hover on a function or variable with its type, `<->` completion
  listing the class's variables (FieldNotify ones first — the rest are polled every frame), and
  `Item.` completion inside an `each` body from the source's element type.
- **Format Document** (and the `[dui]` default formatter): indentation from block depth, one
  space around `=` and the arrows, `}` on its own line, blank lines folded to one — the same
  spelling the designer's write-back prints, so the two never fight. A guard re-lexes the result
  and refuses any formatting that would change a single token.
- **Add `use`**: a style or resource that lives in exactly one other file of the workspace gets a
  quickfix that inserts the import, spelled the way the file already spells its imports.
- **Package paths are links**: `/Game/...` in a tag or a string opens the asset in the running
  editor's Content Browser (a tag that names another .dui keeps its F12 to that file instead).
- **Reveal in VS Code** from the Unreal designer's toolbar or hierarchy context menu jumps here to
  the node's line; a single `.dui` opened on its own is indexed with the rest of its `DUI/` tree,
  so imports resolve without a folder open.

## Where the smarts come from

The Unreal plugin writes `DUI/.dui-symbols.json` on every editor startup (or on demand via the
console command `DreamUI.ExportSymbols`). This extension reads that file, so completion offers
exactly what the compiler accepts — the two cannot drift, because there is only one list.

No symbols file yet? Open the project in the Unreal editor once, with a `DUI/` directory present.
Everything grammar-driven works without it, and the status bar says which mode you are in.

Language smarts beyond one file's characters — property types, bindings, asset paths — stay in
the compiler, and reach the editor through the compiler's own diagnostics rather than a second
implementation that would drift.

## Build

```
npm install
npm test            # tsc + node --test (no VSCode, no engine needed)
npm run build       # bundles to out/extension.js
npm run package     # produces the .vsix
```

Point `DREAMUI_CORPUS_DIR` at a project's `DUI/` directory to sweep every real file through the
scanner and structure layer as part of `npm test`.
