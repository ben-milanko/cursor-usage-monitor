import * as vscode from 'vscode';
import { UsageMonitor } from './usageMonitor';

let usageMonitor: UsageMonitor | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Cursor Usage Monitor activated');

    usageMonitor = new UsageMonitor(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('cursor-usage.refresh', () => {
            usageMonitor?.refresh();
        }),
        vscode.commands.registerCommand('cursor-usage.showDetails', () => {
            usageMonitor?.showDetails();
        })
    );

    usageMonitor.start();
}

export function deactivate() {
    usageMonitor?.dispose();
}
