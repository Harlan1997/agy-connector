"use strict";

const { Bot } = require("grammy");
const { Platform, Message } = require("../core/interfaces");
const { createLogger } = require("../core/logger");
const { splitMessage, getSessionKey } = require("../core/utils");

const log = createLogger("telegram");

/**
 * TelegramPlatform adapts Telegram (via grammy) to the Platform interface.
 * Mirrors cc-connect platform/telegram adapter.
 */
class TelegramPlatform extends Platform {
  constructor(config) {
    super();
    this.token = config.token;
    this.allowedUserIds = new Set(config.allowedUserIds || []);
    this.bot = null;
    this._handler = null;
  }

  name() {
    return "telegram";
  }

  async start(handler) {
    this._handler = handler;
    this._callbackHandler = null; // For inline keyboard button presses
    this.bot = new Bot(this.token);

    // Grammy error boundary — prevents silent failures
    this.bot.catch((err) => {
      log.error(`grammy error: ${err.message}`);
    });

    // Whitelist middleware for access control
    this.bot.use(async (ctx, next) => {
      const uid = String(ctx.from?.id || "");
      if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(uid)) {
        log.warn(`access denied for user ${uid}`);
        await ctx.reply("Access denied.");
        return;
      }
      await next();
    });

    // Handle inline keyboard button presses (callback queries)
    this.bot.on("callback_query:data", async (ctx) => {
      if (this._callbackHandler) {
        await this._callbackHandler(ctx);
      }
      // Acknowledge the button press to remove loading state
      await ctx.answerCallbackQuery().catch(() => {});
    });

    // Build normalized Message struct and dispatch to handler
    this.bot.on("message:text", async (ctx) => {
      const msg = new Message({
        id: String(ctx.message.message_id),
        chatId: String(ctx.chat.id),
        threadId: String(ctx.message.message_thread_id || ""),
        userId: String(ctx.from.id),
        username: ctx.from.username || ctx.from.first_name || "",
        text: ctx.message.text || "",
        timestamp: new Date(ctx.message.date * 1000),
        sessionKey: "",  // Computed by engine via getSessionKey()
        platform: "telegram",
        replyCtx: ctx,    // Grammy context for replies
      });

      if (this._handler) {
        await this._handler(this, msg);
      }
    });

    // Start long-polling (don't await — bot.start() blocks forever)
    // The handler is already registered above, so messages will flow.
    this.bot.start({
      onStart: ({ username }) => {
        log.info(`bot started: @${username}`);
      },
    });

    // Wait briefly for the bot to connect before returning
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  /**
   * Register a callback handler for inline keyboard button presses.
   * @param {Function} handler - (ctx) => Promise<void>
   */
  onCallbackQuery(handler) {
    this._callbackHandler = handler;
  }

  /**
   * Send a message with inline keyboard buttons.
   * Mirrors cc-connect InlineButtonSender interface.
   * @param {Object} replyCtx - Grammy context
   * @param {string} text - Message text
   * @param {Array<Array<{text: string, data: string}>>} buttons - Button rows
   */
  async replyWithInlineKeyboard(replyCtx, text, buttons) {
    if (!replyCtx) return;
    try {
      await replyCtx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: buttons.map(row =>
            row.map(btn => ({ text: btn.text, callback_data: btn.data }))
          ),
        },
        link_preview_options: { is_disabled: true },
      });
    } catch {
      // Fallback to plain text
      try {
        await replyCtx.reply(text, {
          reply_markup: {
            inline_keyboard: buttons.map(row =>
              row.map(btn => ({ text: btn.text, callback_data: btn.data }))
            ),
          },
        });
      } catch (err) {
        log.error(`failed to send inline keyboard: ${err.message}`);
      }
    }
  }

  async stop() {
    if (this.bot) {
      log.info("stopping bot...");
      await this.bot.stop();
      log.info("bot stopped");
    }
  }

  async reply(replyCtx, text) {
    if (!replyCtx) return;
    const parts = splitMessage(text, 4000);
    for (const part of parts) {
      try {
        await replyCtx.reply(part, {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
        });
      } catch {
        // Fallback to plain text if Markdown parsing fails
        try {
          await replyCtx.reply(part);
        } catch (err) {
          log.error(`failed to send message: ${err.message}`);
        }
      }
    }
  }

  async send(replyCtx, text) {
    // For Telegram, send and reply are the same
    await this.reply(replyCtx, text);
  }

  /**
   * Send an initial preview message and return a handle for editing.
   * Mirrors cc-connect PreviewStarter interface.
   * @param {Object} replyCtx - Grammy context
   * @param {string} text - Initial text
   * @returns {Promise<{chatId: number, messageId: number}|null>}
   */
  async sendPreviewStart(replyCtx, text) {
    if (!replyCtx) return null;
    try {
      const sent = await replyCtx.reply(text, {
        link_preview_options: { is_disabled: true },
      });
      return { chatId: sent.chat.id, messageId: sent.message_id };
    } catch (err) {
      log.error(`failed to send preview: ${err.message}`);
      return null;
    }
  }

  /**
   * Edit an existing message in-place.
   * Mirrors cc-connect MessageUpdater interface.
   * @param {{chatId: number, messageId: number}} handle
   * @param {string} text - Updated text
   * @returns {Promise<boolean>}
   */
  async editMessage(handle, text) {
    if (!handle || !this.bot) return false;
    try {
      await this.bot.api.editMessageText(handle.chatId, handle.messageId, text, {
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (err) {
      // "message is not modified" is expected when content hasn't changed
      if (!err.message?.includes("message is not modified")) {
        log.error(`failed to edit message: ${err.message}`);
      }
      return false;
    }
  }

  async sendTyping(replyCtx) {
    try {
      await replyCtx.replyWithChatAction("typing");
    } catch {
      // Ignore typing indicator failures
    }
  }

  async registerCommands(commands) {
    if (!this.bot) return;
    try {
      const tgCommands = commands.map(c => ({
        command: c.command,
        description: c.description,
      }));
      await this.bot.api.setMyCommands(tgCommands);
      log.info(`registered ${tgCommands.length} bot commands`);
    } catch (err) {
      log.error(`failed to register commands: ${err.message}`);
    }
  }
}

module.exports = { TelegramPlatform };
