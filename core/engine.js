"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { createLogger } = require("./logger");
const { formatDuration, redactToken, getSessionKey, stripMarkdown } = require("./utils");
const { HookEvents } = require("./hooks");

const log = createLogger("engine");

// Agy settings file path
const AGY_SETTINGS_PATH = path.join(
  process.env.HOME || ".", ".gemini", "antigravity-cli", "settings.json"
);

// Available models (from agy settings)
const AVAILABLE_MODELS = [
  { alias: "flash-medium", name: "Gemini 3.5 Flash (Medium)" },
  { alias: "flash-high",   name: "Gemini 3.5 Flash (High)" },
  { alias: "flash-low",    name: "Gemini 3.5 Flash (Low)" },
  { alias: "pro-low",      name: "Gemini 3.1 Pro (Low)" },
  { alias: "pro-high",     name: "Gemini 3.1 Pro (High)" },
  { alias: "sonnet",       name: "Claude Sonnet 4.6 (Thinking)" },
  { alias: "opus",         name: "Claude Opus 4.6 (Thinking)" },
  { alias: "gpt",          name: "GPT-OSS 120B (Medium)" },
];

// Builtin commands list (mirrors cc-connect builtinCommands)
const builtinCommands = [
  { id: "help",    aliases: ["start"], description: "Show available commands and usage" },
  { id: "status",  aliases: [],        description: "Check bridge and agent status" },
  { id: "model",   aliases: [],        description: "Show current agent/CLI info" },
  { id: "stop",    aliases: [],        description: "Stop the currently running task" },
  { id: "new",     aliases: [],        description: "Start a new conversation session" },
  { id: "list",    aliases: [],        description: "List all conversation sessions" },
  { id: "switch",  aliases: [],        description: "Switch to a different session" },
  { id: "delete",  aliases: [],        description: "Delete a conversation session" },
  { id: "project", aliases: ["projects"], description: "Manage workspaces / projects" },
  { id: "version", aliases: [],        description: "Show version information" },
];

/**
 * Filter out "I will" planning statements from the text.
 * @param {string} text
 * @returns {string}
 */
function filterPlanningStatements(text) {
  if (typeof text !== "string") return text;
  // Remove lines starting with optional list markers and "I will" (case insensitive)
  let cleaned = text.replace(/^[\s\*\->]*I\s+will\b[^\n]*\n?/gim, "");
  // Collapse 3 or more consecutive newlines down to 2 newlines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned;
}

/**
 * Engine routes messages between a platform and an agent.
 * Mirrors cc-connect core.Engine.
 */
class Engine {
  /**
   * @param {Object} opts
   * @param {import('./interfaces').Platform} opts.platform
   * @param {import('./interfaces').Agent} opts.agent
   * @param {Object} opts.config
   * @param {import('./session').SessionManager} opts.sessions
   * @param {import('./hooks').HookManager} opts.hooks
   * @param {import('./rate_limiter').RateLimiter} opts.rateLimiter
   */
  constructor({ platform, agent, config, sessions, hooks, rateLimiter }) {
    this.platform = platform;
    this.agent = agent;
    this.config = config;
    this.sessions = sessions;
    this.hooks = hooks;
    this.rateLimiter = rateLimiter;
    this.startTime = Date.now();
    this.agyVersion = "Unknown";
    this._stopping = false;

    // Message queue for busy sessions (mirrors cc-connect pendingMessages)
    this._messageQueues = new Map();  // sessionKey -> queuedMessage[]
    this._maxQueuedMessages = 5;      // max queued messages per session

    // Resolve agent version at startup
    try {
      this.agyVersion = execSync(
        `"${this.config.agent.agyPath}" --version`,
        { encoding: "utf8", timeout: 5000 }
      ).trim();
    } catch (err) {
      log.warn(`could not read agent version: ${err.message}`);
    }
  }

  /**
   * Start the engine: wire message handler, start platform, setup shutdown.
   */
  async start() {
    // Wire message handler to platform (mirrors cc-connect engine.Start())
    await this.platform.start((platform, msg) => this._handleMessage(platform, msg));

    // Register platform commands menu (AFTER bot is created by platform.start())
    // Only register commands that work as clickable buttons (no arguments needed).
    // /start must be first per Telegram convention.
    const menuCommands = [
      { command: "start",   description: "Show available commands and usage" },
      { command: "new",     description: "Start a new conversation session" },
      { command: "list",    description: "List all conversation sessions" },
      { command: "project", description: "Manage workspaces / projects" },
      { command: "status",  description: "Check bridge and agent status" },
      { command: "stop",    description: "Stop the currently running task" },
      { command: "model",   description: "Select AI model" },
      { command: "version", description: "Show version information" },
    ];
    await this.platform.registerCommands(menuCommands);

    // Register inline keyboard callback handler for model selection and session management
    if (typeof this.platform.onCallbackQuery === "function") {
      this.platform.onCallbackQuery(async (ctx) => {
        const data = ctx.callbackQuery?.data || "";
        if (data.startsWith("model:")) {
          await this._handleModelCallback(ctx, data);
        } else if (data.startsWith("session:")) {
          await this._handleSessionCallback(ctx, data);
        } else if (data.startsWith("project:")) {
          await this._handleProjectCallback(ctx, data);
        }
      });
    }

    // Graceful shutdown handlers (mirrors cc-connect engine.Stop())
    const shutdown = async (signal) => {
      if (this._stopping) return;
      this._stopping = true;
      log.info(`received ${signal}, shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    log.info("engine started", `project=${this.config.name}`, `agent=${this.agent.name()}`, `platform=${this.platform.name()}`);
  }

  /**
   * Stop the engine gracefully.
   * Mirrors cc-connect engine.Stop().
   */
  async stop() {
    log.info("stopping engine...");

    // Stop all running agent tasks
    this.agent.stopAll();

    // Stop rate limiter cleanup
    if (this.rateLimiter) this.rateLimiter.stop();

    // Stop platform
    try {
      await this.platform.stop();
      log.info("platform stopped");
    } catch (err) {
      log.error(`error stopping platform: ${err.message}`);
    }

    log.info("engine stopped");
  }

  /**
   * Handle an incoming message from the platform.
   * Mirrors cc-connect engine.handleMessage().
   */
  async _handleMessage(platform, msg) {
    const prompt = msg.text.trim();
    if (!prompt) return;

    const sessionKey = getSessionKey(msg);

    // Emit message.received hook
    this.hooks.emit({
      event: HookEvents.MESSAGE_RECEIVED,
      sessionKey,
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.username,
      content: prompt,
    });

    // Rate limit check
    if (this.rateLimiter && !this.rateLimiter.allow(sessionKey)) {
      await platform.reply(msg.replyCtx, "⚠️ *Rate limited.* Please slow down.");
      return;
    }

    // Route slash commands BEFORE the busy-session check.
    // This is critical: control commands like /stop MUST be processed immediately
    // even when a task is running, otherwise they get queued and never execute.
    if (prompt.startsWith("/")) {
      const parts = prompt.split(/\s+/);
      // Strip leading "/" and trailing "@botusername" suffix
      // (Telegram may send /stop@mybot in groups or from command menu)
      const command = parts[0].toLowerCase().replace(/^\//, "").replace(/@.*$/, "");
      const args = parts.slice(1);

      const handled = await this._handleCommand(platform, msg, sessionKey, command, args);
      if (handled) return;

      // Unknown command - fall through to agent as normal message
    }

    // Route normal prompts to the agent
    // Check if session is busy — queue the message instead of rejecting
    // (mirrors cc-connect queueMessageForBusySession)
    if (this.agent.isRunning(sessionKey)) {
      this._queueMessage(platform, msg, sessionKey, prompt);
      return;
    }

    log.info(`processing message`, `session=${sessionKey}`, `user=${msg.username}`, `len=${prompt.length}`);

    // Emit session started hook
    this.hooks.emit({
      event: HookEvents.SESSION_STARTED,
      sessionKey,
      platform: msg.platform,
    });

    // Typing indicator loop
    await platform.sendTyping(msg.replyCtx);
    const typingTimer = setInterval(() => platform.sendTyping(msg.replyCtx), 4000);

    // Streaming preview state
    let previewHandle = null;
    let previewTimer = null;
    let lastPreviewText = "";
    let currentOutput = "";
    let currentStatus = "⏳ Connecting & authenticating...";
    const currentModel = this._readCurrentModel();

    try {
      previewHandle = await platform.sendPreviewStart(msg.replyCtx, `${currentStatus}\n🤖 ${currentModel}`);
    } catch { /* ignore */ }

    // Live streaming preview: edit message every 2s with status or accumulated output
    if (previewHandle && typeof platform.editMessage === "function") {
      previewTimer = setInterval(async () => {
        let preview = "";
        if (currentOutput) {
          if (currentOutput.startsWith("📋 *Activity Log:*")) {
            preview = `⚡ *Running Task...*\n🤖 *Model:* ${currentModel}\n⏳ *Status:* ${currentStatus}\n\n${currentOutput}`;
          } else {
            const tail = currentOutput.length > 3500
              ? "…" + currentOutput.slice(-3500)
              : currentOutput;
            let cleanTail = tail.trimStart();
            // Filter out "I will" planning statements
            cleanTail = filterPlanningStatements(cleanTail);
            preview = `✍️ Streaming...\n🤖 ${currentModel}\n\n${cleanTail}`;
          }
        } else {
          preview = `⏳ *Running Task...*\n🤖 *Model:* ${currentModel}\n⏳ *Status:* ${currentStatus}`;
        }

        if (preview && preview !== lastPreviewText) {
          await platform.editMessage(previewHandle, preview).catch(() => {});
          lastPreviewText = preview;
        }
      }, 600);
    }

    try {
      const session = this.sessions.getOrCreateActive(sessionKey);
      session.addHistory("user", prompt);
      const activeProject = this.sessions.getOrCreateActiveProject(sessionKey);

      const result = await this.agent.run(sessionKey, prompt, {
        timeout: this.config.agent.timeout,
        workspaceDir: activeProject.path,
        conversationId: session.conversationId || "",
        onConversationId: (convId) => {
          if (convId && convId !== session.conversationId) {
            session.conversationId = convId;
            this.sessions._save();
            log.info(`saved agy conversationId=${convId} to session=${session.id}`);
          }
        },
        onData: (fullStdout) => {
          log.info(`[ENGINE ONDATA] received fullStdout len: ${fullStdout.length}`);
          currentOutput = fullStdout;
        },
        onStatus: (status) => {
          currentStatus = status;
        },
      });

      // Stop preview updates
      if (previewTimer) clearInterval(previewTimer);
      previewTimer = null;

      // Build final output — apply dead-end detection BEFORE preview so
      // the corrected output appears in both the preview and the reply.
      let output = result.finalResponse || result.stdout || "(empty response)";

      if (result.ok) {
        const lazyPatterns = [
          /\bI will wait\b/i,
          /\bI.ll wait\b/i,
          /\bNO_TOOL_CALLS_DUE_TO_WAITING\b/i,
          /\btimed out waiting\b/i,
        ];
        if (
          session.conversationId &&
          lazyPatterns.some(p => p.test(output))
        ) {
          log.info(`lazy waiting response detected, triggering automatic follow-up run...`);
          try {
            const followResult = await this.agent.run(sessionKey, "[System Auto-Followup] Check if the previous operation or task has completed, inspect log/files, and provide the final result.", {
              timeout: this.config.agent.timeout,
              workspaceDir: activeProject.path,
              conversationId: session.conversationId || "",
              onData: (fullStdout) => { currentOutput = fullStdout; },
              onStatus: (status) => { currentStatus = status; },
            });
            if (followResult.ok && (followResult.finalResponse || followResult.stdout)) {
              output = followResult.finalResponse || followResult.stdout;
            }
          } catch (err) {
            log.warn(`auto-followup failed: ${err.message}`);
          }

          if (lazyPatterns.some(p => p.test(output))) {
            const isTimeout = /\btimed out\b/i.test(output);
            if (currentOutput && currentOutput.includes("📋 *Activity Log:*")) {
              let note = isTimeout
                ? "\n\n⏱️ *Timed out.* The model didn't respond in time. You can send a follow-up message to retry or ask for a summary."
                : "\n\n🔄 *Work in progress.* The operation may still be running. Send another message to continue or check status.";
              output = note.trim();
            } else {
              output = isTimeout
                ? "⏱️ *Timed out.* The model didn't respond in time. Try again or send a more specific request."
                : "🔄 *Task in progress.* Send another message to continue or check status.";
            }
          }
        }
      }

      output = filterPlanningStatements(output);

      // Track whether the final response was already shown in the preview
      let responseSentViaPreview = false;

      // Update the preview message instead of deleting it
      if (previewHandle) {
        try {
          let finalPreview = "";
          if (currentOutput && currentOutput.startsWith("📋 *Activity Log:*")) {
            let cleanedLog = currentOutput;
            const draftMarker = "\n✍️ *Drafting Response...*";
            const draftIdx = cleanedLog.indexOf(draftMarker);
            if (draftIdx !== -1) {
              cleanedLog = cleanedLog.slice(0, draftIdx).trimEnd();
            }
            finalPreview = `✅ *Task Finished!*\n🤖 *Model:* ${currentModel}\n\n${cleanedLog}\n\n---\n\n${output}`;
            responseSentViaPreview = true;
          } else {
            finalPreview = `✅ *Task Finished!*\n🤖 *Model:* ${currentModel}\n⏳ *Status:* Done`;
          }
          await this.platform.editMessage(previewHandle, finalPreview);
        } catch { /* ignore */ }
      }

      if (result.ok) {
        // Only send a separate reply if the response wasn't already
        // included in the preview message (avoids duplicate output).
        if (!responseSentViaPreview) {
          await platform.reply(msg.replyCtx, output);
        }
        session.addHistory("assistant", output);

        // Emit message.sent hook
        this.hooks.emit({
          event: HookEvents.MESSAGE_SENT,
          sessionKey,
          platform: msg.platform,

          content: output,
        });
      } else {
        // Silently ignore manual stop signals (null/130/-1)
        if (result.exitCode === null || result.exitCode === 130 || result.exitCode === -1) {
          if (previewHandle) {
            try {
              await this.platform.editMessage(previewHandle, `🛑 *Task Stopped.*\n🤖 *Model:* ${currentModel}`);
            } catch { /* ignore */ }
          }
          return;
        }

        const errorMsg = result.stderr
          ? `❌ Error (exit ${result.exitCode}):\n${result.stderr.slice(0, 500)}`
          : `❌ Error (exit ${result.exitCode}): agy returned empty output`;
        await platform.reply(msg.replyCtx, errorMsg);

        if (previewHandle) {
          try {
            await this.platform.editMessage(previewHandle, `❌ *Task Failed (exit ${result.exitCode})!*\n🤖 *Model:* ${currentModel}\n\n${currentOutput || ""}`);
          } catch { /* ignore */ }
        }

        // Emit error hook
        this.hooks.emit({
          event: HookEvents.ERROR,
          sessionKey,
          platform: msg.platform,
          error: result.stderr || `exit code ${result.exitCode}`,
        });
      }

      log.info(`done`, `session=${sessionKey}`, `duration=${(result.durationMs / 1000).toFixed(1)}s`, `exit=${result.exitCode}`);

    } catch (err) {
      if (previewTimer) clearInterval(previewTimer);

      // Handle SESSION_BUSY — the agent was still busy (race condition fallback).
      // Queue the message instead of showing an error.
      if (err.message === "SESSION_BUSY") {
        if (previewHandle) {
          try { await this.platform.editMessage(previewHandle, `📥 *Message queued — session busy.*`); } catch { /* ignore */ }
        }
        this._queueMessage(platform, msg, sessionKey, prompt);
        return;
      }

      if (previewHandle) {
        try {
          await this.platform.editMessage(previewHandle, `❌ *Task Failed!*\n🤖 *Model:* ${currentModel}\n⚠️ *Error:* ${err.message}`);
        } catch { /* ignore */ }
      }
      await platform.reply(msg.replyCtx, `⚠️ Execution failed:\n${err.message}`);
      log.error(`execution error`, `session=${sessionKey}`, `error=${err.message}`);

      this.hooks.emit({
        event: HookEvents.ERROR,
        sessionKey,
        platform: msg.platform,
        error: err.message,
      });
    } finally {
      clearInterval(typingTimer);
      if (previewTimer) clearInterval(previewTimer);

      // Drain queued messages after task completes (mirrors cc-connect drainPendingMessages)
      await this._drainQueue(sessionKey);
    }
  }

  /**
   * Queue a message for later processing when the session is busy.
   * Mirrors cc-connect queueMessageForBusySession.
   * @param {import('./interfaces').Platform} platform
   * @param {Object} msg - The incoming message object
   * @param {string} sessionKey
   * @param {string} prompt
   */
  _queueMessage(platform, msg, sessionKey, prompt) {
    if (!this._messageQueues.has(sessionKey)) {
      this._messageQueues.set(sessionKey, []);
    }

    const queue = this._messageQueues.get(sessionKey);

    if (queue.length >= this._maxQueuedMessages) {
      platform.reply(msg.replyCtx,
        `⚠️ *Queue full* (${queue.length} messages pending). Please wait for the current task to finish or use /stop.`
      );
      return;
    }

    queue.push({ platform, msg, prompt });

    log.info(`message queued`, `session=${sessionKey}`, `depth=${queue.length}`);
    platform.reply(msg.replyCtx,
      `📥 *Message queued* (${queue.length} in queue). Will be processed after the current task completes.`
    );
  }

  /**
   * Process queued messages after the current task completes.
   * Mirrors cc-connect drainPendingMessages / drainOrphanedQueue.
   * Takes the next message from the queue and re-dispatches it.
   * @param {string} sessionKey
   */
  async _drainQueue(sessionKey) {
    const queue = this._messageQueues.get(sessionKey);
    if (!queue || queue.length === 0) return;

    // Take the next message from the queue
    const next = queue.shift();
    if (queue.length === 0) {
      this._messageQueues.delete(sessionKey);
    }

    log.info(`draining queued message`, `session=${sessionKey}`, `remaining=${queue ? queue.length : 0}`);

    // Re-dispatch as if it were a fresh message
    try {
      await this._handleMessage(next.platform, next.msg);
    } catch (err) {
      log.error(`error processing queued message`, `session=${sessionKey}`, `error=${err.message}`);
    }
  }

  /**
   * Handle a slash command. Returns true if handled.
   * Mirrors cc-connect engine.handleCommand().
   */
  async _handleCommand(platform, msg, sessionKey, command, args) {
    switch (command) {
      case "help":
      case "start":
        await platform.reply(msg.replyCtx, this._helpMessage());
        return true;

      case "status":
        await platform.reply(msg.replyCtx, this._statusMessage(sessionKey));
        return true;

      case "model":
        return await this._handleModelCommand(platform, msg, args);

      case "version":
        await platform.reply(msg.replyCtx, this._versionMessage(sessionKey));
        return true;

      case "projects":
      case "project": {
        if (args.length === 0 || args[0].toLowerCase() === "list") {
          const projects = this.sessions.listProjects(sessionKey);
          if (projects.length === 0) {
            await platform.reply(msg.replyCtx, "📂 *No workspaces found.*");
            return true;
          }

          if (typeof platform.replyWithInlineKeyboard === "function") {
            const buttons = projects.map(p => {
              const label = `${p.isActive ? "🟢" : "⚪️"} ${p.name}`;
              const row = [
                { text: label, data: `project:switch:${p.id}` }
              ];
              if (p.id !== "default") {
                row.push({ text: "🗑 Delete", data: `project:delete:${p.id}` });
              }
              return row;
            });
            await platform.replyWithInlineKeyboard(
              msg.replyCtx,
              "📂 *Workspaces / Projects:*\n\n🟢 Current active workspace\n⚪️ Click any workspace to switch\n\n*To create a workspace:* `/project create <path>`",
              buttons
            );
          } else {
            const lines = projects.map((p, i) => {
              const active = p.isActive ? " ← active" : "";
              return `${i + 1}. \`${p.name}\` (Path: \`${p.path}\`)${active}`;
            });
            await platform.reply(
              msg.replyCtx,
              `📂 *Workspaces / Projects:*\n\n${lines.join("\n")}\n\nUse \`/project switch <name>\` to switch workspace.\nUse \`/project create <path>\` to create workspace.`
            );
          }
          return true;
        }

        const subCommand = args[0].toLowerCase();
        const subArgs = args.slice(1);

        if (subCommand === "create") {
          if (subArgs.length === 0) {
            await platform.reply(msg.replyCtx, "⚠️ *Usage:* `/project create <path>`");
            return true;
          }

          let rawPath = subArgs.join(" ").trim();

          // Expand ~ to home directory (shell doesn't do this for bot input)
          if (rawPath === "~") {
            rawPath = os.homedir();
          } else if (rawPath.startsWith("~/")) {
            rawPath = path.join(os.homedir(), rawPath.slice(2));
          }

          // Only accept absolute paths to avoid ambiguity
          if (!path.isAbsolute(rawPath)) {
            await platform.reply(msg.replyCtx, "⚠️ *Path must be absolute* (starting with `/`).\n\n*Example:* `/project create /home/admin/my-project`");
            return true;
          }
          const targetPath = path.resolve(rawPath);

          // Use the directory basename as the workspace name
          const name = path.basename(targetPath);

          try {
            if (!fs.existsSync(targetPath)) {
              fs.mkdirSync(targetPath, { recursive: true });
            }
            this.sessions.createProject(sessionKey, name, targetPath);
            await platform.reply(
              msg.replyCtx,
              `✅ *Workspace created & activated!*\n• *Name:* \`${name}\`\n• *Path:* \`${targetPath}\``
            );
          } catch (err) {
            await platform.reply(msg.replyCtx, `⚠️ *Error creating workspace:* ${err.message}`);
          }
          return true;
        }

        if (subCommand === "switch") {
          if (subArgs.length === 0) {
            await platform.reply(msg.replyCtx, "⚠️ *Usage:* `/project switch <name-or-id>`");
            return true;
          }
          const target = subArgs.join(" ").trim();
          const switched = this.sessions.switchProject(sessionKey, target);
          if (switched) {
            await platform.reply(
              msg.replyCtx,
              `🔄 *Switched to workspace:* \`${switched.name}\`\n• *Path:* \`${switched.path}\``
            );
          } else {
            await platform.reply(
              msg.replyCtx,
              `⚠️ *Workspace not found:* \`${target}\`\nUse \`/project\` or \`/project list\` to see available workspaces.`
            );
          }
          return true;
        }

        if (subCommand === "delete") {
          if (subArgs.length === 0) {
            await platform.reply(msg.replyCtx, "⚠️ *Usage:* `/project delete <name-or-id>`");
            return true;
          }
          const target = subArgs.join(" ").trim();
          try {
            const deleted = this.sessions.deleteProject(sessionKey, target);
            if (deleted) {
              await platform.reply(msg.replyCtx, `🗑 *Workspace deleted:* \`${target}\``);
            } else {
              await platform.reply(msg.replyCtx, `⚠️ *Workspace not found:* \`${target}\``);
            }
          } catch (err) {
            await platform.reply(msg.replyCtx, `⚠️ *Error:* ${err.message}`);
          }
          return true;
        }

        await platform.reply(
          msg.replyCtx,
          `⚠️ *Unknown subcommand:* \`${subCommand}\`\n\n*Available commands:*\n• \`/project\` or \`/project list\`\n• \`/project create <path>\`\n• \`/project switch <name>\`\n• \`/project delete <name>\``
        );
        return true;
      }

      case "stop": {
        const stopped = this.agent.stop(sessionKey);
        if (stopped) {
          // Clear any queued messages when user explicitly stops (mirrors cc-connect)
          const queuedCount = (this._messageQueues.get(sessionKey) || []).length;
          this._messageQueues.delete(sessionKey);
          const queueMsg = queuedCount > 0 ? ` ${queuedCount} queued message(s) discarded.` : "";
          await platform.reply(msg.replyCtx, `🛑 *Task stopped successfully.*${queueMsg}`);
          this.hooks.emit({
            event: HookEvents.SESSION_ENDED,
            sessionKey,
            platform: msg.platform,
          });
        } else {
          await platform.reply(msg.replyCtx, "⚠️ *No active task running in this chat.*");
        }
        return true;
      }

      case "new": {
        // Create a new session (mirrors cc-connect /new command)
        const name = args.join(" ").trim();
        const session = this.sessions.newSession(sessionKey, name);
        const label = name ? ` \`${name}\`` : "";
        await platform.reply(msg.replyCtx, `✅ *New session created${label}*\nSession ID: \`${session.id}\``);
        return true;
      }

      case "list": {
        // List all sessions (mirrors cc-connect /list command)
        const sessions = this.sessions.listSessions(sessionKey);
        if (sessions.length === 0) {
          await platform.reply(msg.replyCtx, "📋 *No sessions found.*");
          return true;
        }

        if (typeof platform.replyWithInlineKeyboard === "function") {
          const buttons = sessions.map(s => {
            const label = `${s.isActive ? "🟢" : "⚪️"} ${s.name || s.id.slice(0, 8)} (${s.historyLen} msgs)`;
            return [
              { text: label, data: `session:switch:${s.id}` },
              { text: "🗑 Delete", data: `session:delete:${s.id}` }
            ];
          });
          await platform.replyWithInlineKeyboard(
            msg.replyCtx,
            "📋 *Conversation Sessions:*\n\n🟢 Current active session\n⚪️ Click any session to switch",
            buttons
          );
        } else {
          const lines = sessions.map((s, i) => {
            const active = s.isActive ? " ← active" : "";
            const name = s.name ? ` (${s.name})` : "";
            const history = s.historyLen > 0 ? `, ${s.historyLen} msgs` : "";
            return `${i + 1}. \`${s.id}\`${name}${history}${active}`;
          });
          await platform.reply(msg.replyCtx, `📋 *Sessions:*\n\n${lines.join("\n")}\n\nUse /switch <id> to switch sessions.`);
        }
        return true;
      }

      case "switch": {
        // Switch session (mirrors cc-connect /switch command)
        if (args.length === 0) {
          await platform.reply(msg.replyCtx, "⚠️ *Usage:* /switch <session-id or name>");
          return true;
        }
        const target = args[0];
        const switched = this.sessions.switchSession(sessionKey, target);
        if (switched) {
          const name = switched.name ? ` (${switched.name})` : "";
          await platform.reply(msg.replyCtx, `🔄 *Switched to session \`${switched.id}\`${name}*`);
        } else {
          await platform.reply(msg.replyCtx, `⚠️ *Session not found:* \`${target}\`\nUse /list to see available sessions.`);
        }
        return true;
      }

      case "delete": {
        // Delete session (mirrors cc-connect /delete command)
        if (args.length === 0) {
          await platform.reply(msg.replyCtx, "⚠️ *Usage:* /delete <session-id or name>");
          return true;
        }
        const target2 = args[0];
        const deleted = this.sessions.deleteSession(sessionKey, target2);
        if (deleted) {
          await platform.reply(msg.replyCtx, `🗑 *Session deleted:* \`${target2}\``);
        } else {
          await platform.reply(msg.replyCtx, `⚠️ *Session not found:* \`${target2}\``);
        }
        return true;
      }

      default:
        return false; // Unknown command - not handled
    }
  }

  // ---- Message builders ----

  _helpMessage() {
    return `🤖 *Agy Telegram Bridge*

An elegant bridge that routes your Telegram messages to the local \`agy\` CLI assistant.

*Commands:*
• /help, /start \- Show this help message
• /status \- Check system status and uptime
• /model \- Display agent/CLI information
• /stop \- Terminate the current running task
• /new [name] \- Start a new conversation session
• /list \- List all conversation sessions
• /switch <id> \- Switch to a different session
• /delete <id> \- Delete a conversation session
• /project \- Manage workspaces / projects
• /version \- Show version information

*Usage:*
Simply type your request or question, and the bot will execute it with the agent and reply with the results.
`;
  }

  _statusMessage(sessionKey) {
    const uptimeMs = Date.now() - this.startTime;
    const uptime = formatDuration(uptimeMs);
    const activeTasks = this.agent.runningCount;
    const project = this.sessions.getOrCreateActiveProject(sessionKey);

    return `📊 *System Status*

• *Status*: Online 🟢
• *Uptime*: ${uptime}
• *Active Tasks*: ${activeTasks} / ${this.config.agent.maxConcurrent}
• *CLI Path*: \`${this.config.agent.agyPath}\`
• *Workspace*: \`${project.path}\` (Project: \`${project.name}\`)
`;
  }

  /**
   * Handle /model command — show inline keyboard buttons for model selection.
   * Mirrors cc-connect /model command with InlineButtonSender.
   */
  async _handleModelCommand(platform, msg, args) {
    const currentModel = this._readCurrentModel();

    // Build inline keyboard buttons — 2 per row
    const buttons = [];
    for (let i = 0; i < AVAILABLE_MODELS.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, AVAILABLE_MODELS.length); j++) {
        const m = AVAILABLE_MODELS[j];
        const label = m.name === currentModel ? `✅ ${m.name}` : m.name;
        row.push({ text: label, data: `model:${m.alias}` });
      }
      buttons.push(row);
    }

    if (typeof platform.replyWithInlineKeyboard === "function") {
      await platform.replyWithInlineKeyboard(
        msg.replyCtx,
        `🤖 *Select Model*\n\nCurrent: \`${currentModel}\``,
        buttons
      );
    } else {
      // Fallback for platforms without inline buttons
      const lines = AVAILABLE_MODELS.map(m => {
        const active = m.name === currentModel ? " ← current" : "";
        return `• \`${m.alias}\` → ${m.name}${active}`;
      });
      await platform.reply(msg.replyCtx,
        `🤖 *Current Model:* \`${currentModel}\`\n\n*Available:*\n${lines.join("\n")}\n\nUse /model <alias> to switch.`
      );
    }
    return true;
  }

  /**
   * Handle inline keyboard callback for model selection.
   * Called when user taps a model button.
   */
  async _handleModelCallback(ctx, data) {
    const alias = data.replace("model:", "");
    const match = AVAILABLE_MODELS.find(m => m.alias === alias);
    if (!match) return;

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(AGY_SETTINGS_PATH, "utf8"));
    } catch {
      log.warn("could not read agy settings");
    }
    const currentModel = settings.model || "Unknown";

    if (match.name === currentModel) {
      // Already selected — just notify
      await ctx.answerCallbackQuery({ text: `Already using ${match.name}` }).catch(() => {});
      return;
    }

    // Switch model
    try {
      settings.model = match.name;
      fs.writeFileSync(AGY_SETTINGS_PATH, JSON.stringify(settings, null, 2));
      log.info(`model switched: ${currentModel} → ${match.name}`);

      // Update the inline keyboard message in-place with new selection
      const buttons = [];
      for (let i = 0; i < AVAILABLE_MODELS.length; i += 2) {
        const row = [];
        for (let j = i; j < Math.min(i + 2, AVAILABLE_MODELS.length); j++) {
          const m = AVAILABLE_MODELS[j];
          const label = m.name === match.name ? `✅ ${m.name}` : m.name;
          row.push({ text: label, data: `model:${m.alias}` });
        }
        buttons.push(row);
      }

      const rawText = `🤖 *Select Model*\n\nCurrent: \`${match.name}\``;
      const editText = this.platform.plainText ? stripMarkdown(rawText) : rawText;

      const editOptions = {
        reply_markup: {
          inline_keyboard: buttons.map(row =>
            row.map(btn => ({ text: btn.text, callback_data: btn.data }))
          ),
        },
      };
      if (!this.platform.plainText) {
        editOptions.parse_mode = "Markdown";
      }

      await ctx.editMessageText(editText, editOptions).catch(() => {});

    } catch (err) {
      log.error(`failed to switch model: ${err.message}`);
    }
  }

  /**
   * Read the current model from agy settings.
   */
  _readCurrentModel() {
    try {
      const settings = JSON.parse(fs.readFileSync(AGY_SETTINGS_PATH, "utf8"));
      return settings.model || "Unknown";
    } catch {
      return "Unknown";
    }
  }

  _versionMessage(sessionKey) {
    const project = this.sessions.getOrCreateActiveProject(sessionKey);
    return `🤖 *Agent Information*
 
• *Agent*: \`agy\`
• *Version*: \`${this.agyVersion}\`
• *Path*: \`${this.config.agent.agyPath}\`
• *Mode*: \`--print (non-interactive)\`
• *Workspace*: \`${project.path}\` (Project: \`${project.name}\`)
• *Timeout*: \`${this.config.agent.timeout}m\`
• *Max Concurrent*: \`${this.config.agent.maxConcurrent}\`
`;
  }

  /**
   * Handle session Callback Query.
   */
  async _handleSessionCallback(ctx, data) {
    const chat = ctx.chat;
    const msg = ctx.callbackQuery?.message;
    if (!chat || !msg) return;

    const chatId = String(chat.id);
    const threadId = String(msg.message_thread_id || "");
    const sessionKey = threadId ? `${chatId}-${threadId}` : chatId;

    if (data.startsWith("session:switch:")) {
      const targetId = data.replace("session:switch:", "");
      const switched = this.sessions.switchSession(sessionKey, targetId);
      if (switched) {
        const name = switched.name ? ` (${switched.name})` : "";
        await ctx.answerCallbackQuery({ text: `Switched to ${switched.id.slice(0, 8)}${name}` }).catch(() => {});
        await this._updateSessionListMessage(ctx, sessionKey);
      } else {
        await ctx.answerCallbackQuery({ text: "⚠️ Session not found." }).catch(() => {});
      }
    } else if (data.startsWith("session:delete:")) {
      const targetId = data.replace("session:delete:", "");
      const deleted = this.sessions.deleteSession(sessionKey, targetId);
      if (deleted) {
        await ctx.answerCallbackQuery({ text: `Deleted session ${targetId.slice(0, 8)}` }).catch(() => {});
        await this._updateSessionListMessage(ctx, sessionKey);
      } else {
        await ctx.answerCallbackQuery({ text: "⚠️ Session not found." }).catch(() => {});
      }
    }
  }

  /**
   * Update the session list message in-place.
   */
  async _updateSessionListMessage(ctx, sessionKey) {
    const sessions = this.sessions.listSessions(sessionKey);
    if (sessions.length === 0) {
      const text = this.platform.plainText ? stripMarkdown("📋 *No sessions found.*") : "📋 *No sessions found.*";
      const options = {};
      if (!this.platform.plainText) {
        options.parse_mode = "Markdown";
      }
      await ctx.editMessageText(text, options).catch(() => {});
      return;
    }

    const buttons = sessions.map(s => {
      const label = `${s.isActive ? "🟢" : "⚪️"} ${s.name || s.id.slice(0, 8)} (${s.historyLen} msgs)`;
      return [
        { text: label, callback_data: `session:switch:${s.id}` },
        { text: "🗑 Delete", callback_data: `session:delete:${s.id}` }
      ];
    });

    const rawText = "📋 *Conversation Sessions:*\n\n🟢 Current active session\n⚪️ Click any session to switch";
    const editText = this.platform.plainText ? stripMarkdown(rawText) : rawText;

    const editOptions = {
      reply_markup: {
        inline_keyboard: buttons,
      },
    };
    if (!this.platform.plainText) {
      editOptions.parse_mode = "Markdown";
    }

    await ctx.editMessageText(editText, editOptions).catch(() => {});
  }

  /**
   * Handle project Callback Query.
   */
  async _handleProjectCallback(ctx, data) {
    const chat = ctx.chat;
    const msg = ctx.callbackQuery?.message;
    if (!chat || !msg) return;

    const chatId = String(chat.id);
    const threadId = String(msg.message_thread_id || "");
    const sessionKey = threadId ? `${chatId}-${threadId}` : chatId;

    if (data.startsWith("project:switch:")) {
      const targetId = data.replace("project:switch:", "");
      const switched = this.sessions.switchProject(sessionKey, targetId);
      if (switched) {
        await ctx.answerCallbackQuery({ text: `Switched to workspace: ${switched.name}` }).catch(() => {});
        await this._updateProjectListMessage(ctx, sessionKey);
      } else {
        await ctx.answerCallbackQuery({ text: "⚠️ Workspace not found." }).catch(() => {});
      }
    } else if (data.startsWith("project:delete:")) {
      const targetId = data.replace("project:delete:", "");
      try {
        const deleted = this.sessions.deleteProject(sessionKey, targetId);
        if (deleted) {
          await ctx.answerCallbackQuery({ text: "Workspace deleted" }).catch(() => {});
          await this._updateProjectListMessage(ctx, sessionKey);
        } else {
          await ctx.answerCallbackQuery({ text: "⚠️ Workspace not found." }).catch(() => {});
        }
      } catch (err) {
        await ctx.answerCallbackQuery({ text: `⚠️ Error: ${err.message}` }).catch(() => {});
      }
    }
  }

  /**
   * Update the project list message in-place.
   */
  async _updateProjectListMessage(ctx, sessionKey) {
    const projects = this.sessions.listProjects(sessionKey);
    if (projects.length === 0) {
      const text = this.platform.plainText ? stripMarkdown("📂 *No workspaces found.*") : "📂 *No workspaces found.*";
      const options = {};
      if (!this.platform.plainText) {
        options.parse_mode = "Markdown";
      }
      await ctx.editMessageText(text, options).catch(() => {});
      return;
    }

    const buttons = projects.map(p => {
      const label = `${p.isActive ? "🟢" : "⚪️"} ${p.name}`;
      const row = [
        { text: label, callback_data: `project:switch:${p.id}` }
      ];
      if (p.id !== "default") {
        row.push({ text: "🗑 Delete", callback_data: `project:delete:${p.id}` });
      }
      return row;
    });

    const rawText = "📂 *Workspaces / Projects:*\n\n🟢 Current active workspace\n⚪️ Click any workspace to switch\n\n*To create a workspace:* `/project create <path>`";
    const editText = this.platform.plainText ? stripMarkdown(rawText) : rawText;

    const editOptions = {
      reply_markup: {
        inline_keyboard: buttons,
      },
    };
    if (!this.platform.plainText) {
      editOptions.parse_mode = "Markdown";
    }

    await ctx.editMessageText(editText, editOptions).catch(() => {});
  }
}

module.exports = { Engine, builtinCommands };
