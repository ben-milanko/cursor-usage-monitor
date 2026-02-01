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
    'gpt-4': UsageData;
    'gpt-3.5-turbo': UsageData;
    'gpt-4-32k': UsageData;
    startOfMonth: string;
    [key: string]: UsageData | string;
}

interface ModelUsage {
    name: string;
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
            const token = await this.getSessionToken();
            if (!token) {
                this.statusBarItem.text = '$(warning) Cursor: Not signed in';
                this.statusBarItem.show();
                return;
            }

            const usage = await this.fetchUsage(token);
            this.lastUsage = usage.models;
            this.startOfMonth = usage.startOfMonth;
            this.updateStatusBar(usage.models);
        } catch (error) {
            console.error('Failed to fetch usage:', error);
            this.statusBarItem.text = '$(error) Cursor: Error';
            this.statusBarItem.show();
        }
    }

    private async getSessionToken(): Promise<string | undefined> {
        // Cursor stores session token in SQLite DB
        const dbPaths = this.getPossibleDbPaths();
        
        for (const dbPath of dbPaths) {
            try {
                if (!fs.existsSync(dbPath)) continue;
                
                // Read file buffer
                const fileBuffer = fs.readFileSync(dbPath);
                
                // Initialize sql.js
                const SQL = await initSqlJs();
                const db = new SQL.Database(fileBuffer);
                
                try {
                    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
                    if (stmt.step()) {
                        const row = stmt.getAsObject();
                        if (row && row.value) {
                             // Token is stored as JSON string
                            const parsed = JSON.parse(row.value as string);
                            if (typeof parsed === 'string') {
                                return parsed;
                            }
                            return parsed.accessToken || parsed;
                        }
                    }
                    stmt.free();
                } finally {
                    db.close();
                }
            } catch (err) {
                console.error(`Failed to read token from ${dbPath}:`, err);
            }
        }
        
        return undefined;
    }

    private getPossibleDbPaths(): string[] {
        const home = os.homedir();
        const paths: string[] = [];
        
        if (process.platform === 'darwin') {
            paths.push(
                path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'),
                path.join(home, 'Library/Application Support/Cursor/User/globalStorage/storage.json')
            );
        } else if (process.platform === 'win32') {
            const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
            paths.push(
                path.join(appData, 'Cursor/User/globalStorage/state.vscdb')
            );
        } else {
            paths.push(
                path.join(home, '.config/Cursor/User/globalStorage/state.vscdb')
            );
        }
        
        return paths;
    }

    private async fetchUsage(token: string): Promise<{ models: ModelUsage[], startOfMonth: string }> {
        return new Promise((resolve, reject) => {
            const userId = token.split('%3A%3A')[0];
            const url = `https://cursor.com/api/usage?user=${encodeURIComponent(userId)}`;
            
            const req = https.request(url, {
                method: 'GET',
                headers: {
                    'Cookie': `WorkosCursorSessionToken=${token}`,
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
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
        
        // Map API keys to friendly names
        const modelNames: Record<string, string> = {
            'gpt-4': 'Premium (Fast)',
            'gpt-3.5-turbo': 'Standard',
            'gpt-4-32k': 'Usage-Based'
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

            models.push({ name, used, limit, percentage });
        }

        // Sort by percentage used (highest first)
        models.sort((a, b) => {
            if (a.percentage === null) return 1;
            if (b.percentage === null) return -1;
            return b.percentage - a.percentage;
        });

        return models;
    }

    private updateStatusBar(models: ModelUsage[]) {
        // Find the premium model (gpt-4 / fast requests)
        const premium = models.find(m => m.name === 'Premium (Fast)');
        
        if (!premium) {
            this.statusBarItem.text = '$(pulse) Cursor: No data';
            this.statusBarItem.show();
            return;
        }

        const config = vscode.workspace.getConfiguration('cursorUsage');
        const showPct = config.get('showPercentage', true);
        
        let icon = '$(check)';
        let text: string;
        
        if (premium.limit && premium.percentage !== null) {
            const remaining = premium.limit - premium.used;
            const remainingPct = 100 - premium.percentage;
            
            if (remainingPct <= 10) {
                icon = '$(error)';
            } else if (remainingPct <= 30) {
                icon = '$(warning)';
            }
            
            text = showPct 
                ? `${icon} Cursor: ${remainingPct}% left`
                : `${icon} Cursor: ${remaining}/${premium.limit}`;
        } else {
            text = `${icon} Cursor: ${premium.used} used`;
        }

        this.statusBarItem.text = text;
        this.statusBarItem.show();
    }

    async showDetails() {
        if (this.lastUsage.length === 0) {
            vscode.window.showInformationMessage('No usage data available. Try refreshing.');
            return;
        }

        const items: vscode.QuickPickItem[] = this.lastUsage.map(m => {
            let description: string;
            let icon: string;
            
            if (m.limit && m.percentage !== null) {
                const remaining = m.limit - m.used;
                const remainingPct = 100 - m.percentage;
                
                if (remainingPct <= 10) {
                    icon = '🔴';
                } else if (remainingPct <= 30) {
                    icon = '🟡';
                } else {
                    icon = '🟢';
                }
                
                description = `${remaining}/${m.limit} remaining (${remainingPct}%)`;
            } else {
                icon = '⚪';
                description = `${m.used} requests used`;
            }

            return {
                label: `${icon} ${m.name}`,
                description
            };
        });

        // Add billing cycle info
        if (this.startOfMonth) {
            const start = new Date(this.startOfMonth);
            items.unshift({
                label: '📅 Billing Cycle',
                description: `Started ${start.toLocaleDateString()}`
            });
        }

        await vscode.window.showQuickPick(items, {
            title: 'Cursor Pro Usage',
            placeHolder: 'Premium model usage this billing cycle'
        });
    }

    dispose() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.statusBarItem.dispose();
    }
}
