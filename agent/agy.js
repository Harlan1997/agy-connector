"use strict";

const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const { Agent } = require("../core/interfaces");
const { createLogger } = require("../core/logger");

const log = createLogger("agent");

// Regex to strip ANSI escape sequences from pty output
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b\[[\?]?[0-9;]*[a-zA-Z~$]|\r/g;

function cleanVal(val) {
  if (typeof val !== 'string') return '';
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\\"/g, '"').replace(/\\'/g, "'");
  return s;
}

function getFirstSentence(text) {
  if (typeof text !== 'string') return '';
  const cleaned = text.replace(/[\r\n]+/g, ' ').trim();
  if (!cleaned) return '';
  const match = cleaned.match(/^[^.!?]+[.!?]/);
  if (match) {
    return match[0].trim();
  }
  return cleaned.length > 60 ? cleaned.slice(0, 57) + '...' : cleaned;
}

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
      let latestThinking = "";

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

          const indicators = [
            {
              key: "authenticated via",
              altKey: "authenticated successfully",
              status: "🧠 Thinking & planning...",
            },
            {
              key: "streamGenerateContent",
              status: "✍️ Generating answer...",
            },
            {
              key: "generated tool calls",
              status: "🛠 Running tools...",
            },
            {
              key: "tool confirmation",
              altKey: "Tool confirmation",
              status: "🛠 Running tools...",
            },
            {
              key: "error executing cascade step",
              status: "⚠️ Tool error encountered, retrying...",
            }
          ];

          let maxIndex = -1;
          for (const ind of indicators) {
            let idx = content.lastIndexOf(ind.key);
            if (ind.altKey) {
              const altIdx = content.lastIndexOf(ind.altKey);
              if (altIdx > idx) idx = altIdx;
            }
            if (idx !== -1 && idx > maxIndex) {
              maxIndex = idx;
              status = ind.status;
            }
          }

          if (status === "🛠 Running tools...") {
            const matches = [...content.matchAll(/Auto-approving tool confirmation: "([^"]+)"/g)];
            if (matches.length > 0) {
              const lastTool = matches[matches.length - 1][1];
              status = `🛠 Running tool: ${lastTool}...`;
            } else {
              status = "🛠 Running tools to read/search files...";
            }
          }

          if (status !== lastStatus) {
            lastStatus = status;
            log.info(`[STATUS CHANGE]: ${status}`);
            if (typeof options.onStatus === "function") {
              options.onStatus(status);
            }
          }

          // Extract conversation ID and read transcript
          const convMatch = content.match(/Created conversation ([a-f0-9\-]+)/) || content.match(/conversation=([a-f0-9\-]+)/);
          if (convMatch) {
            const conversationId = convMatch[1];
            const appDataDir = process.env.AGY_APP_DATA_DIR || path.join(process.env.HOME || "/home/admin", ".gemini", "antigravity-cli");
            const transcriptPath = path.join(appDataDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");

            if (fs.existsSync(transcriptPath)) {
              try {
                const transcriptContent = fs.readFileSync(transcriptPath, "utf8");
                const lines = transcriptContent.split("\n");
                const steps = [];
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const step = JSON.parse(line);
                    if (step.type === "PLANNER_RESPONSE") {
                      steps.push(step);
                    }
                  } catch (e) {
                    // ignore JSON parse error of incomplete line
                  }
                }

                if (steps.length > 0) {
                  const lastIndex = steps.length - 1;
                  const lastStep = steps[lastIndex];
                  const isLastStepTool = lastStep.tool_calls && lastStep.tool_calls.length > 0;

                  const formattedSteps = [];
                  const limit = isLastStepTool ? steps.length : steps.length - 1;

                  for (let i = 0; i < limit; i++) {
                    const step = steps[i];
                    const isActive = isLastStepTool && (i === lastIndex);
                    
                    if (step.tool_calls && step.tool_calls.length > 0) {
                      const tc = step.tool_calls[0];
                      const summary = cleanVal(tc.args?.toolSummary || tc.args?.toolAction);
                      
                      let emoji = "🛠";
                      let desc = "";
                      const name = tc.name;
                      const args = tc.args || {};
                      
                      if (name === "run_command") {
                        emoji = "💻";
                        const cmd = cleanVal(args.CommandLine);
                        desc = summary || `Run: \`${cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd}\``;
                      } else if (name === "view_file") {
                        emoji = "🔍";
                        const file = path.basename(cleanVal(args.AbsolutePath));
                        desc = summary || `Read file \`${file}\``;
                      } else if (name === "replace_file_content" || name === "multi_replace_file_content" || name === "write_to_file") {
                        emoji = "📝";
                        const file = path.basename(cleanVal(args.TargetFile));
                        desc = summary || `Edit file \`${file}\``;
                      } else if (name === "grep_search") {
                        emoji = "🔎";
                        const query = cleanVal(args.Query);
                        desc = summary || `Search for "${query.length > 25 ? query.slice(0, 22) + '...' : query}"`;
                      } else if (name === "list_dir") {
                        emoji = "📂";
                        const dir = path.basename(cleanVal(args.DirectoryPath));
                        desc = summary || `List directory \`${dir}\``;
                      } else if (name === "search_web") {
                        emoji = "🌐";
                        const q = cleanVal(args.query);
                        desc = summary || `Web search: "${q.length > 25 ? q.slice(0, 22) + '...' : q}"`;
                      } else if (name === "invoke_subagent") {
                        emoji = "🤖";
                        const firstSub = args.Subagents?.[0];
                        const role = firstSub ? cleanVal(firstSub.Role) : "";
                        desc = summary || (role ? `Start subagent: \`${role}\`` : "Start subagent");
                      } else if (name === "define_subagent") {
                        emoji = "⚙️";
                        const subName = cleanVal(args.name);
                        desc = summary || (subName ? `Define subagent \`${subName}\`` : "Define subagent");
                      } else if (name === "send_message") {
                        emoji = "💬";
                        const msgText = cleanVal(args.Message);
                        desc = summary || (msgText ? `Send message: "${msgText.length > 25 ? msgText.slice(0, 22) + '...' : msgText}"` : "Send message to subagent");
                      } else if (name === "manage_subagents") {
                        emoji = "👥";
                        const action = cleanVal(args.Action);
                        desc = summary || (action ? `Manage subagents: \`${action}\`` : "Manage subagents");
                      } else if (name === "manage_task") {
                        emoji = "📋";
                        const action = cleanVal(args.Action);
                        desc = summary || (action ? `Manage task: \`${action}\`` : "Manage task");
                      } else if (name === "schedule") {
                        emoji = "⏰";
                        const duration = cleanVal(args.DurationSeconds);
                        const cron = cleanVal(args.CronExpression);
                        desc = summary || (cron ? `Schedule cron: \`${cron}\`` : duration ? `Set timer for ${duration}s` : "Schedule task");
                      } else if (name === "read_url_content" || name === "read_browser_page") {
                        emoji = "📖";
                        const url = cleanVal(args.Url || args.url);
                        desc = summary || (url ? `Read URL: \`${url.length > 30 ? url.slice(0, 27) + '...' : url}\`` : "Read web page");
                      } else if (name === "ask_permission" || name === "ask_question") {
                        emoji = "❓";
                        desc = summary || (name === "ask_permission" ? `Request permission: \`${cleanVal(args.Action)}\`` : "Ask user a question");
                      } else {
                        desc = summary || `Run ${name}`;
                      }

                      if (isActive) {
                        formattedSteps.push(`⏳ ${desc} (running...)`);
                      } else {
                        formattedSteps.push(`${emoji} ${desc}`);
                      }
                    } else {
                      const planDesc = getFirstSentence(step.content);
                      if (planDesc) {
                        formattedSteps.push(`🧠 Plan: ${planDesc}`);
                      }
                    }
                  }

                  let streamingDraft = "";
                  if (!isLastStepTool && lastStep.content) {
                    streamingDraft = lastStep.content.trim();
                  }

                  let activityLogAndDraft = "";
                  if (formattedSteps.length > 0) {
                    activityLogAndDraft += `📋 *Activity Log:*\n`;
                    if (formattedSteps.length > 5) {
                      const collapsedCount = formattedSteps.length - 5;
                      activityLogAndDraft += `• _... ${collapsedCount} older steps collapsed ..._\n`;
                      for (let j = formattedSteps.length - 5; j < formattedSteps.length; j++) {
                        activityLogAndDraft += `• ${formattedSteps[j]}\n`;
                      }
                    } else {
                      for (const stepStr of formattedSteps) {
                        activityLogAndDraft += `• ${stepStr}\n`;
                      }
                    }
                  }

                  if (streamingDraft) {
                    if (activityLogAndDraft) activityLogAndDraft += "\n";
                    activityLogAndDraft += `✍️ *Drafting Response...*\n\n${streamingDraft}`;
                  }

                  if (activityLogAndDraft && activityLogAndDraft !== latestThinking) {
                    latestThinking = activityLogAndDraft;
                    log.info(`[PROGRESS UPDATE] len: ${activityLogAndDraft.length}`);
                    if (typeof options.onData === "function") {
                      options.onData(activityLogAndDraft);
                    }
                  }
                }
              } catch (err) {
                // ignore read/parse errors
              }
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
            options.onData(latestThinking || fullOutput);
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
