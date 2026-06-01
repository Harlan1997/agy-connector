"use strict";

const { exec } = require("child_process");
const { createLogger } = require("./logger");

const log = createLogger("hooks");

// Supported hook events (mirrors cc-connect hook events)
const HookEvents = {
  MESSAGE_RECEIVED: "message.received",
  MESSAGE_SENT: "message.sent",
  SESSION_STARTED: "session.started",
  SESSION_ENDED: "session.ended",
  ERROR: "error",
};

/**
 * HookManager manages lifecycle event hooks.
 * Mirrors cc-connect core.HookManager.
 */
class HookManager {
  constructor() {
    this._hooks = [];
  }

  /**
   * Register a hook.
   * @param {Object} hook - { event, type: "command"|"http", command?, url?, async?, timeout? }
   */
  add(hook) {
    this._hooks.push({
      event: hook.event || "*",
      type: hook.type || "command",
      command: hook.command || "",
      url: hook.url || "",
      async: hook.async !== false, // default true (fail-open)
      timeout: hook.timeout || 10,
    });
  }

  /**
   * Emit an event, triggering matching hooks.
   * @param {Object} event - { event, sessionKey?, platform?, userId?, userName?, content?, error?, extra? }
   */
  emit(event) {
    for (const hook of this._hooks) {
      if (hook.event !== "*" && hook.event !== event.event) continue;

      if (hook.type === "command" && hook.command) {
        const env = {
          ...process.env,
          CC_HOOK_EVENT: event.event || "",
          CC_HOOK_SESSION_KEY: event.sessionKey || "",
          CC_HOOK_PLATFORM: event.platform || "",
          CC_HOOK_USER_ID: event.userId || "",
          CC_HOOK_USER_NAME: event.userName || "",
          CC_HOOK_CONTENT: event.content || "",
          CC_HOOK_ERROR: event.error || "",
        };

        const opts = { env, timeout: hook.timeout * 1000 };
        if (hook.async) {
          exec(hook.command, opts, (err) => {
            if (err) log.warn(`hook command failed: ${err.message}`);
          });
        } else {
          try {
            require("child_process").execSync(hook.command, opts);
          } catch (err) {
            log.warn(`hook command failed: ${err.message}`);
          }
        }
      }
    }
  }
}

module.exports = { HookManager, HookEvents };
