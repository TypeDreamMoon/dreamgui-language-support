/**
 * What a line's tail says the author is typing -- the judgement every completion branch shares,
 * pulled out of the provider so it can be tested against the spellings people actually write.
 *
 * Born of a real defect: the original provider regexes used a character class whose ` -￿`
 * reads as "space through U+FFFF" -- every '=', '@' and space included -- so
 * `@slot SizeRule = Au` handed "@slot SizeRule" to the property lookup and enum completion went
 * silent. Names here are spelled the way the scanner spells identifiers: word characters, dots
 * for paths, and everything past Latin-1 punctuation (CJK ids are ordinary), never spaces.
 */

export type LineContext =
    /** An '@' run at the tail: resource references (and the @slot/@key directives themselves). */
    | { kind: 'resourceRef' }
    /** After '=': the value of `property`. Aligned spaces and the '@slot' prefix are understood. */
    | { kind: 'value'; property: string; isSlot: boolean }
    /** After '+': a component class name. */
    | { kind: 'componentName' }
    /** After '@slot ': a panel-slot property name. */
    | { kind: 'slotPropertyName' }
    /** After ':' on a header: a style name. */
    | { kind: 'styleRef' }
    /** Nothing special: statement position, owned by the scope the cursor stands in. */
    | { kind: 'statement' };

const NAME = '[A-Za-z_\\u00A0-\\uFFFF][\\w.\\u00A0-\\uFFFF]*';
const VALUE_LINE = new RegExp('^\\s*(@slot\\s+)?(' + NAME + ')\\s*=\\s*(\\S*)$', 'u');
const RESOURCE_REF_TAIL = new RegExp('@[\\w\\u00A0-\\uFFFF]*$', 'u');
const COMPONENT_NAME = new RegExp('^\\s*\\+\\s*[\\w/.\\u00A0-\\uFFFF]*$', 'u');
const SLOT_PROPERTY_NAME = new RegExp('^\\s*@slot\\s+[\\w.\\u00A0-\\uFFFF]*$', 'u');
const STYLE_REF_TAIL = new RegExp(':\\s*[\\w\\u00A0-\\uFFFF]*$', 'u');

/** `line` is the text before the cursor on the current line. */
export function analyzeLine(line: string): LineContext {
    // An '@' glued to the tail: '@Acc' in value position, or a directive being spelled. '@slot Si'
    // does NOT land here -- its tail run is 'Si', the '@' is a word away.
    if (RESOURCE_REF_TAIL.test(line)) {
        return { kind: 'resourceRef' };
    }
    const value = VALUE_LINE.exec(line);
    if (value) {
        return { kind: 'value', property: value[2], isSlot: value[1] !== undefined };
    }
    if (COMPONENT_NAME.test(line)) {
        return { kind: 'componentName' };
    }
    if (SLOT_PROPERTY_NAME.test(line)) {
        return { kind: 'slotPropertyName' };
    }
    // A ':' on a line with no '=': a header's style clause. (A ':' inside a value string sits on
    // a line that has an '=', which is what keeps this branch out of values.)
    if (STYLE_REF_TAIL.test(line) && !line.includes('=')) {
        return { kind: 'styleRef' };
    }
    return { kind: 'statement' };
}
