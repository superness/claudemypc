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

CONTEXT MANAGEMENT - THINK PROACTIVELY:
You are communicating via Discord channels and threads. Be proactive about organizing conversations:

- If the user starts discussing a NEW PROJECT that doesn't have its own channel, suggest creating one and set up the project context

- If a conversation becomes a DEEP TASK (debugging, multi-step implementation), suggest creating a thread to keep focused context

- When you detect context switches, note them and suggest the appropriate channel

- Each channel should map to a working directory. If asked to work on a mismatched project, mention it.

The goal is to help maintain clean, contextual conversations AND build up persistent knowledge per project/channel.`;

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

    this.process = spawn('bash', ['-c', cmd], {
      cwd: this.workingDir,
      env: {
        ...process.env,
        TERM: 'dumb',
        WORKING_DIR: this.workingDir,
        CHANNEL_ID: this.channelId,
        THREAD_ID: this.threadId || '',
        GUILD_ID: config.discord.guildId || '',
        CONTEXT_DIR: join(config.paths.root, 'context'),
      },
      timeout: 600000, // 10 minute timeout
    });

    let fullOutput = '';
    let finalText = '';
    let stderr = '';

    this.process.stdout.on('data', (data) => {
      const chunk = data.toString();
      fullOutput += chunk;

      // Parse streaming JSON lines
      const lines = chunk.split('\n').filter(l => l.trim());
      for (const line of lines) {
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

      if (code === 0 || finalText) {
        resolve(finalText.trim() || '(No output)');
      } else if (fullOutput) {
        // Try to extract text from full output if finalText wasn't captured
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
