# agy-connector

Connect local AI coding agents to Telegram — inspired by [cc-connect](https://github.com/chenhg5/cc-connect).

Routes your Telegram messages to the local `agy` CLI assistant and returns the results.

## Architecture

Follows cc-connect's modular adapter pattern:

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
│   └── telegram.js          # Telegram adapter
├── agent/                   # Agent adapters
│   └── agy.js               # Agy CLI adapter
└── bridge.js                # Entry point (wiring)
```

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. Install dependencies: `npm install`
3. Start the bridge: `npm start`

## Deploy (systemd)

Run the bridge as a system service (no containers needed, same approach as cc-connect):

```bash
# Copy the service file
sudo cp agy-connector.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable agy-connector
sudo systemctl start agy-connector

# Check status / logs
sudo systemctl status agy-connector
journalctl -u agy-connector -f
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Check system status and uptime |
| `/model` | Display agent/CLI information |
| `/stop` | Terminate the currently running task |
| `/new [name]` | Start a new conversation session |
| `/list` | List all conversation sessions |
| `/switch <id>` | Switch to a different session |
| `/delete <id>` | Delete a conversation session |
| `/version` | Show version information |

## Configuration

All configuration is done via environment variables (see `.env.example`).

## Extending

The project uses cc-connect's adapter pattern. To add support for a new platform or agent:

1. Create a new file in `platform/` or `agent/`
2. Extend the `Platform` or `Agent` base class from `core/interfaces.js`
3. Register it in `bridge.js` using `registerPlatform()` or `registerAgent()`

## License

MIT
