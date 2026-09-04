# Changelog

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
