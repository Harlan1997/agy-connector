"use strict";

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
const sessions = new SessionManager(
  path.join(process.env.HOME || ".", ".agy-telegram-bridge", "sessions.json")
);
const hooks = new HookManager();
const rateLimiter = new RateLimiter(config.rateLimit.maxMessages, config.rateLimit.windowMs);

// ---- Start engine ----
const engine = new Engine({ platform, agent, config, sessions, hooks, rateLimiter });
engine.start().catch(err => {
  console.error("Bridge failed to start:", err);
  process.exit(1);
});
