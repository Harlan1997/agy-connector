"use strict";

require("dotenv").config();
const { createLogger } = require("./logger");
const { redactToken } = require("./utils");

const log = createLogger("config");

/**
 * Load and validate configuration from environment variables.
 * Returns a structured config matching cc-connect's project shape.
 * Mirrors cc-connect config.toml [[projects]] structure.
 */
function loadConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.error("FATAL: TELEGRAM_BOT_TOKEN is not set");
    process.exit(1);
  }

  const config = {
    // Project name (mirrors cc-connect [[projects]].name)
    name: process.env.PROJECT_NAME || "antigravity-telegram",

    // Platform configuration (mirrors [[projects.platforms]])
    telegram: {
      token,
      allowedUserIds: (process.env.ALLOWED_USER_IDS || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),
      plainText: process.env.TELEGRAM_PLAIN_TEXT === "true",
    },

    // Agent configuration (mirrors [projects.agent])
    agent: {
      type: "agy",
      agyPath: process.env.AGY_PATH || "agy",
      workspaceDir: process.env.WORKSPACE_DIR || process.env.HOME,
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT || "1", 10),
      timeout: process.env.AGENT_TIMEOUT || "10",
    },

    // Rate limiting (mirrors [rate_limit])
    rateLimit: {
      maxMessages: parseInt(process.env.RATE_LIMIT_MAX || "20", 10),
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || "60", 10) * 1000,
    },

    // Logging (mirrors [log])
    log: {
      level: process.env.LOG_LEVEL || "info",
    },
  };

  // Log configuration summary with redacted secrets
  log.info(`project: ${config.name}`);
  log.info(`platform: telegram (token: ${redactToken(config.telegram.token)}, plainText: ${config.telegram.plainText})`);
  log.info(`agent: ${config.agent.type} (path: ${config.agent.agyPath})`);
  log.info(`workspace: ${config.agent.workspaceDir}`);
  log.info(`allowed users: ${config.telegram.allowedUserIds.join(", ") || "(all)"}`);
  log.info(`max concurrent: ${config.agent.maxConcurrent}`);

  return config;
}

module.exports = { loadConfig };
