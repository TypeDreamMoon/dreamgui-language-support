# DreamUI Language Support

Language support for DreamGUI `.dui` widget hierarchies.

## What it does

- **Syntax highlighting** for the whole grammar, plus **semantic highlighting** for identity:
  node ids render as the member variables they become, styles as classes, resources as readonly
  constants, `->` events and handlers, loop variables, components.
- **Completion** for built-in tags, component classes, per-class properties, enum values, slot
  properties, resource types, `@` resource references and `->` event names.
- **Colour chips and a picker** on every `#hex` literal -- properties, styles and resources alike.
  The picker keeps your digit style (`#F00` stays short) and never rewrites an `@` reference.
- **Hover** with property types and enum values; **outline** of the widget tree, named slots,
  loops, styles and resources; **go to definition** for `@Name` and style uses; token-accurate
  **folding** (comment runs included) and **smart selection**.
- **Diagnostics** with the compiler's own codes and wording, at the compiler's own severities:
  the five lexical codes (DUI1001–1005), the structural ones a single file settles
  (DUI2002/2003/2004/2006, 3001/3002/3004/3005/3008/3014/3015, and the rename-clause checks as
  warnings), plus symbol-driven checks. The compiler stays the authority — anything it might
  accept is a warning here at most, and the project's real files sweep clean by test.
- **Explanations**: every diagnostic offers an "解释 DUInnnn" action opening the bundled
  code-table entry — what it means, why it fired, how to fix it.
- **Quickfixes**: declare the unknown resource (DUI4007), create the unknown style (DUI3004).
- **A new-file command** ("DreamUI: New .dui File", also on a folder's context menu) writing the
  same starter the Unreal editor's "Create Source File..." writes — a root plus one centred
  label, so the first compile answers "did this work" by appearing.
- **A status bar item** showing whether symbols are loaded — a missing `.dui-symbols.json` is a
  visible warning with instructions, not a silent downgrade.

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
