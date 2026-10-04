/**
 * What a line's tail says the author is typing -- the judgement every completion branch shares,
 * pulled out of the provider so it can be tested against the spellings people actually write.
 *
 * Born of a real defect: the original provider regexes used a character class whose ` -￿`
 * reads as "space through U+FFFF" -- every '=', '@' and space included -- so
 * `@slot SizeRule = Au` handed "@slot SizeRule" to the property lookup and enum completion went
 * silent. Names here are spelled the way the scanner spells identifiers: word characters, dots
 * for paths, and everything past Latin-1 punctuation (CJK ids are ordinary), never spaces.
 *
 * The line decides WHAT is being typed; the scope the cursor stands in (node, branch, props block,
 * `@slot { }` block…) decides what is legal there, and that judgement stays with the provider, which
 * holds the structure and the workspace. A keyword is offered here only where the grammar makes it
 * one: `as` after a `use` path, `default` after a slot's name, `in` after a loop variable, `else`
 * after a closing brace, `if` after `else`, `emit` after `->`.
 */

import { bindingTailOf } from './bindingIntel';
import { KEYWORDS } from './vocabulary';

export type LineContext =
    /**
     * An '@' run in value position: resource references. `@nier.` names a namespace, and what follows the dot is
     * one of that library's resources.
     */
    | { kind: 'resourceRef'; namespace?: string }
    /** An '@' leading a statement: `@slot`, `@fill` (and an Asset resource used as a node type, `@Row Audio`). */
    | { kind: 'annotation' }
    /** After '=': the value of `property`. Aligned spaces and the '@slot' prefix are understood. */
    | { kind: 'value'; property: string; isSlot: boolean }
    /** After '+': a component class name. */
    | { kind: 'componentName' }
    /** After '@slot ' (or inside a one-line `@slot { … }`): a panel-slot property name. */
    | { kind: 'slotPropertyName' }
    /** After ':' on a header: a style name. `: nier.` names a namespace. */
    | { kind: 'styleRef'; namespace?: string }
    /**
     * A binding expression: the right of `<-` or `<->`, an `if` condition, the arguments of `emit Picked(…)`, or a
     * loop's source after `in`. The file's props are variables here; `<->` mirrors a variable both ways, which a
     * prop cannot be.
     */
    | { kind: 'expression'; op: '<-' | '<->' | 'if' | 'emit' | 'in' }
    /** The right of `->`, before anything is chosen: a handler, or `emit`. */
    | { kind: 'route' }
    /** `-> emit ▌`: one of this file's events. */
    | { kind: 'emitTarget' }
    /** Where the grammar makes exactly these words keywords. */
    | { kind: 'keyword'; words: string[] }
    /** `slot ▌` inside a node: a component's slot to fill, or the name of a new one. */
    | { kind: 'slotName' }
    /** Inside an `events` entry's parentheses: a parameter's type, or its name. */
    | { kind: 'eventParam'; position: 'type' | 'name' }
    /** `Head.▌` leading a statement: a namespace's alias, a scoped tag (`Native.`), or a dotted property path. */
    | { kind: 'dotted'; head: string }
    /**
     * A name being chosen -- a node's id after its type, an alias after `use … as`, a `use` path being typed: nothing
     * completes a name that does not exist yet, and offering the scope's properties there was noise.
     */
    | { kind: 'nodeId' }
    /** Nothing special: statement position, owned by the scope the cursor stands in. */
    | { kind: 'statement' };

const HEAD = '[A-Za-z_\\u00A0-\\uFFFF]';
const TAIL = '[\\w\\u00A0-\\uFFFF]';
const WORD = HEAD + TAIL + '*';
const NAME = HEAD + '[\\w.\\u00A0-\\uFFFF]*';
const VALUE_LINE = new RegExp('^\\s*(@slot\\s+)?(' + NAME + ')\\s*=\\s*(\\S*)$', 'u');
/** An inline block's last statement: `+ UIButton { TransitionType = No`, `@slot { SizeRule = Fill  Pad`. */
const INLINE_VALUE = new RegExp('(?:^|\\s)(' + NAME + ')\\s*=\\s*(\\S*)$', 'u');
const INLINE_NAME = new RegExp('(?:^|\\s)[\\w.\\u00A0-\\uFFFF]*$', 'u');
const RESOURCE_REF_TAIL = new RegExp('@(?:(' + WORD + ')\\.)?' + TAIL + '*$', 'u');
/** An '@' that LEADS a statement: at the line's start, or just inside a one-line block. */
const ANNOTATION_TAIL = new RegExp('(?:^|[{;])\\s*@' + TAIL + '*$', 'u');
const COMPONENT_NAME = new RegExp('^\\s*\\+\\s*[\\w/.\\u00A0-\\uFFFF]*$', 'u');
const SLOT_PROPERTY_NAME = new RegExp('^\\s*@slot\\s+[\\w.\\u00A0-\\uFFFF]*$', 'u');
const STYLE_REF_TAIL = new RegExp(':\\s*(?:(' + WORD + ')\\.)?' + TAIL + '*$', 'u');
const USE_AS = new RegExp('^\\s*use\\s+(?:"[^"]*"|/\\S+)\\s+' + TAIL + '*$', 'u');
const SLOT_DEFAULT = new RegExp('^\\s*slot\\s+' + WORD + '\\s+' + TAIL + '*$', 'u');
const SLOT_NAME = new RegExp('^\\s*slot\\s+' + TAIL + '*$', 'u');
const USE_NAME_OR_PATH = new RegExp('^\\s*use\\s+(?:\\S*|(?:"[^"]*"|/\\S+)\\s+as\\s+' + TAIL + '*)$', 'u');
const LOOP_SOURCE = new RegExp('^\\s*(?:for|each)\\s+' + WORD + '\\s+in\\s+', 'u');
const LOOP_IN = new RegExp('^\\s*(?:for|each)\\s+' + WORD + '\\s+' + TAIL + '*$', 'u');
const AFTER_CLOSE = new RegExp('^\\s*\\}\\s*' + TAIL + '*$', 'u');
const AFTER_ELSE = new RegExp('^\\s*(?:\\}\\s*)?else\\s+' + TAIL + '*$', 'u');
const EVENT_ENTRY = new RegExp('^\\s*' + WORD + '\\s*\\(([^)]*)$', 'u');
const DOTTED = new RegExp('^\\s*(' + WORD + ')\\.' + TAIL + '*$', 'u');
const NODE_ID = new RegExp('^\\s*@?(' + WORD + ')(?:\\.' + WORD + ')*\\s+' + TAIL + '*$', 'u');
const ROUTE_TAIL = new RegExp('^\\s*' + TAIL + '*$', 'u');
const EMIT_TARGET = new RegExp('^\\s*emit\\s+' + TAIL + '*$', 'u');
const EMIT_ARGUMENTS = new RegExp('^\\s*emit\\s+' + WORD + '\\s*\\(', 'u');

/** `line` is the text before the cursor on the current line. */
export function analyzeLine(line: string): LineContext {
    // An '@' glued to the tail: '@Acc' in value position, or a directive being spelled. '@slot Si'
    // does NOT land here -- its tail run is 'Si', the '@' is a word away.
    const reference = RESOURCE_REF_TAIL.exec(line);
    if (reference) {
        if (reference[1] === undefined && ANNOTATION_TAIL.test(line)) {
            return { kind: 'annotation' };
        }
        return reference[1] !== undefined ? { kind: 'resourceRef', namespace: reference[1] } : { kind: 'resourceRef' };
    }

    // The arrows before '=': `Shown <- A == B` holds an '=' that is an operator, and `Text = "a <- b"` an arrow that
    // is prose -- bindingTailOf passes over strings and comments, which is why it decides.
    const binding = bindingTailOf(line);
    if (binding) {
        if (binding.op !== '->') {
            return { kind: 'expression', op: binding.op };
        }
        if (EMIT_TARGET.test(binding.tail)) {
            return { kind: 'emitTarget' };
        }
        if (ROUTE_TAIL.test(binding.tail)) {
            return { kind: 'route' };
        }
        if (EMIT_ARGUMENTS.test(binding.tail)) {
            return { kind: 'expression', op: 'emit' };
        }
        return { kind: 'statement' };
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

    // A one-line block, `+ UIButton { TransitionType = No` or `@slot { SizeRule = Fill  Pad`: the statement being
    // typed is the one after the last '{', and an '@slot' in front of that brace makes it a slot line.
    const brace = line.lastIndexOf('{');
    if (brace >= 0 && !line.slice(brace).includes('}')) {
        const inner = line.slice(brace + 1);
        const inSlotBlock = /@slot\s*$/u.test(line.slice(0, brace));
        const inlineValue = INLINE_VALUE.exec(inner);
        if (inlineValue) {
            return { kind: 'value', property: inlineValue[1], isSlot: inSlotBlock };
        }
        if (inSlotBlock && INLINE_NAME.test(inner)) {
            return { kind: 'slotPropertyName' };
        }
    }

    // `use` first: a plugin path (`Plugin.Mine:Panels/X.dui`) holds a ':' that is no style clause.
    if (USE_NAME_OR_PATH.test(line)) {
        return { kind: 'nodeId' };
    }
    if (USE_AS.test(line)) {
        return { kind: 'keyword', words: ['as'] };
    }

    // A ':' on a line with no '=': a header's style clause. (A ':' inside a value string sits on
    // a line that has an '=', which is what keeps this branch out of values.)
    const styleRef = STYLE_REF_TAIL.exec(line);
    if (styleRef && !line.includes('=')) {
        return styleRef[1] !== undefined ? { kind: 'styleRef', namespace: styleRef[1] } : { kind: 'styleRef' };
    }

    if (SLOT_DEFAULT.test(line)) {
        return { kind: 'keyword', words: ['default'] };
    }
    if (SLOT_NAME.test(line)) {
        return { kind: 'slotName' };
    }
    if (LOOP_SOURCE.test(line) && !line.includes('{')) {
        return { kind: 'expression', op: 'in' };
    }
    if (LOOP_IN.test(line)) {
        return { kind: 'keyword', words: ['in'] };
    }
    if (AFTER_ELSE.test(line)) {
        return { kind: 'keyword', words: ['if'] };
    }
    if (AFTER_CLOSE.test(line)) {
        return { kind: 'keyword', words: ['else'] };
    }

    // `Picked(Number Index, ▌`: after '(' or ',' a type leads; after the type, the parameter's name.
    const entry = EVENT_ENTRY.exec(line);
    if (entry) {
        const segment = entry[1].slice(entry[1].lastIndexOf(',') + 1).replace(/^\s+/u, '');
        return { kind: 'eventParam', position: /\s/u.test(segment) ? 'name' : 'type' };
    }

    const dotted = DOTTED.exec(line);
    if (dotted) {
        return { kind: 'dotted', head: dotted[1] };
    }
    const nodeId = NODE_ID.exec(line);
    if (nodeId && !KEYWORDS.includes(nodeId[1])) {
        return { kind: 'nodeId' };
    }
    return { kind: 'statement' };
}
