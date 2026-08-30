/**
 * The starter a new .dui gets: byte-for-byte the one the Unreal editor's "Create Source File..."
 * writes (DreamWidgetBlueprintEditor.cpp), so the first file looks the same whichever side made
 * it. A starter that RENDERS: an empty file compiles to an empty hierarchy, which looks exactly
 * like a broken pipeline the first time anyone sees it; a root plus one centred label is the
 * smallest thing that answers "did this work" by appearing.
 */

export function duiStarter(fileName: string, classPath: string, title: string): string {
    return `// ${fileName}\n`
        + `class ${classPath}\n`
        + `\n`
        + `Widget Root {\n`
        + `    AnchorData.AnchorMin = (0, 0)\n`
        + `    AnchorData.AnchorMax = (1, 1)\n`
        + `    AnchorData.SizeDelta = (0, 0)\n`
        + `\n`
        + `    + Overlay {}\n`
        + `\n`
        + `    Text Title {\n`
        + `        Text     = "${title}"\n`
        + `        FontSize = 24\n`
        + `        @slot HorizontalAlignment = Center\n`
        + `        @slot VerticalAlignment   = Center\n`
        + `    }\n`
        + `}\n`;
}
