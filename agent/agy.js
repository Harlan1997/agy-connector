"use strict";

const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const { Agent } = require("../core/interfaces");
const { createLogger } = require("../core/logger");

const log = createLogger("agent");

/**
 * AgyAgentSession adapts the agy CLI to the Agent interface.
 * Mirrors cc-connect agent adapters (claudecode, gemini, codex).
 */
class AgyAgentSession extends Agent {
  constructor(options) {
    super();
    this.agyPath = options.agyPath || "agy";
    this.workspaceDir = options.workspaceDir || process.env.HOME;
    this.maxConcurrent = options.maxConcurrent || 1;
    this._activeProcesses = new Map(); // sessionKey -> childProcess
    this._pendingSessions = new Set(); // Prevent race conditions
    this._waitQueue = [];              // Event-based queue (replaces busy-wait)
  }

  name() {
    return "agy";
  }

  /**
   * Run agy --print and return stdout.
   * Maps tasks to unique session keys to protect against double prompts.
   */
  async run(sessionKey, prompt, options = {}) {
    const timeoutMinutes = parseInt(options.timeout || "5", 10);

    // Check for duplicate session (atomic with pending set)
    if (this._activeProcesses.has(sessionKey) || this._pendingSessions.has(sessionKey)) {
      throw new Error("A task is already running in this chat. Use /stop to cancel it before starting a new one.");
    }

    // Wait for concurrency slot using event-based queue (NOT busy-wait)
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
      const args = [
        "--print", prompt,
        "--print-timeout", `${timeoutMinutes}m`,
      ];

      // Add --add-dir if workspace is set and isn't home directory
      if (this.workspaceDir && this.workspaceDir !== process.env.HOME) {
        args.unshift("--add-dir", this.workspaceDir);
      }

      // Filter env to exclude sensitive vars (security fix)
      const childEnv = { ...process.env };
      delete childEnv.TELEGRAM_BOT_TOKEN;

      const child = spawn(this.agyPath, args, {
        cwd: this.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });

      this._activeProcesses.set(sessionKey, child);
      this._pendingSessions.delete(sessionKey);

      let stdout = "";
      let stderr = "";

      // Use StringDecoder to safely handle multi-byte UTF-8 characters
      // that may be split across Buffer chunks (e.g. Chinese, emoji)
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");

      child.stdout.on("data", (chunk) => {
        stdout += stdoutDecoder.write(chunk);
        // Fire streaming callback if provided
        if (typeof options.onData === "function") {
          options.onData(stdout);
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr += stderrDecoder.write(chunk);
      });

      child.stdout.on("end", () => { stdout += stdoutDecoder.end(); });
      child.stderr.on("end", () => { stderr += stderrDecoder.end(); });

      const cleanup = () => {
        this._activeProcesses.delete(sessionKey);
        // Signal next in queue (event-based concurrency)
        if (this._waitQueue.length > 0) {
          const next = this._waitQueue.shift();
          next();
        }
      };

      child.on("close", (code) => {
        cleanup();
        resolve({
          ok: code === 0,
          exitCode: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs: Date.now() - startTime,
        });
      });

      child.on("error", (err) => {
        cleanup();
        resolve({
          ok: false,
          exitCode: -1,
          stdout: "",
          stderr: err.message,
          durationMs: Date.now() - startTime,
        });
      });

      // Hard timeout: 2x the agent timeout, minimum 5 minutes
      const hardMs = Math.max(timeoutMinutes * 2, 5) * 60 * 1000;
      const hardTimer = setTimeout(() => {
        if (child.exitCode === null) {
          log.warn(`hard timeout reached for session ${sessionKey}, terminating...`);
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, 5000);
        }
      }, hardMs);

      child.on("close", () => clearTimeout(hardTimer));
    });
  }

  /**
   * Stop the active task for the given session key.
   * Returns true if a task was active and stopped.
   */
  stop(sessionKey) {
    const child = this._activeProcesses.get(sessionKey);
    if (!child) return false;

    log.info(`stopping task for session ${sessionKey}`);
    try {
      child.kill("SIGTERM");
      // Fallback to SIGKILL if SIGTERM doesn't work within 3s
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 3000);
      return true;
    } catch (err) {
      log.error(`failed to stop task: ${err.message}`);
      return false;
    }
  }

  /**
   * Stop all running tasks. Used for graceful shutdown.
   * Mirrors cc-connect agent.Stop().
   */
  stopAll() {
    if (this._activeProcesses.size === 0) return;
    log.info(`stopping all ${this._activeProcesses.size} active task(s)...`);
    for (const [key, child] of this._activeProcesses) {
      try {
        child.kill("SIGTERM");
      } catch (err) {
        log.warn(`failed to stop task ${key}: ${err.message}`);
      }
    }
    // SIGKILL fallback after 3s
    setTimeout(() => {
      for (const [key, child] of this._activeProcesses) {
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }
    }, 3000);
  }

  get runningCount() {
    return this._activeProcesses.size;
  }
}

module.exports = { AgyAgentSession };
