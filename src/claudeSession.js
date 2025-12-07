import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { Logger } from './logger.js';

const logger = new Logger('claudeSession');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to MCP config
const MCP_CONFIG_PATH = join(__dirname, 'config', 'mcp.json');

// System prompt explaining capabilities
const SYSTEM_PROMPT = `You are Claude, an AI assistant running on a local PC via Discord.

You have access to MCP tools that let you interact with this computer:

AVAILABLE TOOLS:
FILE & SHELL:
- run_command: Execute any shell command (builds, tests, git, npm, etc.)
- read_file: Read file contents
- write_file: Create or modify files
- list_directory: List files in a directory
- search_files: Find files by name pattern
- search_content: Search for text in files (grep)
- list_projects: List available project directories
- git_status: Check git repository status
- git_diff: View git changes

DISCORD:
- create_channel: Create a new Discord channel for a project
- create_thread: Create a thread in the current channel for focused work
- list_channels: See all channels and their working directories
- send_to_channel: Send a message to a different channel/thread (use to redirect or continue there)

BOT MANAGEMENT:
- restart_bot: Restart the bot to apply code changes. ALWAYS use this instead of running npm start directly. It sends your message to Discord BEFORE restarting so the user knows what happened.

CONTEXT/KNOWLEDGE (IMPORTANT!):
- update_context: Save important findings, decisions, tasks, notes to persistent memory
- get_context: Review what has been learned and decided in this channel/thread

WORKING DIRECTORY: {{WORKING_DIR}}
CHANNEL: {{CHANNEL_ID}}{{THREAD_INFO}}

When the user asks you to do something, USE THE TOOLS to actually do it. Don't just explain how - execute the commands and report results.

Be concise in responses. Execute actions, show relevant output, and summarize results.

KNOWLEDGE MANAGEMENT - CRITICAL:
You have persistent memory for this channel/thread. USE IT!

1. When you discover something important about a project (structure, key files, how to build/test), use update_context with type="finding"

2. When a key decision is made, use update_context with type="decision"

3. When starting a significant task, use update_context with type="task" to record what you're working on

4. After completing complex work, use update_context with type="summary" to record what was done

5. For a new project, use update_context with type="project" to record project details

This context persists across conversations! When you return to a channel, the saved knowledge is available so you don't have to re-discover things.

CONTEXT ORGANIZATION - BE PROACTIVE!
Discord has a hierarchy: Categories > Channels > Threads. Use it to keep work organized:

**BEFORE doing any task**, check if you're in the right place:
1. Use list_channels to see existing channels and their working directories
2. If user asks about a project that has its own channel, REDIRECT them: "Let's continue this in #project-name - heading there!"
3. If no channel exists for the project, CREATE ONE with create_channel

**CONTEXT HIERARCHY:**
- **Categories**: Group related projects (e.g., "Work", "Personal", "Games")
- **Channels**: One per project, tied to a working directory
- **Threads**: For focused tasks within a project (debugging sessions, feature implementations, investigations)

**WHEN TO CREATE/SWITCH:**
- User mentions a different project → Check if channel exists, redirect or create
- Starting a multi-step task (>3 steps) → Create a thread to track progress
- User says "let's work on X" → Find/create the right channel
- Conversation drifts to new topic → Suggest appropriate channel

**ALWAYS:**
- Start tasks by confirming you're in the right context
- When creating channels, set the working_dir to the project path
- Name threads descriptively: "debugging-auth-issue", "implementing-dark-mode"
- After creating a channel/thread, USE IT - send your next response there

**WORKING DIRECTORY MISMATCH:**
Current channel's working_dir is {{WORKING_DIR}}. If user asks about files/code in a DIFFERENT directory, that's a sign you should switch channels.

The goal: Every conversation should be in the right place, building up persistent knowledge for that project.`;

/**
 * Manages a Claude Code CLI session for a specific channel/context
 */
export class ClaudeSession extends EventEmitter {
  constructor(channelId, workingDir = null, threadId = null) {
    super();
    this.channelId = channelId;
    this.threadId = threadId;
    this.workingDir = workingDir || config.claude.workDir;
    this.process = null;
    this.buffer = '';
    this.isProcessing = false;
    this.messageQueue = [];
  }

  /**
   * Set thread ID (for when session is used in a thread)
   */
  setThreadId(threadId) {
    this.threadId = threadId;
  }

  /**
   * Send a message to Claude and get the response
   */
  async send(message) {
    return new Promise((resolve, reject) => {
      // Queue messages if already processing
      if (this.isProcessing) {
        this.messageQueue.push({ message, resolve, reject });
        return;
      }

      this.isProcessing = true;
      this.executeCommand(message, resolve, reject);
    });
  }

  executeCommand(message, resolve, reject) {
    // Build full prompt with system prompt
    let systemPrompt = SYSTEM_PROMPT
      .replace('{{WORKING_DIR}}', this.workingDir)
      .replace('{{CHANNEL_ID}}', this.channelId);

    // Add thread info if in a thread
    if (this.threadId) {
      systemPrompt = systemPrompt.replace('{{THREAD_INFO}}', ` (Thread: ${this.threadId})`);
    } else {
      systemPrompt = systemPrompt.replace('{{THREAD_INFO}}', '');
    }

    const fullPrompt = `${systemPrompt}\n\n--- Current Request ---\n${message}`;

    // Write prompt to temp file to avoid bash escaping issues
    const tempFile = join(tmpdir(), `claude-prompt-${this.channelId}-${Date.now()}.txt`);

    try {
      writeFileSync(tempFile, fullPrompt, 'utf8');
    } catch (err) {
      this.isProcessing = false;
      reject(err);
      return;
    }

    // Use stream-json for real-time streaming output (requires --verbose with --print, --include-partial-messages for actual text streaming)
    const cmd = `cat "${tempFile}" | ${config.claude.cliPath} --print --verbose --output-format stream-json --include-partial-messages --mcp-config "${MCP_CONFIG_PATH}" --dangerously-skip-permissions --allowedTools 'mcp__discordmypc__*'`;

    // Use absolute path to bash to avoid PATH issues
    this.process = spawn('/usr/bin/bash', ['-c', cmd], {
      cwd: this.workingDir,
      env: {
        ...process.env,
        TERM: 'dumb',
        WORKING_DIR: this.workingDir,
        CHANNEL_ID: this.channelId,
        THREAD_ID: this.threadId || '',
        GUILD_ID: config.discord.guildId || '',
        CONTEXT_DIR: join(config.paths.root, 'context'),
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      },
      timeout: 600000, // 10 minute timeout
    });

    let fullOutput = '';
    let finalText = '';
    let stderr = '';
    let lineBuffer = '';  // Buffer for incomplete JSON lines

    this.process.stdout.on('data', (data) => {
      const chunk = data.toString();
      fullOutput += chunk;

      // Add chunk to buffer and split by newlines
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');

      // Keep the last incomplete line in the buffer
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Handle different event types
          // Events can be wrapped in stream_event or at top level
          const innerEvent = event.type === 'stream_event' ? event.event : event;
          const innerType = innerEvent?.type;

          // Handle text streaming deltas
          if (innerType === 'content_block_delta') {
            const delta = innerEvent.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              // Actual text being generated
              this.emit('data', delta.text);
              this.emit('progress', delta.text);
            } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
              // Tool input being built - show what tool is doing
              this.emit('progress', `Building tool input...`);
            }
          } else if (innerType === 'content_block_start') {
            const block = innerEvent.content_block;
            if (block?.type === 'tool_use') {
              const toolName = block.name;
              logger.info(`Tool call: ${toolName}`);
              this.emit('progress', `Using tool: ${toolName}`);
            } else if (block?.type === 'text') {
              this.emit('progress', 'Thinking...');
            }
          } else if (event.type === 'assistant' && event.message?.content) {
            // Complete assistant message
            for (const block of event.message.content) {
              if (block.type === 'text') {
                finalText = block.text;
              }
            }
          } else if (event.type === 'result' && event.result) {
            // Final result
            finalText = event.result;
          }
        } catch (e) {
          // Not valid JSON, might be partial line
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      this.emit('progress', chunk);
    });

    this.process.on('close', (code) => {
      this.isProcessing = false;
      this.process = null;

      // Clean up temp file
      try { unlinkSync(tempFile); } catch (e) {}

      // Try to parse any remaining buffered line
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          if (event.type === 'result' && event.result) {
            finalText = event.result;
          }
        } catch (e) {
          // Ignore parse errors on close
        }
      }

      // If still no finalText, try to extract from fullOutput
      if (!finalText && fullOutput) {
        // Look for the result event in the full output
        const resultMatch = fullOutput.match(/"type":"result"[^}]*"result":"([^"]+)"/);
        if (resultMatch) {
          finalText = resultMatch[1];
        } else {
          // Try to parse each line again
          const outputLines = fullOutput.split('\n');
          for (const line of outputLines) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'result' && event.result) {
                finalText = event.result;
                break;
              }
            } catch (e) {}
          }
        }
      }

      if (code === 0 || finalText) {
        resolve(finalText.trim() || '(No output)');
      } else if (fullOutput) {
        // Last resort: return raw output
        resolve(fullOutput.trim());
      } else {
        reject(new Error(stderr || `Claude exited with code ${code}`));
      }

      // Process queued messages
      this.processQueue();
    });

    this.process.on('error', (err) => {
      this.isProcessing = false;
      this.process = null;
      // Clean up temp file
      try { unlinkSync(tempFile); } catch (e) {}
      reject(err);
      this.processQueue();
    });
  }

  /**
   * Send a message with streaming callback
   * The onProgress callback receives progress updates while Claude is working
   */
  async sendWithProgress(message, onProgress) {
    // Set up progress listener
    const progressHandler = (chunk) => {
      if (onProgress) onProgress(chunk);
    };
    this.on('progress', progressHandler);

    try {
      const response = await this.send(message);
      return response;
    } finally {
      this.off('progress', progressHandler);
    }
  }

  processQueue() {
    if (this.messageQueue.length > 0) {
      const { message, resolve, reject } = this.messageQueue.shift();
      this.isProcessing = true;
      this.executeCommand(message, resolve, reject);
    }
  }

  /**
   * Start an interactive conversation session
   */
  async startInteractive() {
    if (this.process) {
      return false;
    }

    this.process = spawn(config.claude.cliPath, ['--dangerously-skip-permissions'], {
      cwd: this.workingDir,
      env: {
        ...process.env,
        TERM: 'dumb',
      },
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.on('data', (data) => {
      this.emit('data', data.toString());
    });

    this.process.stderr.on('data', (data) => {
      this.emit('error', data.toString());
    });

    this.process.on('close', (code) => {
      this.process = null;
      this.emit('close', code);
    });

    return true;
  }

  /**
   * Send input to an interactive session
   */
  write(input) {
    if (this.process && this.process.stdin) {
      this.process.stdin.write(input + '\n');
      return true;
    }
    return false;
  }

  /**
   * Kill the current session
   */
  kill() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      this.isProcessing = false;
      return true;
    }
    return false;
  }

  /**
   * Check if session has an active process
   */
  isActive() {
    return this.process !== null;
  }

  /**
   * Set working directory for this session
   */
  setWorkingDir(dir) {
    this.workingDir = dir;
  }
}
