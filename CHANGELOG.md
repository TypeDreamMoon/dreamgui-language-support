# Changelog

## 0.9.2 — 2026-10-05

- **The extension is now `typedreammoon.dreamgui-language-support`.** The VS Code Marketplace keeps
  every extension name it has ever seen reserved, and `dreamui-language-support` was taken, so the
  extension could not be published under it. The repository moved with it, to
  `TypeDreamMoon/dreamgui-language-support` (GitHub forwards the old address). The language, its
  settings and its commands are unchanged: still `.dui`, still `dreamui.*`.
- **A copy under the old id is noticed.** VS Code takes it for a different extension, and with both
  enabled every diagnostic, completion and hover comes twice. The extension says so when it starts and
  offers to uninstall it; `install-vscode-extension.ps1` removes it after installing.

## 0.9.1 — 2026-10-05

DreamGUI 1.0.0 and its docs site, [gui.toolchain.64hz.cn](https://gui.toolchain.64hz.cn).

- **A diagnostic's code opens its page on the docs site.** `DUI3001` in Problems and in the hover is a link to
  `/docs/diagnostics/dui3xxx/#dui3001` -- the Chinese page when VS Code runs in Chinese, the English one under
  `/en` otherwise -- for the extension's own diagnostics and the compiler's alike. "解释 DUInnnn" stays: the bundled
  table is the offline copy, and its preview links the same page. The quick fixes and the explain action read the
  code through one helper now, since a linked code is no longer a plain string.
- **`homepage`** in the manifest, and both READMEs, point at the site.
- Tests: the URL for each locale, and -- with `DREAMUI_SITE_OUT` pointing at the site's static export -- every code
  the compiler can send against the pages and anchors the site actually has.

## 0.9.0 — 2026-10-04

`rows`: the plugin's table of instances (DreamGUI main `86c86160`).

- **`rows Row : ListRow (Label, Description) { "City Ruins", "…" … }` is read as the compiler reads it**: one unnamed
  child per line, in place among its siblings, each named from its first value -- `Page_0__Row_City_Ruins`, the key
  cleaned and cut to 32 characters, bumped with a DUI3023 warning when two keys collide, counted when nothing of the
  key survives -- so the outline, the index and every id-based feature see the same widgets the compiler builds. A
  line may end in a block of its own. A column list that is not names, a column named twice, or a row with the wrong
  number of values is DUI2020, and a row that does not read makes no widget.
- **The header is described once** (`rowsTables`): its style is judged, renamed and indexed once rather than once per
  row, and the semantic tokens colour its type, its style and its columns (as properties) once.
- **Highlighting**: `rows`, the type, the style and the column names; the rows are values, a row's block a node body.
  `rows = 3` and `rows Grid { }` stay what they were.
- **The formatter keeps a table a table**: a row stays one line, and the spacing after a row's commas and before the
  block it ends in is the author's -- a table aligned into columns is the point of writing one. The column list keeps
  its space (`ListRow (Label, …)` is no call).
- **Code table**: DUI2020 MalformedRows and DUI3023 DuplicateRowKey. A `rows` snippet.

## 0.8.1 — 2026-10-04

- **Indented comments are comments again.** A node header may name its type by path, and the path
  rule took `//` for one: on an indented line it starts at the indent, left of the comment, so
  `    // The scroll track and its thumb.` read as a node of type `//` called `The`. The same happened
  to a comment after a `{` or a `;`. A path no longer starts with `//` or `/*`.

## 0.8.0 — 2026-10-04

The component syntax: what DreamGUI's `.dui` gained after 2.1.0 — `use … as`, `props`, `events`,
`emit`, slots with a layout and a default, containers as node types, nodes with no id, `@slot { … }`
and `@fill`, namespaces, `if` / `else` and a working `for` — highlighted, explained and written by
snippet. Every old spelling keeps working, and keeps its colour.

- **The grammar learns the new forms.** `use "Row.dui" as Row`, `use /Game/UI/WBP_Row as Row` and
  `use "Lib.dui" as nier` colour `as` and the name; `props { … }` and `events { … }` are regions of
  their own, with the compiler's type words (`Text`, `String`, `Number`, `Integer`, `Bool`, `Color`,
  `Vector2`, `Asset`, `Class`, `Enum <path>`) — any other word stays uncoloured, so a typo shows
  before the compile says DUI6008 — and a one-line `events { Picked(Number Index); Closed }` reads
  whole. `emit` is a keyword only with an event after it: `OnReleased -> emit` still names a handler,
  as the parser reads it. `slot Rows default : RowList` takes its clauses in any order. `if`, `else if`
  and `else` lead a branch, and `if = 1` is still a property. `@fill` and `@fill 2` are the shorthand,
  `@fill Filler { }` the resource-typed node it is. `@slot { A = 1  B = 2 }` scopes each line as a slot
  property.
- **Node headers** take every type the compiler resolves — a container (`VerticalBox Column`), an alias
  (`Row`, `nier.Row`), `@Name`, a registry tag (`Native.Button`), a path — and nodes with no id
  (`HorizontalBox {`, `Text : Caption {`); a type alone on a line stays uncoloured, the DUI2004 it
  always was. `(was: …)` and `: Style` come in either order. A namespace or registry scope is marked
  inside the name it qualifies (`nier.Row`, `: nier.Label`, `@nier.Ink`); a class path's module is not.
- **One-line blocks colour each statement.** A property, binding or route now ends at a `;`, a `}`, or
  where the next property begins — the parser's own rule — so `+ UIButton { TransitionType = None
  bCanNavigateHere = false }` and `Label <- Item.Label  Count <- Item.Count` are two properties each
  rather than one long value, and a child node inside a one-line body (`RectBlock Key : Cap { Text
  Label : Caption {} }`) is a node. `@key(…)` after a string value is the key override, no longer a
  resource reference, and `@Resource` colours inside binding expressions and `emit` arguments.
- **`timeline` blocks get their own region**: `duration` / `loop`, track lines, `ease` names and
  `@time -> Event` keys, and `timeline X external`. A track line's `:` is never read as an anonymous
  node's style clause.
- **The code table covers the compiler's whole table.** New entries for DUI2015–2019 (`use … as`,
  `props`, `events`, `if`, `slot`), 3017–3022 (duplicate alias, alias shadowing a tag or container,
  duplicate prop or event, unknown namespace, a second default slot), 5018–5022 (unresolved alias,
  slot fills, `for` misplaced, a second layout container), 6008–6014 (prop types, names and
  defaults, `emit`), 7004–7005 (write-back of what no line spells, and of a style's component), and
  the ones that had arrived from the compiler as bare numbers: 1007, 2014, 3016, 5015–5017.
  Entries whose meaning moved say what they mean now: **DUI5007** no longer says `for` is
  unimplemented — it is the warning a caller with nowhere to record a loop gets, which a real
  compile never is; DUI2004 allows a node with no id before a block or a style; DUI3008 and DUI3009
  stop describing nested loops as theirs (that is DUI5021 / DUI5012 now); DUI3002, 3003, 3004, 5005,
  5012, 5014, 6006 and 6007 name what they now cover. The test holds the table to the compiler's
  numbering, the retired DUI3007 excluded.
- **Snippets**: `dui-component` (a component with `props`, `events`, `emit` and a default slot),
  `props`, `events`, `emit`, `use-as`, `use-class`, `for`, `if`, `ifelse`, `slot-default`,
  `slot-fill`, `slotblock`, `shown`, `vbox`, `hbox`. A test expands every snippet and holds it to
  lexing clean with its braces balanced.
- **README**: the section on what the language deliberately does not have was partly false — `if`
  and `for` exist, and `for` is no longer refused with DUI5007. Rewritten against the plugin's
  language reference, and given to the Chinese README too.
- **The structure layer reads the new language the way the compiler does.** It consumes tokens as
  the parser does, its brace-balanced recovery included: a value is one value (`A = 1  B = 2` is two
  statements), a `<-` binding ends where the next property starts, and a statement the compiler
  refuses is not recorded. `use … as` (file, class, namespace), `@Name` and multi-dot types, unnamed
  nodes with the compiler's made ids (all 66 of the NieR screens' match the compiled assets),
  `@slot { }` and `@fill [N]`, styles with `+` blocks and slot lines, `props`, `events`, `emit`, slot
  declarations and fills, `if` / `else` chains and `for` over a function or a variable. It raises
  DUI2015–2019, 3017, 3019, 3020, 3022 and 3021 where one file proves them, with the compiler's
  wording, and DUI1006 for a made id that is too long.
- **The index follows imports as the compiler merges them**: plain uses transitively, namespaces
  under their prefix, a component use bringing only its name. A file's aliases, props, events and
  slots are summarized, and `aliasesVisibleFrom` / `resolveComponent` answer what a node type comes
  to. The judge stops reporting anything the new syntax makes valid -- an alias, namespaced or
  container type, a namespaced style or resource, a prop read in a binding, `for` -- and adds
  index-backed checks only where they are certain (an alias shadowing a tag or container, DUI3018;
  an unknown namespace, DUI3021), as warnings when it is the index rather than the file that knows.
  The mailbox lets the compiler's DUI3004 / DUI4007 about a namespaced name through, since the live
  check for those is the weaker one.
- **The formatter keeps every new construct** and is idempotent on the NieR screens; a block
  written on one line with no non-empty block inside now stays on one line, instead of every block
  being expanded.
- **Completion, hover and go to definition for components.** Node types offer containers, aliases
  (re-exported ones included) and `ns.` namespaces; `props { }` and event parameters offer the type
  words; `->` offers `emit`, then this file's events; `@` offers `slot` / `fill`, and `key` after a
  string; keywords appear only where they are legal; a component instance offers its props, events
  and slot fills. Hover explains aliases, namespaces, `emit`, props and unnamed nodes' made ids.
  Go to definition jumps from an alias to its component file, from `emit` to the event, from a
  binding's prop to its declaration, from `ns.X` to the library and from a fill to the slot.
  Accepting a dotted property after `AnchorData.` no longer doubles the prefix.
- **Semantic tokens** gain `namespace` and `property`: aliases colour as types, props as properties,
  events and `emit` targets as events, and tokens refresh when the workspace index changes.
- **Rename, refactors, a quickfix**: an unnamed node is renamed by writing its id (no `(was:)`);
  aliases, namespaces, props and events rename their uses in the file; extract-style handles unnamed
  nodes and refuses branch and loop bodies; inline-style carries `+` components and slot lines;
  DUI3003 offers `use "…" as X` for a uniquely named component file. `emit Picked(` gets signature
  help from the file's own `events` block.
- **Old symbol dumps are filled in**: a `.dui-symbols.json` from before the plugin's component
  syntax gets tag kinds, containers as node types, `Shown`, and the keyword, annotation and prop-type
  lists from a built-in fallback that mirrors the language reference.

## 0.7.0 — 2026-09-04

The index reads a file's own tree, a formatter, and the editor's knowledge reaching into binding
expressions.

- **A `.dui` opened on its own is indexed with its siblings.** `findFiles` sees nothing in a window
  without a folder, and that is how this language is most often read — double-clicked, or revealed
  from Unreal. The host now walks up from the file to its `DUI/` root (or a directory carrying
  `.dui-symbols.json` / `DreamUI.code-workspace` / `.dui-diagnostics.json`), reads that tree itself
  and watches it, so `use` resolves and imported styles stop reporting DUI3004 in single-file mode.
- **Format Document**, plus `[dui]` default formatter. Indentation from block depth, single spaces
  around `=` and the arrows, `}` on its own line, blank lines folded to one, comments and strings
  untouched — the spelling the designer's write-back prints. The result is re-lexed and compared
  token by token; a formatting that would change one is refused. Range formatting formats the file
  and returns the minimal edit.
- **The judging moved into core.** Everything diagnostics.ts decided — import exemptions, the
  declaration-library case, the stray `}`, DUI4007, the unknown-tag hint — is `judgeDocument` in
  `src/core/diagnose.ts`, with tests, and the corpus sweep now builds an index first: the real
  gallery is diagnostic-free (the old sweep, index-less, reported 17). An `@vscode/test-electron`
  smoke (`npm run test:electron`) opens the corpus with and without a folder and asserts zero
  DUI3004.
- **Add `use`.** DUI3004 and DUI4007 offer to insert the import when exactly one other file
  declares the style or resource, spelled the way the file's existing imports are spelled, after the
  last `use`.
- **Inside binding expressions**: signature help on calls, hover on functions and variables, `<->`
  completion listing variables (FieldNotify first — the compiler accepts any variable, FieldNotify
  only decides subscription versus polling), `Item.` members in an `each` body. All from three new
  bridge actions (`callable` in `functions`, `variables`, `members`); the editor's type strings now
  carry template arguments, so a `TArray<FFoo>` return can be asked about.
- **Package paths are links** to the asset in the editor's Content Browser (`revealAsset`); a tag
  that names another .dui keeps its definition jump.
- **Reveal in VS Code** from the designer: the editor writes `Saved/DreamGUI/Bridge/reveal-to-
  editor.json`, the extension opens the file at the node's line. Stamps older than 30 s are ignored
  at startup; a one-second poll backs the watcher for `Saved/` trees outside the workspace.
- **Keybindings**: Ctrl+Alt+R reveals in the designer, Ctrl+Alt+B compiles the file.
- **Plugin side (needs a rebuild of DreamGUI)**: the bridge actions above, DUI5004/6004/6005 now
  carry the line of the `<-`/`->` that raised them, the `each` failures that only ever reached the
  message log are raised as **DUI6006 `EachSourceNotFound`** and **DUI6007
  `EachSourceNotObjectArray`** (explained here, anchored on the `each` line), and the designer
  gains its Reveal in VS Code entries.

## 0.6.1 — 2026-09-04

Five codes the compiler grew today, the end of a filter that had outlived its reason, and the
import exemptions finally working in a restored window.

- **Imported styles and resources are exempt at startup too.** 0.6.0 taught the diagnostics to
  withhold DUI3004 and DUI4007 for what a `use` brings in, but it read the workspace index without
  ever asking for the sweep that fills it — only Go to Definition and completion did — and nothing
  re-judged a file once the library it imports had been indexed. So a restored window reported
  every imported style in every open file (`'Heading' names a style this file does not declare`,
  twelve times over in the gallery) and kept reporting it until that file was edited. Diagnostics
  now wait for the sweep before judging, and re-run the visible editors whenever the index takes a
  file in, changes one or drops one.
- **DUI1006 `IdentifierTooLong`**, raised here too. A name of NAME_SIZE (1024) characters or more
  is not a taste refusal: every word a .dui writes down becomes an FName downstream, and FName
  answers an over-long string with `checkf(false)`, taking the editor with it. Lexical, so one
  rule covers every position a word can appear in; the token is emitted **truncated** exactly as
  the compiler emits it, so the rest of the file goes on lexing.
- **DUI2013 `NestingTooDeep`**, raised here too. Both parsers are recursive descent, and a file
  nesting a thousand deep is answered by exhausting the stack — in the compiler that is the editor
  vanishing with unsaved work, here it is the extension host taking every open file with it. 256
  bodies, counted once for nodes and component blocks alike (the stack is one stack), reported once
  per file at the `{` that broke the budget, and the block is skipped **balanced** so the file
  after it still parses.
- **DUI5014 `LoopBodyBindingUnsupported`**, **DUI6004 `EventHandlerNotFound`** and **DUI6005
  `EventHandlerSignatureMismatch`** explained in Chinese. All three are compiler-only — 5014 needs
  the thunk pass, and the 6xxx pair needs the class the compile is still building — so they are
  registered and never raised locally, and arrive through the diagnostics mailbox like the rest.
- **DUI3009 `ParentRefusedChild`** explained too: it could always arrive from the compiler and had
  no entry, so it read as a bare number. A completeness test now holds the table over every code
  either side can raise, which is what caught it.
- **DUI3010/3011/3012 stop being swallowed.** They had no raise site anywhere in the plugin when
  the mailbox filter was written; the compiler now raises them as **errors** that fail the compile
  and refuse the whole file's rename migration. They leave the suppression set so the compiler's
  verdict — whose message names both nodes and both ways out — reaches Problems. The local checks
  stay **warnings**: a live hint ahead of a compile, never a second red for one fact.
- The filter is now its own set (`MAILBOX_SUPPRESSED`) rather than a synonym for "we raise this
  locally". Membership means *the mirror judges from the same inputs the compiler does* — which
  DUI1006 (unsaved buffer vs. the file on disk) and DUI2013 (blocks only, where the compiler also
  spends the budget on parenthesised sub-expressions) do not, so both stay outside it and arrive
  from the compiler as well. A test holds the suppression set to a strict subset of what is raised.


## 0.6.0 — 2026-09-01

The scoped-tag release, and the end of three import false positives.

- **`Native.Toggle` scoped tags**: the compiler grew a widget registry (`DECLARE_DREAM_GUI_WIDGET`),
  and a node tag may now be `Scope.Name`. The structure layer joins the dotted tag exactly as the
  compiler's parser does — the dispatch walks a dotted run and lets what FOLLOWS decide, so
  `AnchorData.SizeDelta = ...` is still a property and `Native.Toggle Mute {` is a node. Grammar
  highlighting already accepted dots in tags; no grammar change.
- **and the symbols file now HAS them.** The plugin's exporter only ever read the builder's visual
  tag table, so `.dui-symbols.json` carried the ten primitives and not one of the seventeen
  `Native.*` controls — completion offered none of them and every one read as an unknown tag. The
  exporter now walks the widget registry too, keyed `Scope.Name`, with each control's properties,
  events and tooltips. Nothing in the extension changed for this; **re-export the file** (open the
  editor once, or run `DreamUI.ExportSymbols` in its console) to pick the controls up.
- **`use` imports stop lying**: a style arriving through a `use` import no longer trips DUI3004,
  an imported `@resource` no longer trips DUI4007, and a pure declaration library (styles or
  resources, no root node) no longer trips DUI2006. The withholding happens at the publisher with
  workspace knowledge — the single-file layers still judge single files, and only a UNIQUE import
  resolution is trusted, so reporting stays "less than the compiler, never different".


## 0.5.1 — 2026-08-31

- **Code table**: DUI5013 explained in Chinese. The compiler gained intra-tree node references —
  an object property may now name a node declared in the same file instead of an asset path —
  and 5013 is what it reports when that name matches nothing. No syntax changed: a value that
  starts with `/` is still an asset path, so nothing in the lexer or the grammar moved.

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
