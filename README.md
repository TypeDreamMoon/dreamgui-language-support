# DreamGUI Language Support

English | [简体中文](README.zh-CN.md)

Language support for DreamGUI `.dui` widget hierarchies. DreamGUI and the language are documented at
[gui.toolchain.64hz.cn](https://gui.toolchain.64hz.cn/en/docs/).

## What it does

- **Syntax highlighting** for the whole grammar — binding expressions (`Enabled <- !IsBusy() &&
  Count() > 0`), the two-way arrow (`Value <-> Volume`), `use "…"` imports and both loop-source
  shapes included — plus **semantic highlighting** for identity: node ids render as the member
  variables they become, styles as classes, resources as readonly constants, `->` events and
  handlers, loop variables (`Item.Member` in an `each` body colours as the parameter it uses),
  calls as functions, bare names as variables, components.
- **`rows` tables** (`rows Row : ListRow (Label, Description) { "City Ruins", "…" … }`) are read as the compiler
  reads them: one unnamed widget per line, named from its first value, with DUI2020 / DUI3023 for a table that does
  not read and two rows whose keys collide. The header is highlighted and its style judged once; the formatter keeps
  each row on its line and the author's column alignment.
- **The component syntax**, highlighted: `use "Row.dui" as Row`, `use /Game/UI/WBP_Row as Row` and
  `use "Lib.dui" as nier`; `props { … }` and `events { … }` with their type words; `OnClick -> emit
  Picked(Index)`; `slot Rows default : RowList { … }` and a host's `slot Detail { … }`; containers as
  node types (`VerticalBox Column { Spacing = 29 }`) and nodes with no id (`HorizontalBox { … }`,
  `Text : Caption { … }`); `@slot { A = 1  B = 2 }`, `@fill` and `@fill 2`; namespaced names
  (`nier.Row`, `: nier.Label`, `@nier.Ink`); `if … else if … else`; `for Item in GetItems() { … }`;
  and `timeline` blocks. A one-line block (`+ UIButton { TransitionType = None  bCanNavigateHere =
  false }`, `Label = "MAP"; Icon = @IconMap`) colours each statement as its own property.
- **Snippets** for the component syntax: a component file (`dui-component`), `props`, `events`,
  `emit`, `use-as`, `use-class`, `for`, `if` / `ifelse`, `slot-default`, `slot-fill`, `slotblock`,
  `shown`, `vbox` and `hbox`, beside the older ones.
- **Completion** for built-in tags, layout containers, component classes, per-class properties,
  enum values, slot properties, resource types, `@` resource references and `->` event names -- and
  for the component syntax: the aliases a file can use as node types (its own `use … as` lines and
  the ones its libraries re-export), `ns.` namespaces, prop and event types inside `props { }` /
  `events { }`, `emit` and this file's events after `->`, `@slot` / `@fill` / `@key` after an `@`,
  keywords only where they are legal, and on a component instance its props, events and slots.
  A node typed by a container offers the container's properties too, and `Shown` is a widget property.
- **Colour chips and a picker** on every `#hex` literal -- properties, styles and resources alike.
  The picker keeps your digit style (`#F00` stays short) and never rewrites an `@` reference.
- **Hover** with property types and enum values, and for the component syntax: what an alias
  resolves to (file, class, props, events, slots), where a namespaced name comes from, an `emit`'s
  signature, a prop's type and default, and the id an unnamed node compiles to. **Outline** of the
  widget tree with `if` / `else` branches, unnamed nodes by type, slot declarations and fills,
  loops, `props`, `events`, styles and resources. **Go to definition** for `@Name` and style uses,
  an alias type to its component file, a `use … as` name to its target, `emit Picked` to the
  `events` entry, a binding's prop to its `props` entry, `ns.Label` / `@ns.Ink` to the library, and
  a slot fill to the component's slot. Token-accurate **folding** (comment runs included) and
  **smart selection**.
- **Diagnostics** with the compiler's own codes and wording, at the compiler's own severities:
  the six lexical codes (DUI1001–1006); the structural ones a single file settles
  (DUI2002/2003/2004/2006/2013, the component syntax's 2015–2019, 3001/3002/3004/3005/3014/3015/3016,
  3017, 3019, 3020, 3022, 3021 where one file proves it, and 3018 for a class alias), plus as
  warnings the rename-clause checks (3010–3012), 3008, and what the workspace index makes certain
  (3004 for a namespaced style, 3018 for a file alias, 3021 from the imports, 4007); plus
  symbol-driven checks. The compiler stays the authority — anything it might accept is a warning
  here at most, and the project's real files sweep clean by test.
- **Rename and refactors** know the component syntax: renaming an unnamed node writes the id after
  its type (no `(was:)`, as the plugin's write-back does), an alias or namespace renames every use
  in the file, a prop renames its entry and every binding reading it, an event its entry and every
  `emit`. Extract-style works on unnamed nodes; inline-style carries a style's `+` components and
  slot lines over. An unknown component type (DUI3003) offers `use "…" as X` when exactly one
  component file of that name exists.
- **`timeline` blocks** are highlighted, outlined and left alone: a track line
  (`Row/Icon.RenderScale : 0.0 = (1, 1, 1), 0.3 = (1.25, 1.25, 1) ease InOutQuad`) resolves against
  the widget tree and the engine's reflection, which one file's characters cannot see, so every
  verdict about one is the compiler's. `timeline X external` names an animation that lives in the
  asset and is edited in Sequencer.
- **Explanations**: a diagnostic's code, in Problems and in the hover, is a link to its entry on the docs
  site ([DUI1xxx–7xxx](https://gui.toolchain.64hz.cn/en/docs/diagnostics/), in Chinese when VS Code runs in
  Chinese). Offline, every diagnostic offers an "解释 DUInnnn" action opening the bundled
  code-table entry — what it means, why it fired, how to fix it. The table covers the compiler's
  whole table, the component syntax's codes included (`use … as`, `props`, `events`, `if`, slots,
  `for`, `emit` and the two new write-back refusals), and is held to it by test.
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

## What the language deliberately does not have

These come up, and every one of them is a decision rather than a gap. The extension will not
complete them, the compiler refuses them where they parse at all, and none of them is coming
without somebody deciding what it should mean first.

`if` and `for` used to head this list. Both are in the language now, in the shape the rest of it
allowed: `if` switches visibility, and `for` repeats one template from the class's data. What they
did not bring is below.

| Not in the language | Why, and what to write instead |
|---|---|
| `#ifdef`, compile-time conditions | `if` is a run-time switch, not a compile-time one: every branch is built, each of its widgets gets a `Shown` bound to "this branch is taken", and a hidden branch is collapsed, not destroyed, so it keeps its state. Nothing in a file leaves a widget out of the class. A variant that must not exist at all is a second class. |
| Macros, text templates | Reuse is a **component** — a `.dui` with `props`, `events` and `slot`s, placed by its `use … as` name — or a **style**, which may carry `+ Component` blocks and slot lines as well as values. Neither is text substitution: an instance is a class, a style is a bag of lines, and both resolve by name. |
| Variables, theme variables | `resources { … }` is the named-constant mechanism, and it resolves through `use` (under a namespace with `use … as`), so a palette lives in one file that every screen imports. `props` are a component's inputs — Blueprint variables its host sets or binds — not values the file reassigns. What a free variable would add is *reassignment*, which is the declarative rule again. |
| Media queries, pseudo-states (`:hover`) | A state has to be driven by something, and in this framework that something is a behaviour (`UUISelectable` and friends already own hover, press, disabled and their transitions). A second state machine in the language would have to agree with it frame by frame. |
| `A \| B` for flag enums | The grammar has no `\|` and adding an operator is a language change. A combination is written as **the number its flags add up to** — the compiler validates it against the enum (`IsValidEnumValueOrBitfield`), and the write-back prints it back, so the round trip is whole. |
| `a ? b : c`, `a / b`, `Items[0]` | The expression language is arithmetic without division (`/` belongs to paths and comments), comparison, logic and calls, because every operator added to it has to be lowered into a Blueprint graph, taught to this extension's scanner, and documented in three places. A choice or a division is a function on the class; an index is a function that takes one. For widgets, a choice is an `if`. |
| Array and dictionary literals | Same reason, and there is nowhere for the value to land: no property the language addresses takes one from text. A list a `for` or `each` repeats comes from the class — a no-argument function, or a FieldNotify array of objects. |
| `\uXXXX` in strings | `.dui` files are UTF-8. Write the character. |
| Nested loops, expressions in a loop body | One level of repetition per template: a `for` or `each` inside another is refused (DUI5021, DUI5012). The way to nest is a component whose own file has the inner loop. Inside a loop body the only binding is the single hop `Item.Member` (DUI5014); anything richer belongs on the item's class. |

Two things that look like gaps and are not:

- **Imported `resources` do become class variables.** `use "Palette.dui"` gives this class a
  variable per entry, so a graph and the Class Defaults panel can see what `@Accent` is. A local
  entry of the same name shadows the imported one, exactly as `@Accent` resolves.
- **Imported `style` blocks do not.** A style is a bag of values applied by name; it has no
  identity to own.

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

## Release

Bump `version` in `package.json`, add its `## x.y.z` section to `CHANGELOG.md`, push to `master`.
The `release` workflow runs the tests, tags `vx.y.z`, and publishes a GitHub release carrying the
`.vsix` with that section as its notes. With a `VSCE_PAT` repository secret (an Azure DevOps token
with Marketplace > Manage scope for the `typedreammoon` publisher) it publishes the same `.vsix` to
the Marketplace; without one that step is skipped. After adding the secret, run the workflow by hand
(Actions > release > Run workflow) to publish a version that is already on GitHub.
