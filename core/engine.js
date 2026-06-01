"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { createLogger } = require("./logger");
const { formatDuration, redactToken, getSessionKey } = require("./utils");
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
  { id: "version", aliases: [],        description: "Show version information" },
];

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
      { command: "status",  description: "Check bridge and agent status" },
      { command: "stop",    description: "Stop the currently running task" },
      { command: "model",   description: "Select AI model" },
      { command: "version", description: "Show version information" },
    ];
    await this.platform.registerCommands(menuCommands);

    // Register inline keyboard callback handler for model selection
    if (typeof this.platform.onCallbackQuery === "function") {
      this.platform.onCallbackQuery(async (ctx) => {
        const data = ctx.callbackQuery?.data || "";
        if (data.startsWith("model:")) {
          await this._handleModelCallback(ctx, data);
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

    // Route slash commands
    if (prompt.startsWith("/")) {
      const parts = prompt.split(/\s+/);
      const command = parts[0].toLowerCase().replace(/^\//, "");
      const args = parts.slice(1);

      const handled = await this._handleCommand(platform, msg, sessionKey, command, args);
      if (handled) return;

      // Unknown command - fall through to agent as normal message
    }

    // Route normal prompts to the agent
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
      previewHandle = await platform.sendPreviewStart(msg.replyCtx, `${currentStatus}\n\n🤖 ${currentModel}`);
    } catch { /* ignore */ }

    // Live streaming preview: edit message every 2s with status or accumulated output
    if (previewHandle && typeof platform.editMessage === "function") {
      previewTimer = setInterval(async () => {
        let preview = "";
        if (currentOutput) {
          const tail = currentOutput.length > 3500
            ? "…" + currentOutput.slice(-3500)
            : currentOutput;
          preview = `✍️ Streaming...\n\n${tail}`;
        } else {
          preview = `${currentStatus}\n\n🤖 ${currentModel}`;
        }

        if (preview && preview !== lastPreviewText) {
          await platform.editMessage(previewHandle, preview).catch(() => {});
          lastPreviewText = preview;
        }
      }, 2000);
    }

    try {
      const session = this.sessions.getOrCreateActive(sessionKey);
      session.addHistory("user", prompt);

      const result = await this.agent.run(sessionKey, prompt, {
        timeout: this.config.agent.timeout,
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

      // Delete the preview message
      if (previewHandle) {
        try {
          await this.platform.bot.api.deleteMessage(previewHandle.chatId, previewHandle.messageId);
        } catch { /* ignore */ }
      }

      if (result.ok) {
        const output = result.stdout || "(empty response)";
        await platform.reply(msg.replyCtx, output);
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
          return;
        }

        const errorMsg = result.stderr
          ? `❌ Error (exit ${result.exitCode}):\n${result.stderr.slice(0, 500)}`
          : `❌ Error (exit ${result.exitCode}): agy returned empty output`;
        await platform.reply(msg.replyCtx, errorMsg);

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
      if (previewHandle) {
        try {
          await this.platform.bot.api.deleteMessage(previewHandle.chatId, previewHandle.messageId);
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
        await platform.reply(msg.replyCtx, this._statusMessage());
        return true;

      case "model":
        return await this._handleModelCommand(platform, msg, args);

      case "version":
        await platform.reply(msg.replyCtx, this._versionMessage());
        return true;

      case "stop": {
        const stopped = this.agent.stop(sessionKey);
        if (stopped) {
          await platform.reply(msg.replyCtx, "🛑 *Task stopped successfully.*");
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
        const lines = sessions.map((s, i) => {
          const active = s.isActive ? " ← active" : "";
          const name = s.name ? ` (${s.name})` : "";
          const history = s.historyLen > 0 ? `, ${s.historyLen} msgs` : "";
          return `${i + 1}. \`${s.id}\`${name}${history}${active}`;
        });
        await platform.reply(msg.replyCtx, `📋 *Sessions:*\n\n${lines.join("\n")}\n\nUse /switch <id> to switch sessions.`);
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
• /version \- Show version information

*Usage:*
Simply type your request or question, and the bot will execute it with the agent and reply with the results.
`;
  }

  _statusMessage() {
    const uptimeMs = Date.now() - this.startTime;
    const uptime = formatDuration(uptimeMs);
    const activeTasks = this.agent.runningCount;

    return `📊 *System Status*

• *Status*: Online 🟢
• *Uptime*: ${uptime}
• *Active Tasks*: ${activeTasks} / ${this.config.agent.maxConcurrent}
• *CLI Path*: \`${this.config.agent.agyPath}\`
• *Workspace*: \`${this.config.agent.workspaceDir}\`
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

      await ctx.editMessageText(
        `🤖 *Select Model*\n\nCurrent: \`${match.name}\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: buttons.map(row =>
              row.map(btn => ({ text: btn.text, callback_data: btn.data }))
            ),
          },
        }
      ).catch(() => {});

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

  _versionMessage() {
    return `🤖 *Agent Information*

• *Agent*: \`agy\`
• *Version*: \`${this.agyVersion}\`
• *Path*: \`${this.config.agent.agyPath}\`
• *Mode*: \`--print (non-interactive)\`
• *Workspace*: \`${this.config.agent.workspaceDir}\`
• *Timeout*: \`${this.config.agent.timeout}m\`
• *Max Concurrent*: \`${this.config.agent.maxConcurrent}\`
`;
  }
}

module.exports = { Engine, builtinCommands };
