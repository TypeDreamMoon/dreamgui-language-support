# DreamUI Language Support

Language support for DreamGUI `.dui` widget hierarchies.

## What it does

- **Syntax highlighting** for the whole grammar: nodes, `+` components, `@slot`, styles and
  inheritance, `resources` blocks, `@Name` references, `<-` bindings, `->` event routes,
  `(was: OldId)` renames.
- **Completion** for built-in tags, component classes, per-class properties, enum values, slot
  properties, resource types, `@` resource references and `->` event names.
- **Hover** with property types and enum values; **outline** of the widget tree, styles and
  resources; **go to definition** for `@Name` and style uses.
- **Diagnostics** for what one file can know: brace balance, unknown `@` references (DUI4007),
  duplicate resources (DUI3014), unknown style bases (DUI3004), unknown tags. The compiler stays
  the authority — anything it might accept is a warning here at most.

## Where the smarts come from

The Unreal plugin writes `DUI/.dui-symbols.json` on every editor startup (or on demand via the
console command `DreamUI.ExportSymbols`). This extension reads that file, so completion offers
exactly what the compiler accepts — the two cannot drift, because there is only one list.

No symbols file yet? Open the project in the Unreal editor once, with a `DUI/` directory present.
Everything grammar-driven works without it.

## Build

```
npm install
npm run build       # bundles to out/extension.js
npm run package     # produces the .vsix
```
