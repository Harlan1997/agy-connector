"use strict";

/**
 * Platform is the abstract interface for messaging platform adapters.
 * Mirrors cc-connect core.Platform interface.
 *
 * Each platform adapter (Telegram, Slack, Discord, etc.) must extend this
 * class and implement all methods.
 */
class Platform {
  /** @returns {string} Platform name identifier (e.g., "telegram") */
  name() { throw new Error("Platform.name() not implemented"); }

  /**
   * Start the platform and begin receiving messages.
   * @param {Function} handler - Message handler: (platform, message) => Promise<void>
   * @returns {Promise<void>}
   */
  async start(handler) { throw new Error("Platform.start() not implemented"); }

  /**
   * Stop the platform gracefully.
   * @returns {Promise<void>}
   */
  async stop() { throw new Error("Platform.stop() not implemented"); }

  /**
   * Send a reply to a message.
   * @param {Object} replyCtx - Platform-specific reply context
   * @param {string} text - Text to send
   * @returns {Promise<void>}
   */
  async reply(replyCtx, text) { throw new Error("Platform.reply() not implemented"); }

  /**
   * Send a raw message (not a reply).
   * @param {Object} replyCtx - Platform-specific context
   * @param {string} text - Text to send
   * @returns {Promise<void>}
   */
  async send(replyCtx, text) { throw new Error("Platform.send() not implemented"); }

  /**
   * Send typing indicator.
   * @param {Object} replyCtx - Platform-specific reply context
   * @returns {Promise<void>}
   */
  async sendTyping(replyCtx) { throw new Error("Platform.sendTyping() not implemented"); }

  /**
   * Register platform commands in the UI (e.g., Telegram bot menu).
   * @param {Array<{command: string, description: string}>} commands
   * @returns {Promise<void>}
   */
  async registerCommands(commands) { /* optional - no-op by default */ }
}

/**
 * Agent is the abstract interface for AI agent backends.
 * Mirrors cc-connect core.Agent interface.
 */
class Agent {
  /** @returns {string} Agent type name (e.g., "agy", "claudecode", "gemini") */
  name() { throw new Error("Agent.name() not implemented"); }

  /**
   * Run a prompt and return the result.
   * @param {string} sessionKey - Unique session identifier
   * @param {string} prompt - User prompt text
   * @param {Object} options - Additional options
   * @returns {Promise<{ok: boolean, exitCode: number, stdout: string, stderr: string, durationMs: number}>}
   */
  async run(sessionKey, prompt, options) { throw new Error("Agent.run() not implemented"); }

  /**
   * Stop a running task for the given session.
   * @param {string} sessionKey
   * @returns {boolean} true if a task was stopped
   */
  stop(sessionKey) { throw new Error("Agent.stop() not implemented"); }

  /**
   * Stop all running tasks (for graceful shutdown).
   * @returns {void}
   */
  stopAll() { throw new Error("Agent.stopAll() not implemented"); }

  /**
   * Get the number of currently running tasks.
   * @returns {number}
   */
  get runningCount() { throw new Error("Agent.runningCount not implemented"); }
}

/**
 * Standardized Message struct passed between platform and engine.
 * Mirrors cc-connect core.Message.
 */
class Message {
  constructor({
    id = "",
    chatId = "",
    threadId = "",
    userId = "",
    username = "",
    text = "",
    timestamp = new Date(),
    sessionKey = "",
    platform = "",
    replyCtx = null,
  } = {}) {
    this.id = id;
    this.chatId = chatId;
    this.threadId = threadId;
    this.userId = userId;
    this.username = username;
    this.text = text;
    this.timestamp = timestamp;
    this.sessionKey = sessionKey;
    this.platform = platform;
    this.replyCtx = replyCtx; // Platform-specific reply context
  }
}

module.exports = { Platform, Agent, Message };
