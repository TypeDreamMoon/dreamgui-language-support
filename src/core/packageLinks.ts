/**
 * Where a .dui names an Unreal package. Two positions, because the language has two: a node tag
 * or class line is an `assetPath` token in its own right, and a property value can carry one
 * inside a quoted string.
 *
 * The token stream is the input rather than the raw text, which is what keeps comments out --
 * the lexer already dropped them, and a path written in a comment is prose, not a reference. A
 * string's span is searched in the SOURCE and not in the token's unescaped text: an escape ahead
 * of the path would shift every offset, and an underline one character off is a visible defect.
 *
 * Only `/Game/` and `/Engine/` are claimed. Plugin mount points (`/DreamGUI/...`) are just as
 * revealable, and are left out deliberately: their roots are whatever the project has mounted,
 * this side cannot enumerate them, and underlining a path that turns out not to resolve is the
 * one outcome worth avoiding.
 *
 * No vscode import here: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { Token } from './scanner';

export interface PackageLinkSpan {
    /** Offsets into the source, covering the path text and nothing around it. */
    start: number;
    end: number;
    path: string;
    /**
     * Which of the two positions this is. It matters downstream: a tag can ALSO be the answer to
     * go-to-definition (the .dui whose class line declares it), and Ctrl+click follows a link in
     * preference to a definition -- so the caller drops the ones that would shadow one.
     */
    kind: 'tag' | 'string';
}

/**
 * A mount root, then any run of asset-name characters, ending on one that can actually end a
 * name -- so `/Game/UI/Tex.` in a sentence underlines `/Game/UI/Tex` and stops at the full stop.
 */
const PACKAGE_PATH = /\/(?:Game|Engine)\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]/g;

export function packageLinkSpans(tokens: readonly Token[], source: string): PackageLinkSpan[] {
    const out: PackageLinkSpan[] = [];
    for (const token of tokens) {
        if (token.kind === 'assetPath') {
            PACKAGE_PATH.lastIndex = 0;
            const whole = PACKAGE_PATH.exec(token.text);
            // A tag is a path or it is not; a partial match means the token is some other root.
            if (whole && whole.index === 0 && whole[0].length === token.text.length) {
                out.push({
                    start: token.start, end: token.start + token.text.length,
                    path: token.text, kind: 'tag',
                });
            }
            continue;
        }
        if (token.kind !== 'string') {
            continue;
        }
        const raw = source.slice(token.start, token.end);
        PACKAGE_PATH.lastIndex = 0;
        for (let match = PACKAGE_PATH.exec(raw); match !== null; match = PACKAGE_PATH.exec(raw)) {
            out.push({
                start: token.start + match.index,
                end: token.start + match.index + match[0].length,
                path: match[0],
                kind: 'string',
            });
        }
    }
    return out;
}

/**
 * The links actually worth underlining. A tag that the workspace can trace to the .dui declaring
 * it is dropped: `navigation.ts` already answers that position with a definition, Ctrl+click
 * follows a link in preference to a definition, and a link here would silently replace "jump to
 * the file that declares this widget" with "open the asset" -- a feature quietly taking another
 * one's gesture. F12 was never in question; this is only about which of the two owns the click.
 *
 * A path in a STRING is never anyone's definition, so it is always offered. So is a tag the
 * index cannot place -- an asset with no .dui behind it has nothing to go to, and revealing it
 * is the only answer available.
 */
export function linksToOffer(
    spans: readonly PackageLinkSpan[],
    hasDefinitionElsewhere: (assetPath: string) => boolean,
): PackageLinkSpan[] {
    return spans.filter((span) => span.kind === 'string' || !hasDefinitionElsewhere(span.path));
}
