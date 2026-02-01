# Cursor Usage Monitor

A lightweight VS Code / Cursor extension that displays your Cursor Pro premium model usage in the status bar.

## Features

- **Status Bar Display**: Shows remaining premium requests (Opus, Sonnet, etc.)
- **Quick Pick Details**: Click to see breakdown by model type
- **Auto Refresh**: Updates every 60 seconds (configurable)
- **Color Indicators**:
  - 🟢 Green: > 30% remaining
  - 🟡 Yellow: 10-30% remaining  
  - 🔴 Red: < 10% remaining

## Installation

### From VSIX

```bash
cursor --install-extension cursor-usage-monitor-0.1.0.vsix
```

### From Source

```bash
git clone https://github.com/ben-milanko/cursor-usage-monitor.git
cd cursor-usage-monitor
npm install
npm run compile
```

Then press F5 in Cursor to launch in development mode.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `cursorUsage.refreshInterval` | 60 | Refresh interval in seconds (min: 10) |
| `cursorUsage.showPercentage` | true | Show as percentage vs count |

## How It Works

The extension reads your Cursor session token from the local database and queries the Cursor API at `cursor.com/api/usage` to fetch your current usage statistics.

**Models tracked:**
- Premium (Fast) - Your fast premium requests (Opus, Sonnet, etc.)
- Standard - GPT-3.5 turbo requests
- Usage-Based - Pay-per-use requests beyond your plan

## Commands

- **Cursor Usage: Refresh** - Force refresh usage data
- **Cursor Usage: Show Details** - Show detailed breakdown

## Requirements

- Cursor IDE (or VS Code with Cursor backend)
- Active Cursor Pro subscription

## License

MIT
