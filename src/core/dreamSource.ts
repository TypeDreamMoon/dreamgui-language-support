/**
 * Where a Dream language's sources and generated data live, per the DreamSource layout
 * (Plan/DreamSource/dreamsource-layout-spec.md, section 11 for this language).
 *
 *   <Project>/DreamSource/UI/                 the project's .dui sources (configurable)
 *   <Project>/DUI/                            the old place: still read, and asked to move
 *   <Plugin>/DreamSource/UI/, <Plugin>/DUI/   a plugin's, same rule, not configurable
 *   <Project>/Intermediate/DreamSource/ui.db  what the editor generates for us to read
 *
 * Pure: every function takes the filesystem as an argument, so the whole table is tested without
 * a disk. Written to be copied into the other Dream extensions; only DREAM_UI below is this
 * language's.
 */

/** One Dream language's names, as the layout spec's table spells them. */
export interface DreamLanguage {
    /** The language key: `UI`. Also the folder name under DreamSource/. */
    key: string;
    /** The folder a project or plugin used before DreamSource: `DUI`. */
    legacyName: string;
    /** The ini section the plugin's source-directory setting lives in. */
    settingsSection: string;
    /** The database file under Intermediate/DreamSource/. */
    databaseFile: string;
}

export const DREAM_UI: DreamLanguage = {
    key: 'UI',
    legacyName: 'DUI',
    settingsSection: '/Script/DreamGUI.DreamUISourceSettings',
    databaseFile: 'ui.db',
};

export const DREAM_SOURCE_DIRECTORY = 'DreamSource';
export const SETTINGS_INI = ['Config', 'DefaultDreamSource.ini'];
export const GENERATED_DIRECTORY = ['Intermediate', 'DreamSource'];

/** The few filesystem questions this module asks. */
export interface SourceFs {
    isDirectory(path: string): boolean;
    isFile(path: string): boolean;
    /** Undefined when the file cannot be read. */
    readText(path: string): string | undefined;
    /** Entry names, empty when the directory cannot be read. */
    list(path: string): string[];
}

export type Join = (...parts: string[]) => string;

export function defaultSourceDirectory(language: DreamLanguage): string {
    return `${DREAM_SOURCE_DIRECTORY}/${language.key}`;
}

/** A Windows drive, a UNC share or a rooted path: anything that is not relative to the project. */
export function isAbsoluteSetting(value: string): boolean {
    return /^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith('\\');
}

/**
 * The `SourceDirectory` of one section of DefaultDreamSource.ini, as the project-relative path it
 * names, or undefined when the section or key is missing, empty or absolute (an absolute path is
 * a path that works on one machine; the default stands in for it).
 *
 * Both spellings Unreal produces are read: `(Path="DreamSource/UI")`, which is how an
 * FDirectoryPath property saves, and a bare `DreamSource/UI`, which is how a person writes it.
 */
export function parseSourceDirectorySetting(iniText: string, section: string): string | undefined {
    let inSection = false;
    let found: string | undefined;
    for (const rawLine of iniText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) {
            continue;
        }
        const header = /^\[(.*)\]$/.exec(line);
        if (header) {
            inSection = header[1].trim().toLowerCase() === section.toLowerCase();
            continue;
        }
        if (!inSection) {
            continue;
        }
        const assignment = /^([+\-.!]?)([^=]+?)\s*=\s*(.*)$/.exec(line);
        if (!assignment || assignment[2].trim().toLowerCase() !== 'sourcedirectory') {
            continue;
        }
        if (assignment[1] === '-' || assignment[1] === '!') {
            found = undefined;
            continue;
        }
        // The last assignment wins, as it does when Unreal reads the file.
        found = unwrapDirectoryValue(assignment[3]);
    }
    if (found === undefined) {
        return undefined;
    }
    const normalized = found.replace(/\\/g, '/').replace(/\/+$/, '').trim();
    if (!normalized || isAbsoluteSetting(normalized)) {
        return undefined;
    }
    return normalized;
}

function unwrapDirectoryValue(raw: string): string {
    let value = raw.trim();
    const struct = /^\(\s*Path\s*=\s*(.*?)\s*\)$/i.exec(value);
    if (struct) {
        value = struct[1].trim();
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
    }
    return value;
}

/** The project directory: the nearest ancestor (or the directory itself) holding a .uproject. */
export function findProjectRoot(startDirectory: string, fs: SourceFs, dirname: (path: string) => string,
    maxHops = 12): string | undefined {
    let directory = startDirectory;
    for (let hop = 0; hop <= maxHops; hop++) {
        if (fs.list(directory).some((name) => name.toLowerCase().endsWith('.uproject'))) {
            return directory;
        }
        const parent = dirname(directory);
        if (parent === directory) {
            break;
        }
        directory = parent;
    }
    return undefined;
}

/**
 * Which of the two places the project's sources are read from, per the spec's table 11.2:
 *
 *   configured          only the configured directory exists
 *   configuredAndLegacy both exist: the configured one is used, the old one is ignored (and said so)
 *   legacy              only the old one exists: still used, and asked to move
 *   none                neither: anything that creates a source creates it in the configured one
 */
export type SourceRootState = 'configured' | 'configuredAndLegacy' | 'legacy' | 'none';

export interface ProjectSourceRoot {
    projectDir: string;
    /** The configured directory, absolute; where sources belong whether or not it exists yet. */
    configuredDir: string;
    /** The configured directory as written (project-relative), after defaults. */
    configuredSetting: string;
    /** `<Project>/DUI`, absolute. */
    legacyDir: string;
    state: SourceRootState;
    /** The directory sources are read from now; undefined for `none`. */
    activeDir: string | undefined;
}

export function readConfiguredSourceDirectory(projectDir: string, language: DreamLanguage, fs: SourceFs,
    join: Join): string {
    const text = fs.readText(join(projectDir, ...SETTINGS_INI));
    return (text !== undefined ? parseSourceDirectorySetting(text, language.settingsSection) : undefined)
        ?? defaultSourceDirectory(language);
}

export function resolveProjectSourceRoot(projectDir: string, language: DreamLanguage, fs: SourceFs,
    join: Join): ProjectSourceRoot {
    const configuredSetting = readConfiguredSourceDirectory(projectDir, language, fs, join);
    const configuredDir = join(projectDir, ...configuredSetting.split('/'));
    const legacyDir = join(projectDir, language.legacyName);
    const hasConfigured = fs.isDirectory(configuredDir);
    // A setting that names the old folder itself is not "both": it is the configured one.
    const hasLegacy = !samePath(configuredDir, legacyDir) && fs.isDirectory(legacyDir);
    let state: SourceRootState;
    if (hasConfigured) {
        state = hasLegacy ? 'configuredAndLegacy' : 'configured';
    } else {
        state = hasLegacy ? 'legacy' : 'none';
    }
    const activeDir = state === 'legacy' ? legacyDir : state === 'none' ? undefined : configuredDir;
    return { projectDir, configuredDir, configuredSetting, legacyDir, state, activeDir };
}

export interface PluginSourceRoot {
    plugin: string;
    directory: string;
    /** True when it is the plugin's old `DUI/`. */
    legacy: boolean;
}

/**
 * Every plugin under `<Project>/Plugins` (nested folders included, as Unreal allows) that has
 * sources: `<Plugin>/DreamSource/UI`, or failing that `<Plugin>/DUI`. Not configurable.
 */
export function pluginSourceRoots(projectDir: string, language: DreamLanguage, fs: SourceFs, join: Join,
    maxDepth = 3): PluginSourceRoot[] {
    const out: PluginSourceRoot[] = [];
    const visit = (directory: string, depth: number): void => {
        const entries = fs.list(directory);
        const descriptor = entries.find((name) => name.toLowerCase().endsWith('.uplugin'));
        if (descriptor) {
            const plugin = descriptor.slice(0, -'.uplugin'.length);
            const current = join(directory, DREAM_SOURCE_DIRECTORY, language.key);
            const legacy = join(directory, language.legacyName);
            if (fs.isDirectory(current)) {
                out.push({ plugin, directory: current, legacy: false });
            } else if (fs.isDirectory(legacy)) {
                out.push({ plugin, directory: legacy, legacy: true });
            }
            return; // a plugin does not hold plugins
        }
        if (depth >= maxDepth) {
            return;
        }
        for (const name of entries) {
            const child = join(directory, name);
            if (!name.startsWith('.') && fs.isDirectory(child)) {
                visit(child, depth + 1);
            }
        }
    };
    visit(join(projectDir, 'Plugins'), 0);
    return out;
}

export function generatedDirectory(projectDir: string, join: Join): string {
    return join(projectDir, ...GENERATED_DIRECTORY);
}

export function databasePath(projectDir: string, language: DreamLanguage, join: Join): string {
    return join(generatedDirectory(projectDir, join), language.databaseFile);
}

function normalizeForCompare(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Case-blind, slash-blind: what Windows means by "the same directory". */
export function samePath(a: string, b: string): boolean {
    return normalizeForCompare(a) === normalizeForCompare(b);
}

/** Whether `child` is `parent` or somewhere under it. */
export function isUnder(child: string, parent: string): boolean {
    const c = normalizeForCompare(child);
    const p = normalizeForCompare(parent);
    return c === p || c.startsWith(p + '/');
}

// ---- the old folder: saying so, and moving it ------------------------------------------------

/** What an older plugin generated inside the source folder; the editor's database replaces them. */
export const LEGACY_GENERATED_FILES = ['.dui-symbols.json', '.dui-diagnostics.json', '.dui-diagnostics.json.tmp'];

function displayRelative(root: ProjectSourceRoot): string {
    return `${root.configuredSetting.replace(/\/+$/, '')}/`;
}

/**
 * The one-line notice for a project still on (or still carrying) its old folder, per spec 11.2;
 * undefined when there is nothing to say.
 */
export function deprecationNotice(root: ProjectSourceRoot, language: DreamLanguage): string | undefined {
    const legacy = `${language.legacyName}/`;
    const target = displayRelative(root);
    switch (root.state) {
        case 'legacy':
            return `${legacy} is deprecated. Move it to ${target} -- Dream sources now live together under `
                + `${DREAM_SOURCE_DIRECTORY}/. It keeps working until you do.`;
        case 'configuredAndLegacy':
            return `${legacy} is ignored because ${target} exists. Merge what is in it into ${target} and delete it.`;
        default:
            return undefined;
    }
}

export type MigrationPlan =
    | { ok: true; from: string; to: string; staleFiles: string[] }
    | { ok: false; reason: string };

/**
 * Whether the old folder can be moved to the configured one: only from the `legacy` state (moving
 * onto an existing folder would be a merge, which is the author's call), and only with no editor
 * running (it holds the folder open and keeps writing into it).
 */
export function planMigration(root: ProjectSourceRoot, language: DreamLanguage, editorRunning: boolean,
    join: Join): MigrationPlan {
    const legacy = `${language.legacyName}/`;
    const target = displayRelative(root);
    switch (root.state) {
        case 'configured':
            return { ok: false, reason: `The project already uses ${target}; there is no ${legacy} to move.` };
        case 'none':
            return { ok: false, reason: `The project has no ${legacy} to move.` };
        case 'configuredAndLegacy':
            return { ok: false, reason: `${target} already exists, so moving ${legacy} onto it would be a merge. `
                + `Merge the two by hand and delete ${legacy}.` };
        case 'legacy':
            break;
    }
    if (editorRunning) {
        return { ok: false, reason: `The Unreal editor has this project open. Close it first: it holds ${legacy} `
            + 'open and keeps writing into it.' };
    }
    return {
        ok: true,
        from: root.legacyDir,
        to: root.configuredDir,
        staleFiles: LEGACY_GENERATED_FILES.map((name) => join(root.configuredDir, name)),
    };
}

// ---- the database's rows, back into the shapes the old JSON files had ------------------------

export interface SymbolRow {
    section: string;
    name: string;
    json: string;
}

/**
 * The `symbols` table back into the object `.dui-symbols.json` held (spec 11.3): a row named ''
 * IS its section's value (an array, a number, an empty object); rows with a name are the members
 * of an object section. A row whose JSON does not parse costs that row, not the dump.
 */
export function reassembleSymbols(rows: readonly SymbolRow[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const isObject = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
    for (const row of rows) {
        let value: unknown;
        try {
            value = JSON.parse(row.json);
        } catch {
            continue;
        }
        const existing = out[row.section];
        if (row.name === '') {
            out[row.section] = isObject(existing) && isObject(value) ? { ...value, ...existing } : value;
        } else {
            const target = isObject(existing) ? existing : {};
            target[row.name] = value;
            out[row.section] = target;
        }
    }
    return out;
}

export interface DiagnosticRow {
    path: string;
    compiled_at_utc: string;
    json: string;
}

/**
 * The `diagnostics` table as the text of a version-1 mailbox, so it goes through the same
 * parseMailbox the JSON file did and nothing downstream knows the difference. A row whose JSON
 * does not parse is dropped (its file shows no news, as a missing entry always meant).
 */
export function diagnosticRowsToMailboxText(rows: readonly DiagnosticRow[]): string {
    const files: Record<string, unknown> = {};
    for (const row of rows) {
        let diagnostics: unknown;
        try {
            diagnostics = JSON.parse(row.json);
        } catch {
            continue;
        }
        files[row.path] = { compiledAt: row.compiled_at_utc, diagnostics: Array.isArray(diagnostics) ? diagnostics : [] };
    }
    return JSON.stringify({ version: 1, files });
}

/** The meta table's revisions, as numbers; a missing or unreadable one is undefined. */
export interface DatabaseRevisions {
    schema: number | undefined;
    revision: number | undefined;
    symbols: number | undefined;
    diagnostics: number | undefined;
}

/** The `ui.db` schema this extension reads; any other is left alone and said so. */
export const SUPPORTED_SCHEMA = 1;

export function revisionsFromMeta(rows: readonly { key: string; value: string }[]): DatabaseRevisions {
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const number = (key: string): number | undefined => {
        const value = map.get(key);
        if (value === undefined) {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    };
    return {
        schema: number('schema'),
        revision: number('revision'),
        symbols: number('symbols_revision'),
        diagnostics: number('diagnostics_revision'),
    };
}
