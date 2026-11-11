/**
 * Copies of this extension installed under an id it no longer has.
 *
 * Up to 0.9.1 it was published as `dreamui-language-support`; the Marketplace had the name reserved, so 0.9.2 took a new
 * one. VS Code sees a copy under the old id as a different extension: two of them register `.dui`, and every
 * diagnostic, completion and hover comes twice.
 */

/** This extension's id (publisher.name), as VS Code spells it. */
export const OWN_ID = 'typedreammoon.dreamgui-language-support';

/** The name part the extension was published under before. */
const OLD_NAME = 'dreamui-language-support';

/**
 * The ids among `installed` that are stale copies of this extension: any publisher's `dreamui-language-support`, and
 * never `ownId`. Ids compare without regard to case, as VS Code compares them; each is returned as it was given, once.
 */
export function staleCopies(installed: readonly string[], ownId: string = OWN_ID): string[] {
    const own = ownId.toLowerCase();
    const seen = new Set<string>();
    const stale: string[] = [];
    for (const id of installed) {
        const folded = id.toLowerCase();
        const dot = folded.indexOf('.');
        const name = dot < 0 ? folded : folded.slice(dot + 1);
        if (folded !== own && name === OLD_NAME && !seen.has(folded)) {
            seen.add(folded);
            stale.push(id);
        }
    }
    return stale;
}
