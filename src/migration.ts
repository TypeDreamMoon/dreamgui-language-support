/**
 * The old `DUI/` folder: said once per project per window (spec 11.5), with a way to move it and a
 * way to stop hearing about it. The decisions -- what to say, whether a move is safe -- are
 * core/dreamSource's; this file asks the window and does the move.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DREAM_UI, deprecationNotice, planMigration, samePath } from './core/dreamSource';
import { canServe } from './core/bridgeProtocol';
import { BridgeClient } from './bridge';
import { DreamSourceHost } from './dreamSourceHost';

const DISMISSED_KEY = 'dreamui.dreamSource.dismissed';
const MIGRATE = 'Migrate to DreamSource';
const DONT_SHOW = "Don't show again";

function dismissalKey(projectDir: string, state: string): string {
    return `${state}|${projectDir.replace(/\\/g, '/').toLowerCase()}`;
}

export function registerDreamSourceMigration(context: vscode.ExtensionContext, host: DreamSourceHost,
    bridge: BridgeClient, onMigrated: (projectDir: string) => void): void {
    const asked = new Set<string>();

    const isDismissed = (key: string): boolean =>
        (context.globalState.get<string[]>(DISMISSED_KEY) ?? []).includes(key);
    const dismiss = async (key: string): Promise<void> => {
        const current = context.globalState.get<string[]>(DISMISSED_KEY) ?? [];
        if (!current.includes(key)) {
            await context.globalState.update(DISMISSED_KEY, [...current, key]);
        }
    };

    const migrate = async (projectDir: string): Promise<void> => {
        const root = host.sourceRoot(projectDir);
        const plan = planMigration(root, DREAM_UI, canServe(bridge.livenessForProject(projectDir)), path.join);
        if (!plan.ok) {
            void vscode.window.showWarningMessage(`DreamUI: ${plan.reason}`);
            return;
        }
        try {
            fs.mkdirSync(path.dirname(plan.to), { recursive: true });
            fs.renameSync(plan.from, plan.to);
        } catch (error) {
            void vscode.window.showErrorMessage(`DreamUI: could not move ${plan.from} to ${plan.to}: `
                + `${(error as Error).message}. A file in it may be open in another program.`);
            return;
        }
        for (const stale of plan.staleFiles) {
            try {
                fs.rmSync(stale, { force: true });
            } catch {
                // Left behind is harmless: nothing reads it once the editor writes ui.db.
            }
        }
        host.invalidate();
        onMigrated(projectDir);
        const reopened = vscode.workspace.workspaceFolders?.some((folder) =>
            samePath(folder.uri.fsPath, plan.from) || folder.uri.fsPath.toLowerCase().startsWith(
                plan.from.toLowerCase() + path.sep));
        void vscode.window.showInformationMessage(`DreamUI: moved ${plan.from} to ${plan.to}.`
            + (reopened ? ' This window was opened on the old folder; reopen it from the new one.' : '')
            + ' Files open from the old folder need opening again.');
    };

    const check = (documentPath: string | undefined): void => {
        const projectDir = host.projectDirFor(documentPath);
        if (!projectDir) {
            return;
        }
        const root = host.sourceRoot(projectDir);
        const notice = deprecationNotice(root, DREAM_UI);
        const key = dismissalKey(projectDir, root.state);
        if (!notice || asked.has(key) || isDismissed(key)) {
            return;
        }
        asked.add(key);
        const actions = root.state === 'legacy' ? [MIGRATE, DONT_SHOW] : [DONT_SHOW];
        void vscode.window.showWarningMessage(`DreamUI: ${notice}`, ...actions).then(async (choice) => {
            if (choice === MIGRATE) {
                await migrate(projectDir);
            } else if (choice === DONT_SHOW) {
                await dismiss(key);
            }
        });
    };

    context.subscriptions.push(vscode.commands.registerCommand('dreamui.migrateToDreamSource', async () => {
        const projectDir = host.projectDirFor(vscode.window.activeTextEditor?.document.uri.fsPath);
        if (!projectDir) {
            void vscode.window.showWarningMessage('DreamUI: no Unreal project (.uproject) found for this window.');
            return;
        }
        await migrate(projectDir);
    }));

    check(vscode.window.activeTextEditor?.document.uri.fsPath);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'dui') {
            check(editor.document.uri.fsPath);
        }
    }));
}
