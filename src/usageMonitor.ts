import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import initSqlJs = require('sql.js');

interface UsageData {
    numRequests: number;
    numTokens: number;
    maxRequestUsage: number | null;
}

interface CursorUsageResponse {
    [key: string]: UsageData | string;
    startOfMonth: string;
}

interface ModelUsage {
    name: string;
    key: string;
    used: number;
    limit: number | null;
    percentage: number | null;
}

export class UsageMonitor {
    private statusBarItem: vscode.StatusBarItem;
    private refreshTimer?: NodeJS.Timeout;
    private lastUsage: ModelUsage[] = [];
    private startOfMonth?: string;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'cursor-usage.showDetails';
        this.statusBarItem.tooltip = 'Click for usage details';
        context.subscriptions.push(this.statusBarItem);
    }

    start() {
        this.refresh();
        const config = vscode.workspace.getConfiguration('cursorUsage');
        const intervalSec = Math.max(config.get('refreshInterval', 60), 10);
        this.refreshTimer = setInterval(() => this.refresh(), intervalSec * 1000);
    }

    async refresh() {
        try {
            console.log('[CursorUsage] Refreshing usage data...');
            const auth = await this.getAuthDetails();
            if (!auth) {
                console.log('[CursorUsage] Not signed in');
                this.statusBarItem.text = '$(warning) Cursor: Not signed in';
                this.statusBarItem.show();
                return;
            }

            const usage = await this.fetchUsage(auth.token, auth.userId, auth.sub);
            this.lastUsage = usage.models;
            this.startOfMonth = usage.startOfMonth;
            this.updateStatusBar(usage.models);
        } catch (error: any) {
            console.error('[CursorUsage] Refresh Error:', error);
            this.statusBarItem.text = '$(error) Cursor: Error';
            this.statusBarItem.show();
        }
    }

    private async getAuthDetails(): Promise<{ token: string, userId: string, sub: string } | undefined> {
        const dbPaths = this.getPossibleDbPaths();
        
        for (const dbPath of dbPaths) {
            try {
                if (!fs.existsSync(dbPath)) continue;
                if (!dbPath.endsWith('.vscdb')) continue;

                const fileBuffer = fs.readFileSync(dbPath);
                const SQL = await initSqlJs();
                const db = new SQL.Database(fileBuffer);
                
                try {
                    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
                    if (stmt.step()) {
                        const row = stmt.getAsObject();
                        if (row && row.value) {
                            const valueStr = row.value as string;
                            let token = valueStr;
                            try {
                                const parsed = JSON.parse(valueStr);
                                token = (typeof parsed === 'string') ? parsed : (parsed.accessToken || parsed);
                            } catch (e) {}

                            // Extract sub from JWT
                            const parts = token.split('.');
                            if (parts.length === 3) {
                                const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
                                const sub = payload.sub;
                                const userId = sub.includes('|') ? sub.split('|')[1] : sub;
                                return { token, userId, sub };
                            }
                        }
                    }
                    stmt.free();
                } finally {
                    db.close();
                }
            } catch (err) {
                console.error(`[CursorUsage] DB Read Error (${dbPath}):`, err);
            }
        }
        
        return undefined;
    }

    private getPossibleDbPaths(): string[] {
        const home = os.homedir();
        if (process.platform === 'darwin') {
            return [path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')];
        } else if (process.platform === 'win32') {
            const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
            return [path.join(appData, 'Cursor/User/globalStorage/state.vscdb')];
        } else {
            return [path.join(home, '.config/Cursor/User/globalStorage/state.vscdb')];
        }
    }

    private async fetchUsage(token: string, userId: string, sub: string): Promise<{ models: ModelUsage[], startOfMonth: string }> {
        return new Promise((resolve, reject) => {
            // The cookie MUST be formatted as userId::token
            const sessionToken = `${userId}%3A%3A${token}`;
            const url = `https://cursor.com/api/usage?user=${encodeURIComponent(sub)}`;
            
            const req = https.request(url, {
                method: 'GET',
                headers: {
                    'Cookie': `WorkosCursorSessionToken=${sessionToken}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    'Origin': 'https://cursor.com',
                    'Referer': 'https://cursor.com/dashboard'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        if (res.statusCode !== 200) {
                            throw new Error(`API error ${res.statusCode}: ${data}`);
                        }
                        const json: CursorUsageResponse = JSON.parse(data);
                        const models = this.parseUsage(json);
                        resolve({ models, startOfMonth: json.startOfMonth });
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }

    private parseUsage(data: CursorUsageResponse): ModelUsage[] {
        const models: ModelUsage[] = [];
        const modelNames: Record<string, string> = {
            'gpt-4': 'Premium (Fast)',
            'gpt-3.5-turbo': 'Standard',
            'gpt-4-32k': 'Usage-Based',
            'claude-3-opus': 'Opus',
            'claude-3.5-sonnet': 'Sonnet',
            'claude-4.5-opus-high-thinking': 'Opus 4.5'
        };

        for (const [key, value] of Object.entries(data)) {
            if (key === 'startOfMonth' || typeof value === 'string') continue;
            
            const usage = value as UsageData;
            const name = modelNames[key] || key;
            const limit = usage.maxRequestUsage;
            const used = usage.numRequests;
            
            let percentage: number | null = null;
            if (limit && limit > 0) {
                percentage = Math.round((used / limit) * 100);
            }

            models.push({ name, key, used, limit, percentage });
        }

        models.sort((a, b) => (b.percentage || 0) - (a.percentage || 0));
        return models;
    }

    private updateStatusBar(models: ModelUsage[]) {
        // Find Premium or Opus or Sonnet
        const prioritizedKeys = ['gpt-4', 'claude-3-opus', 'claude-4.5-opus-high-thinking', 'claude-3.5-sonnet'];
        let model: ModelUsage | undefined;
        
        for (const key of prioritizedKeys) {
            model = models.find(m => m.key === key);
            if (model) break;
        }

        if (!model) {
            model = models.find(m => m.limit !== null) || models[0];
        }

        if (!model) {
            this.statusBarItem.text = '$(pulse) Cursor: No data';
            this.statusBarItem.show();
            return;
        }

        const config = vscode.workspace.getConfiguration('cursorUsage');
        const showPct = config.get('showPercentage', true);
        
        let icon = '$(check)';
        let text: string;
        
        if (model.limit && model.percentage !== null) {
            const remaining = model.limit - model.used;
            const remainingPct = 100 - model.percentage;
            icon = remainingPct <= 10 ? '$(error)' : (remainingPct <= 30 ? '$(warning)' : '$(check)');
            text = showPct ? `Cursor: ${remainingPct}% left` : `Cursor: ${remaining}/${model.limit}`;
        } else {
            text = `Cursor: ${model.used} used`;
        }

        this.statusBarItem.text = `${icon} ${text}`;
        this.statusBarItem.show();
    }

    async showDetails() {
        if (this.lastUsage.length === 0) {
            vscode.window.showInformationMessage('No usage data available.');
            return;
        }

        const items: vscode.QuickPickItem[] = this.lastUsage.map(m => {
            let description: string;
            let icon: string;
            
            if (m.limit && m.percentage !== null) {
                const remaining = m.limit - m.used;
                const remainingPct = 100 - m.percentage;
                icon = remainingPct <= 10 ? '🔴' : (remainingPct <= 30 ? '🟡' : '🟢');
                description = `${remaining}/${m.limit} remaining (${remainingPct}%)`;
            } else {
                icon = '⚪';
                description = `${m.used} requests used`;
            }

            return { label: `${icon} ${m.name}`, description };
        });

        if (this.startOfMonth) {
            items.unshift({ label: '📅 Billing Cycle', description: `Started ${new Date(this.startOfMonth).toLocaleDateString()}` });
        }

        await vscode.window.showQuickPick(items, { title: 'Cursor Pro Usage' });
    }

    dispose() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.statusBarItem.dispose();
    }
}
