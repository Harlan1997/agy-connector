# 🔗 agy-connector

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4.svg?logo=telegram)](https://core.telegram.org/bots)

**Connect your local AI coding agent to Telegram.** Chat with your AI assistant from anywhere — on the go, from your phone, or across devices.

> Inspired by [cc-connect](https://github.com/chenhg5/cc-connect). Lightweight, extensible, and zero-cloud — your agent runs locally, you just talk to it remotely.

## ✨ Features

- 📱 **Remote Access** — Talk to your local AI coding agent from anywhere via Telegram
- 🔄 **Real-time Streaming** — See agent activity and progress as it works
- 💬 **Multi-session** — Manage multiple conversation sessions with persistent history
- 🔌 **Pluggable Architecture** — Adapter pattern for platforms and agents (easy to extend)
- ⚡ **Lightweight** — Pure Node.js, no containers needed, runs as a systemd service
- 🛡️ **Secure** — User whitelist, rate limiting, and no cloud dependencies
- 🎯 **Session Management** — Create, switch, list, and delete conversation sessions via Telegram commands

## 🏗️ Architecture

```
┌──────────┐       ┌───────────────────┐       ┌──────────────┐
│ Telegram │◄─────►│   agy-connector   │◄─────►│  Local Agent  │
│   App    │  Bot  │  (bridge/router)  │  PTY  │  (agy CLI)   │
└──────────┘  API  └───────────────────┘       └──────────────┘
                            │
                    ┌───────┴───────┐
                    │   Features    │
                    ├───────────────┤
                    │ • Sessions    │
                    │ • Rate Limit  │
                    │ • Hooks       │
                    │ • Registry    │
                    └───────────────┘
```

### Project Structure

```
agy-connector/
├── core/                    # Core interfaces & engine
│   ├── interfaces.js        # Platform & Agent abstract base classes
│   ├── engine.js            # Message routing engine
│   ├── config.js            # Structured config loader
│   ├── session.js           # Session manager with persistence
│   ├── hooks.js             # Lifecycle event hooks
│   ├── registry.js          # Plugin registry for adapters
│   ├── rate_limiter.js      # Per-session rate limiting
│   ├── logger.js            # Structured logging
│   └── utils.js             # Shared utilities
├── platform/                # Platform adapters
│   └── telegram.js          # Telegram adapter (grammY)
├── agent/                   # Agent adapters
│   └── agy.js               # Agy CLI adapter (PTY-based)
└── bridge.js                # Entry point (wiring)
```

## 🚀 Quick Start

### 1. Get a Telegram Bot Token

Chat with [@BotFather](https://t.me/BotFather) on Telegram and create a new bot.

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your bot token and settings
```

### 3. Install & Run

```bash
npm install
npm start
```

That's it! Send a message to your bot on Telegram and it will be routed to your local AI agent.

## 📋 Telegram Commands

| Command | Description |
|---------|-------------|
| `/help`, `/start` | Show available commands |
| `/status` | Check system status and uptime |
| `/model` | Select AI model |
| `/stop` | Terminate the currently running task |
| `/new [name]` | Start a new conversation session |
| `/list` | List all conversation sessions |
| `/switch <id>` | Switch to a different session |
| `/delete <id>` | Delete a conversation session |
| `/project`, `/projects` | Manage workspaces / projects |
| `/version` | Show version and agent/CLI information |

### Workspaces / Projects Subcommands

- `/project` or `/project list` — List all workspaces
- `/project create <path>` — Create and activate a workspace at `<path>`
- `/project switch <name>` — Switch to a workspace by name or ID
- `/project delete <name>` — Delete a workspace by name or ID

## 🔧 Deploy as Service (systemd)

Run the bridge as a persistent system service — no containers needed:

```bash
# Create and edit the service file for your environment
sudo cp agy-connector.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable agy-connector
sudo systemctl start agy-connector

# Check status / logs
sudo systemctl status agy-connector
journalctl -u agy-connector -f
```

## ⚙️ Configuration

All configuration is done via environment variables. See [`.env.example`](.env.example) for all available options:

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token | (required) |
| `ALLOWED_USER_IDS` | Comma-separated list of allowed user IDs | (all users) |
| `AGY_PATH` | Path to the agent CLI binary | `agy` |
| `WORKSPACE_DIR` | Working directory for the agent | `/home/user` |
| `MAX_CONCURRENT` | Maximum concurrent agent tasks | `1` |
| `AGENT_TIMEOUT` | Agent timeout in minutes | `10` |
| `LOG_LEVEL` | Log level: debug, info, warn, error | `info` |

## 🧩 Extending

The project uses a modular adapter pattern. To add support for a new platform or agent:

1. Create a new file in `platform/` or `agent/`
2. Extend the `Platform` or `Agent` base class from `core/interfaces.js`
3. Register it in `bridge.js` using `registerPlatform()` or `registerAgent()`

For example, you could add a Discord adapter, a Slack adapter, or swap in a different AI agent backend.

## 📄 License

[MIT](LICENSE)
