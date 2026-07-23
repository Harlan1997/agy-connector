const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
let pty = null;
try {
  pty = require("node-pty");
} catch (e) {
  // node-pty optional, fall back to child_process.spawn
}
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
    this._abortedSessions = new Set(); // Sessions that were /stop'd
    this._waitQueue = [];              // Event-based queue
  }

  name() {
    return "agy";
  }

  /**
   * Check if a task is currently running for the given session key.
   * Used by the engine to decide whether to queue messages.
   */
  isRunning(sessionKey) {
    return this._activeProcesses.has(sessionKey) || this._pendingSessions.has(sessionKey);
  }

  /**
   * Run agy --print via node-pty for real-time streaming.
   * The pty makes agy think it's talking to a terminal, so it
   * flushes output incrementally instead of buffering to the end.
   */
  async run(sessionKey, prompt, options = {}) {
    const timeoutMinutes = parseInt(options.timeout || "5", 10);
    const noTimeout = timeoutMinutes <= 0;

    // Check for duplicate session — engine should have queued, this is a safety fallback
    if (this._activeProcesses.has(sessionKey) || this._pendingSessions.has(sessionKey)) {
      throw new Error("SESSION_BUSY");
    }

    // Wait for concurrency slot
    if (this._activeProcesses.size >= this.maxConcurrent) {
      await new Promise(resolve => this._waitQueue.push(resolve));
    }

    // Re-check after waiting
    if (this._activeProcesses.has(sessionKey) || this._pendingSessions.has(sessionKey)) {
      throw new Error("SESSION_BUSY");
    }

    this._pendingSessions.add(sessionKey);

    return new Promise((resolve) => {
      const startTime = Date.now();
      const logFilePath = `/tmp/agy_${sessionKey}.log`;
      try { fs.unlinkSync(logFilePath); } catch (e) {}

      // Build effective prompt: for resumed conversations, prepend a
      // non-interactive-mode note so the model doesn't stall waiting for
      // responses that will never arrive (--print is one-shot).
      let effectivePrompt = prompt;
      if (options.conversationId) {
        effectivePrompt =
          "[IMPORTANT — non-interactive session: You must NOT output " +
          "passive text like \"I will wait for...\" as your final answer. " +
          "If a previous tool (compile, simulation, build, subagent) seems " +
          "incomplete, use run_command or view_file to check its actual " +
          "result or output file directly. Do not assume it's still running. " +
          "Always end with a concrete result, summary, or next action.]\n\n" +
          prompt;
      }

      // --print-timeout: use configured value, or 24h when unlimited (0)
      const printTimeout = noTimeout ? "1440m" : `${timeoutMinutes}m`;
      const args = [
        "--print", effectivePrompt,
        "--print-timeout", printTimeout,
        "--log-file", logFilePath,
      ];

      // Resume an existing agy conversation for context continuity
      if (options.conversationId) {
        args.unshift("--conversation", options.conversationId);
        log.info(`resuming agy conversation: ${options.conversationId}`);
      }

      // Add --add-dir if workspace is set and isn't home directory
      const workspaceDir = options.workspaceDir || this.workspaceDir;
      if (workspaceDir && workspaceDir !== process.env.HOME) {
        args.unshift("--add-dir", workspaceDir);
      }

      // Filter env to exclude sensitive vars
      const childEnv = { ...process.env };
      delete childEnv.TELEGRAM_BOT_TOKEN;
      childEnv.TERM = "xterm-256color";

      let proc;
      try {
        if (pty) {
          proc = pty.spawn(this.agyPath, args, {
            name: "xterm-color",
            cols: 200,
            rows: 50,
            cwd: workspaceDir,
            env: childEnv,
          });
        } else {
          const cp = child_process.spawn(this.agyPath, args, {
            cwd: workspaceDir,
            env: childEnv,
          });
          const listeners = { data: [], exit: [] };
          proc = {
            pid: cp.pid,
            onData: (fn) => { listeners.data.push(fn); },
            onExit: (fn) => { listeners.exit.push(fn); },
            write: (data) => { try { cp.stdin.write(data); } catch {} },
            kill: (sig) => { try { cp.kill(sig); } catch {} }
          };
          cp.stdout.on("data", (data) => {
            listeners.data.forEach(fn => fn(data.toString("utf8")));
          });
          cp.stderr.on("data", (data) => {
            listeners.data.forEach(fn => fn(data.toString("utf8")));
          });
          cp.on("exit", (exitCode) => {
            listeners.exit.forEach(fn => fn({ exitCode: exitCode ?? 0 }));
          });
          cp.on("error", (err) => {
            log.error(`child_process error: ${err.message}`);
            listeners.exit.forEach(fn => fn({ exitCode: -1 }));
          });
        }
      } catch (err) {
        this._pendingSessions.delete(sessionKey);
        resolve({
          ok: false,
          exitCode: -1,
          stdout: "",
          stderr: `failed to spawn agy process: ${err.message}`,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      this._activeProcesses.set(sessionKey, proc);
      this._pendingSessions.delete(sessionKey);

      let fullOutput = "";
      let lastStatus = "⏳ Connecting & authenticating...";
      let latestThinking = "";
      let conversationIdNotified = false;
      let capturedConvId = options.conversationId || "";
      // For resumed conversations: the max step_index from previous turns.
      // Steps with step_index <= this value are old and should be hidden.
      // -1 means "not yet determined" (set on first transcript read).
      // 0 means "new conversation, show everything".
      let baselineStepIndex = options.conversationId ? -1 : 0;

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
            capturedConvId = conversationId;

            // Notify engine of the conversation ID (for session persistence)
            // Only fire once per run to avoid redundant calls from polling
            if (!conversationIdNotified && typeof options.onConversationId === "function") {
              conversationIdNotified = true;
              options.onConversationId(conversationId);
            }

            const appDataDir = process.env.AGY_APP_DATA_DIR || path.join(process.env.HOME || "/home/admin", ".gemini", "antigravity-cli");
            const transcriptPath = path.join(appDataDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");

            // On first transcript read for a resumed conversation, record
            // the max step_index so we can filter out old turns' steps.
            if (baselineStepIndex < 0) {
              try {
                const initContent = fs.readFileSync(transcriptPath, "utf8");
                let maxIdx = 0;
                for (const l of initContent.split("\n")) {
                  if (!l.trim()) continue;
                  try {
                    const s = JSON.parse(l);
                    if (s.step_index != null && s.step_index > maxIdx) {
                      maxIdx = s.step_index;
                    }
                  } catch { /* ignore */ }
                }
                baselineStepIndex = maxIdx;
                log.info(`baseline step_index for resumed conversation: ${baselineStepIndex}`);
              } catch {
                baselineStepIndex = 0;
              }
            }

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

                // Only show steps from the current turn by filtering on step_index
                const currentSteps = baselineStepIndex > 0
                  ? steps.filter(s => (s.step_index || 0) > baselineStepIndex)
                  : steps;

                if (currentSteps.length > 0) {
                  const lastIndex = currentSteps.length - 1;
                  const lastStep = currentSteps[lastIndex];
                  const isLastStepTool = lastStep.tool_calls && lastStep.tool_calls.length > 0;

                  const formattedSteps = [];
                  const limit = isLastStepTool ? currentSteps.length : currentSteps.length - 1;

                  for (let i = 0; i < limit; i++) {
                    const step = currentSteps[i];
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
                    // Ensure prefix so engine recognizes this as activity log format
                    if (!activityLogAndDraft) {
                      activityLogAndDraft = `📋 *Activity Log:*\n`;
                    }
                    activityLogAndDraft += `\n✍️ *Drafting Response...*\n\n${streamingDraft}`;
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
          // Fire streaming callback with accumulated output.
          // For resumed conversations, only send the transcript-based activity
          // log (latestThinking) — NOT the raw PTY output — because agy --print
          // replays all previous turns' text to stdout, which would show
          // historical messages in the streaming preview.
          if (typeof options.onData === "function") {
            if (latestThinking) {
              options.onData(latestThinking);
            } else if (!options.conversationId) {
              // New conversations: safe to show raw output (no history to leak)
              options.onData(fullOutput);
            }
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
        // If user explicitly /stop'd, force exit code to -1 (manual stop signal)
        const wasAborted = this._abortedSessions.has(sessionKey);
        if (wasAborted) {
          this._abortedSessions.delete(sessionKey);
          exitCode = -1;
        }

        // Extract only the current turn's final response from transcript.
        // This avoids sending accumulated output from all previous turns
        // which happens when agy --print --conversation resumes a conversation.
        let finalResponse = "";
        if (capturedConvId) {
          try {
            const appDataDir = process.env.AGY_APP_DATA_DIR || path.join(process.env.HOME || "/home/admin", ".gemini", "antigravity-cli");
            const transcriptPath = path.join(appDataDir, "brain", capturedConvId, ".system_generated", "logs", "transcript.jsonl");
            if (fs.existsSync(transcriptPath)) {
              const tContent = fs.readFileSync(transcriptPath, "utf8");
              const allSteps = [];
              for (const tLine of tContent.split("\n")) {
                if (!tLine.trim()) continue;
                try {
                  const s = JSON.parse(tLine);
                  if (s.type === "PLANNER_RESPONSE") allSteps.push(s);
                } catch { /* ignore */ }
              }
              // Filter to current turn only
              const turnSteps = baselineStepIndex > 0
                ? allSteps.filter(s => (s.step_index || 0) > baselineStepIndex)
                : allSteps;
              // Find the last text response (PLANNER_RESPONSE without tool_calls)
              for (let i = turnSteps.length - 1; i >= 0; i--) {
                const s = turnSteps[i];
                if ((!s.tool_calls || s.tool_calls.length === 0) && s.content && s.content.trim()) {
                  finalResponse = s.content.trim();
                  break;
                }
              }
              if (finalResponse) {
                log.info(`extracted final response from transcript (${finalResponse.length} chars)`);
              }
            }
          } catch (err) {
            log.debug(`failed to extract final response from transcript: ${err.message}`);
          }
        }

        resolve({
          ok: exitCode === 0,
          exitCode,
          stdout: fullOutput.trim(),
          finalResponse,
          stderr: "",
          durationMs: Date.now() - startTime,
        });
      });

      // Hard timeout (skipped when timeout is 0 = unlimited)
      let hardTimer = null;
      if (!noTimeout) {
        const hardMs = Math.max(timeoutMinutes * 2, 5) * 60 * 1000;
        hardTimer = setTimeout(() => {
          log.warn(`hard timeout reached for session ${sessionKey}, terminating...`);
          try { proc.kill(); } catch {}
        }, hardMs);
        proc.onExit(() => clearTimeout(hardTimer));
      }
    });
  }

  /**
   * Stop the active task for the given session key.
   */
  stop(sessionKey) {
    const proc = this._activeProcesses.get(sessionKey);
    if (!proc) return false;

    const pid = proc.pid;
    log.info(`stopping task for session ${sessionKey}, pid=${pid}`);

    // Mark as aborted so the run() resolver knows this was user-initiated
    this._abortedSessions.add(sessionKey);

    try {
      // Stage 1: Write Ctrl+C (ETX) to the pty — simulates keyboard interrupt
      try {
        proc.write("\x03");
      } catch { /* pty might already be closed */ }

      // Stage 2: Use node-pty's own kill with SIGTERM (more reliable for pty)
      try {
        proc.kill("SIGTERM");
      } catch { /* ignore */ }

      // Stage 3: Kill child processes of the pty process
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
      }

      // Also kill the entire child tree via pkill (catches deeply nested children)
      try {
        const { execSync } = require("child_process");
        execSync(`pkill -TERM -P ${pid} 2>/dev/null || true`, { timeout: 2000 });
      } catch { /* ignore */ }

      // Stage 4: If still running after 1.5s, escalate to SIGKILL
      setTimeout(() => {
        if (this._activeProcesses.has(sessionKey)) {
          log.warn(`task still running after SIGTERM, sending SIGKILL, pid=${pid}`);
          // Kill the entire child tree first
          try {
            const { execSync } = require("child_process");
            execSync(`pkill -KILL -P ${pid} 2>/dev/null || true`, { timeout: 2000 });
          } catch { /* ignore */ }

          // Kill process group
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
          }

          // Final fallback: node-pty kill
          try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 1500);

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
    for (const [key] of this._activeProcesses) {
      this.stop(key);
    }
  }

  get runningCount() {
    return this._activeProcesses.size;
  }
}

module.exports = { AgyAgentSession };
