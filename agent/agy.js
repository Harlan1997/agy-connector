"use strict";

const fs = require("fs");
const pty = require("node-pty");
const { Agent } = require("../core/interfaces");
const { createLogger } = require("../core/logger");

const log = createLogger("agent");

// Regex to strip ANSI escape sequences from pty output
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b\[[\?]?[0-9;]*[a-zA-Z~$]|\r/g;

/**
 * AgyAgentSession adapts the agy CLI to the Agent interface.
 * Uses node-pty for real-time streaming output.
 * Mirrors cc-connect agent adapters (claudecode, gemini, codex).
 */
class AgyAgentSession extends Agent {
  constructor(options) {
    super();
    this.agyPath = options.agyPath || "agy";
    this.workspaceDir = options.workspaceDir || process.env.HOME;
    this.maxConcurrent = options.maxConcurrent || 1;
    this._activeProcesses = new Map(); // sessionKey -> pty process
    this._pendingSessions = new Set(); // Prevent race conditions
    this._waitQueue = [];              // Event-based queue
  }

  name() {
    return "agy";
  }

  /**
   * Run agy --print via node-pty for real-time streaming.
   * The pty makes agy think it's talking to a terminal, so it
   * flushes output incrementally instead of buffering to the end.
   */
  async run(sessionKey, prompt, options = {}) {
    const timeoutMinutes = parseInt(options.timeout || "5", 10);

    // Check for duplicate session
    if (this._activeProcesses.has(sessionKey) || this._pendingSessions.has(sessionKey)) {
      throw new Error("A task is already running in this chat. Use /stop to cancel it before starting a new one.");
    }

    // Wait for concurrency slot
    if (this._activeProcesses.size >= this.maxConcurrent) {
      await new Promise(resolve => this._waitQueue.push(resolve));
    }

    // Re-check after waiting
    if (this._activeProcesses.has(sessionKey) || this._pendingSessions.has(sessionKey)) {
      throw new Error("A task is already running in this chat. Use /stop to cancel it before starting a new one.");
    }

    this._pendingSessions.add(sessionKey);

    return new Promise((resolve) => {
      const startTime = Date.now();
      const logFilePath = `/tmp/agy_${sessionKey}.log`;
      try { fs.unlinkSync(logFilePath); } catch (e) {}

      const args = [
        "--print", prompt,
        "--print-timeout", `${timeoutMinutes}m`,
        "--log-file", logFilePath,
      ];

      // Add --add-dir if workspace is set and isn't home directory
      if (this.workspaceDir && this.workspaceDir !== process.env.HOME) {
        args.unshift("--add-dir", this.workspaceDir);
      }

      // Filter env to exclude sensitive vars
      const childEnv = { ...process.env };
      delete childEnv.TELEGRAM_BOT_TOKEN;
      childEnv.TERM = "xterm-256color";

      let proc;
      try {
        proc = pty.spawn(this.agyPath, args, {
          name: "xterm-color",
          cols: 200,
          rows: 50,
          cwd: this.workspaceDir,
          env: childEnv,
        });
      } catch (err) {
        this._pendingSessions.delete(sessionKey);
        resolve({
          ok: false,
          exitCode: -1,
          stdout: "",
          stderr: `failed to spawn pty: ${err.message}`,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      this._activeProcesses.set(sessionKey, proc);
      this._pendingSessions.delete(sessionKey);

      let fullOutput = "";
      let lastStatus = "⏳ Connecting & authenticating...";

      // Send initial status
      if (typeof options.onStatus === "function") {
        options.onStatus(lastStatus);
      }

      // Watch log file for intermediate status updates
      const logTimer = setInterval(() => {
        if (!fs.existsSync(logFilePath)) return;
        try {
          const content = fs.readFileSync(logFilePath, "utf8");
          let status = lastStatus;

          if (content.includes("authenticated via") || content.includes("authenticated successfully")) {
            status = "🧠 Thinking & planning...";
          }
          if (content.includes("generated tool calls")) {
            status = "🛠 Running tools to read/search files...";
          }
          if (content.includes("streamGenerateContent")) {
            status = "✍️ Generating answer...";
          }
          if (content.includes("error executing cascade step")) {
            status = "⚠️ Tool error encountered, retrying...";
          }

          if (status !== lastStatus) {
            lastStatus = status;
            log.info(`[STATUS CHANGE]: ${status}`);
            if (typeof options.onStatus === "function") {
              options.onStatus(status);
            }
          }
        } catch (e) {
          // ignore read errors
        }
      }, 1000);

      // Receive streaming data from pty
      proc.onData((data) => {
        log.debug(`[PTY RAW DATA]: ${JSON.stringify(data)}`);
        // Strip ANSI escape codes
        const clean = data.replace(ANSI_RE, "");
        if (clean) {
          log.debug(`[PTY CLEAN DATA]: ${JSON.stringify(clean)}`);
          fullOutput += clean;
          // Fire streaming callback with accumulated output
          if (typeof options.onData === "function") {
            options.onData(fullOutput);
          }
        }
      });

      const cleanup = () => {
        clearInterval(logTimer);
        try { fs.unlinkSync(logFilePath); } catch (e) {}
        this._activeProcesses.delete(sessionKey);
        // Signal next in queue
        if (this._waitQueue.length > 0) {
          const next = this._waitQueue.shift();
          next();
        }
      };

      proc.onExit(({ exitCode }) => {
        cleanup();
        resolve({
          ok: exitCode === 0,
          exitCode,
          stdout: fullOutput.trim(),
          stderr: "",
          durationMs: Date.now() - startTime,
        });
      });

      // Hard timeout
      const hardMs = Math.max(timeoutMinutes * 2, 5) * 60 * 1000;
      const hardTimer = setTimeout(() => {
        log.warn(`hard timeout reached for session ${sessionKey}, terminating...`);
        try { proc.kill(); } catch {}
      }, hardMs);

      proc.onExit(() => clearTimeout(hardTimer));
    });
  }

  /**
   * Stop the active task for the given session key.
   */
  stop(sessionKey) {
    const proc = this._activeProcesses.get(sessionKey);
    if (!proc) return false;

    log.info(`stopping task for session ${sessionKey}`);
    try {
      proc.kill();
      return true;
    } catch (err) {
      log.error(`failed to stop task: ${err.message}`);
      return false;
    }
  }

  /**
   * Stop all running tasks.
   */
  stopAll() {
    if (this._activeProcesses.size === 0) return;
    log.info(`stopping all ${this._activeProcesses.size} active task(s)...`);
    for (const [key, proc] of this._activeProcesses) {
      try {
        proc.kill();
      } catch (err) {
        log.warn(`failed to stop task ${key}: ${err.message}`);
      }
    }
  }

  get runningCount() {
    return this._activeProcesses.size;
  }
}

module.exports = { AgyAgentSession };
