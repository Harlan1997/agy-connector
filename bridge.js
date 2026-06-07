"use strict";

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./core/config");
const { setLogLevel } = require("./core/logger");
const { Engine } = require("./core/engine");
const { SessionManager } = require("./core/session");
const { HookManager } = require("./core/hooks");
const { RateLimiter } = require("./core/rate_limiter");
const { registerPlatform, registerAgent } = require("./core/registry");
const { TelegramPlatform } = require("./platform/telegram");
const { AgyAgentSession } = require("./agent/agy");

// ---- Load config ----
const config = loadConfig();
setLogLevel(config.log.level);

// ---- Register adapters (mirrors cc-connect plugin init()) ----
registerPlatform("telegram", (cfg) => new TelegramPlatform(cfg));
registerAgent("agy", (cfg) => new AgyAgentSession(cfg));

// ---- Create components via dependency injection ----
const platform = new TelegramPlatform(config.telegram);
const agent = new AgyAgentSession(config.agent);

// Migrate old session directory if it exists and new one does not
const oldSessionDir = path.join(process.env.HOME || ".", ".agy-tg-connector");
const newSessionDir = path.join(process.env.HOME || ".", ".antigravity-telegram");
const oldSessionPath = path.join(oldSessionDir, "sessions.json");
const newSessionPath = path.join(newSessionDir, "sessions.json");

if (!fs.existsSync(newSessionPath) && fs.existsSync(oldSessionPath)) {
  if (!fs.existsSync(newSessionDir)) {
    fs.mkdirSync(newSessionDir, { recursive: true });
  }
  try {
    fs.renameSync(oldSessionPath, newSessionPath);
    try { fs.rmdirSync(oldSessionDir); } catch (e) {}
  } catch (e) {
    // ignore migration error and let SessionManager initialize
  }
}

const sessions = new SessionManager(newSessionPath, config.agent.workspaceDir);
const hooks = new HookManager();
const rateLimiter = new RateLimiter(config.rateLimit.maxMessages, config.rateLimit.windowMs);

// ---- Start engine ----
const engine = new Engine({ platform, agent, config, sessions, hooks, rateLimiter });
engine.start().catch(err => {
  console.error("Bridge failed to start:", err);
  process.exit(1);
});
