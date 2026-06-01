"use strict";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let globalLevel = LOG_LEVELS.info;

function setLogLevel(level) {
  if (LOG_LEVELS[level] !== undefined) {
    globalLevel = LOG_LEVELS[level];
  }
}

function formatTimestamp() {
  return new Date().toISOString();
}

/**
 * Create a structured logger for a named module.
 * Mirrors cc-connect slog usage pattern.
 * @param {string} module - Module name (e.g., "engine", "telegram", "agent")
 */
function createLogger(module) {
  function log(level, msg, ...args) {
    if (LOG_LEVELS[level] < globalLevel) return;
    const prefix = `${formatTimestamp()} [${level.toUpperCase().padEnd(5)}] [${module}]`;
    const extra = args.length > 0 ? " " + args.map(a => {
      if (typeof a === "object") return JSON.stringify(a);
      return String(a);
    }).join(" ") : "";
    const line = `${prefix} ${msg}${extra}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, ...args) => log("debug", msg, ...args),
    info: (msg, ...args) => log("info", msg, ...args),
    warn: (msg, ...args) => log("warn", msg, ...args),
    error: (msg, ...args) => log("error", msg, ...args),
  };
}

module.exports = { createLogger, setLogLevel, LOG_LEVELS };
