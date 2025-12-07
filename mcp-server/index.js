#!/usr/bin/env node

/**
 * MCP Server for DiscordMyPC
 * Provides tools for Discord channel management, file operations, and shell commands
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, exec } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, unlinkSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get config from environment
const WORKING_DIR = process.env.WORKING_DIR || '/mnt/c/github';
const GUILD_ID = process.env.GUILD_ID || '';
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const THREAD_ID = process.env.THREAD_ID || '';
const CONTEXT_DIR = process.env.CONTEXT_DIR || '/mnt/c/github/discordmypc/context';

// Context management functions
function getContextPath(id) {
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
  }
  return join(CONTEXT_DIR, `${id}.json`);
}

function loadContextData(id) {
  const contextPath = getContextPath(id);
  const defaultContext = {
    channelId: id,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    project: { name: '', description: '', type: '', mainFiles: [] },
    knowledge: {
      decisions: [],
      findings: [],
      issues: [],
      completedTasks: [],
      currentTask: '',
    },
    notes: '',
    recentSummary: '',
  };

  if (existsSync(contextPath)) {
    try {
      const data = JSON.parse(readFileSync(contextPath, 'utf-8'));
      return { ...defaultContext, ...data };
    } catch (err) {
      return defaultContext;
    }
  }
  return defaultContext;
}

function saveContextData(id, context) {
  const contextPath = getContextPath(id);
  context.updatedAt = new Date().toISOString();
  writeFileSync(contextPath, JSON.stringify(context, null, 2));
}

// Get effective context ID (thread > channel)
function getContextId() {
  return THREAD_ID || CHANNEL_ID;
}

// Simple IPC to communicate with Discord bot (via file-based messaging)
const IPC_DIR = process.env.IPC_DIR || '/tmp/discordmypc-ipc';

async function sendDiscordCommand(command, params) {
  // Write command to IPC file for Discord bot to pick up
  const timestamp = Date.now();
  const requestFile = join(IPC_DIR, `request-${timestamp}.json`);
  const responseFile = join(IPC_DIR, `response-${timestamp}.json`);

  if (!existsSync(IPC_DIR)) {
    mkdirSync(IPC_DIR, { recursive: true });
  }

  writeFileSync(requestFile, JSON.stringify({ command, params, responseFile }));

  // Wait for response (with timeout)
  const timeout = 30000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (existsSync(responseFile)) {
      const response = JSON.parse(readFileSync(responseFile, 'utf-8'));
      try { unlinkSync(requestFile); } catch (e) {}
      try { unlinkSync(responseFile); } catch (e) {}
      return response;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Clean up request file on timeout
  try { unlinkSync(requestFile); } catch (e) {}
  throw new Error('Discord command timeout - is the bot running?');
}

// Execute shell command
function runShell(command, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/bash', ['-c', command], {
      cwd: cwd || WORKING_DIR,
      timeout: 120000,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', code => {
      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        output: (stdout + stderr).trim()
      });
    });

    proc.on('error', reject);
  });
}

// Create the MCP server
const server = new Server(
  {
    name: 'discordmypc',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'run_command',
        description: 'Execute a shell command in the working directory. Use this to run builds, tests, git commands, or any CLI operation.',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command to execute'
            },
            working_dir: {
              type: 'string',
              description: 'Optional working directory (defaults to current project dir)'
            }
          },
          required: ['command']
        }
      },
      {
        name: 'read_file',
        description: 'Read the contents of a file',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file (relative to working dir or absolute)'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        description: 'Write content to a file (creates or overwrites)',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file'
            },
            content: {
              type: 'string',
              description: 'Content to write'
            }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'list_directory',
        description: 'List files and directories in a path',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path (defaults to working dir)'
            }
          }
        }
      },
      {
        name: 'search_files',
        description: 'Search for files matching a pattern using find/glob',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'File pattern to search for (e.g., "*.js", "package.json")'
            },
            path: {
              type: 'string',
              description: 'Directory to search in'
            }
          },
          required: ['pattern']
        }
      },
      {
        name: 'search_content',
        description: 'Search for text content in files using grep',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Text or regex pattern to search for'
            },
            path: {
              type: 'string',
              description: 'Directory to search in'
            },
            file_pattern: {
              type: 'string',
              description: 'Optional file pattern filter (e.g., "*.js")'
            }
          },
          required: ['pattern']
        }
      },
      {
        name: 'create_channel',
        description: 'Create a new Discord channel for a project or topic. Use this when starting work on a new project that needs its own context.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Channel name (will be lowercased, spaces become dashes)'
            },
            category: {
              type: 'string',
              description: 'Optional category to create the channel in (e.g., "Projects")'
            },
            working_dir: {
              type: 'string',
              description: 'Working directory to associate with this channel'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'create_thread',
        description: 'Create a new thread in the current channel. Use this for deep-dive tasks, debugging sessions, or multi-step work to keep the main channel clean.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Thread name describing the task or topic'
            },
            message: {
              type: 'string',
              description: 'Initial message to post in the thread'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'list_channels',
        description: 'List all Discord channels and their associated working directories',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'update_context',
        description: 'Update the persistent context/knowledge for this channel. Use this to save important findings, decisions, or notes that should be remembered across conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['decision', 'finding', 'task', 'notes', 'summary', 'project'],
              description: 'Type of context update: decision (key decision made), finding (important discovery), task (set current task), notes (freeform notes), summary (recent activity summary), project (project info)'
            },
            content: {
              type: 'string',
              description: 'The content to save'
            },
            project_info: {
              type: 'object',
              description: 'Project information (only for type=project)',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string' },
                mainFiles: { type: 'array', items: { type: 'string' } }
              }
            }
          },
          required: ['type', 'content']
        }
      },
      {
        name: 'get_context',
        description: 'Get the current saved context/knowledge for this channel. Use this to review what has been learned and decided.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'list_projects',
        description: 'List available project directories',
        inputSchema: {
          type: 'object',
          properties: {
            base_path: {
              type: 'string',
              description: 'Base path to list projects from (defaults to WORK_DIR)'
            }
          }
        }
      },
      {
        name: 'git_status',
        description: 'Get git status for a repository',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Repository path'
            }
          }
        }
      },
      {
        name: 'git_diff',
        description: 'Get git diff for a repository',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Repository path'
            },
            staged: {
              type: 'boolean',
              description: 'Show staged changes only'
            }
          }
        }
      },
      {
        name: 'read_channel_history',
        description: 'Read recent message history from a Discord channel. Use this to see what was discussed in another channel or to get context from previous conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            channel_id: {
              type: 'string',
              description: 'The Discord channel ID to read from. If not provided, uses the current channel.'
            },
            limit: {
              type: 'number',
              description: 'Number of messages to fetch (default: 20, max: 100)'
            }
          }
        }
      },
      {
        name: 'restart_bot',
        description: 'Restart the Discord bot to apply code changes. IMPORTANT: This will end your current session. The message you provide will be sent to Discord BEFORE the restart so the user knows what happened. Always summarize what you did and why you are restarting.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Message to send to Discord before restarting. Summarize what changes were made and why the restart is needed.'
            },
            delay_seconds: {
              type: 'number',
              description: 'Seconds to wait before restarting (default: 2). Gives time for message to be sent.'
            }
          },
          required: ['message']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'run_command': {
        const cwd = args.working_dir || WORKING_DIR;
        const result = await runShell(args.command, cwd);
        return {
          content: [{
            type: 'text',
            text: `Exit code: ${result.exitCode}\n\n${result.output || '(no output)'}`
          }]
        };
      }

      case 'read_file': {
        const filePath = args.path.startsWith('/') ? args.path : join(WORKING_DIR, args.path);
        if (!existsSync(filePath)) {
          return { content: [{ type: 'text', text: `Error: File not found: ${filePath}` }] };
        }
        const content = readFileSync(filePath, 'utf-8');
        return { content: [{ type: 'text', text: content }] };
      }

      case 'write_file': {
        const filePath = args.path.startsWith('/') ? args.path : join(WORKING_DIR, args.path);
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(filePath, args.content);
        return { content: [{ type: 'text', text: `File written: ${filePath}` }] };
      }

      case 'list_directory': {
        const dirPath = args.path ?
          (args.path.startsWith('/') ? args.path : join(WORKING_DIR, args.path)) :
          WORKING_DIR;

        if (!existsSync(dirPath)) {
          return { content: [{ type: 'text', text: `Error: Directory not found: ${dirPath}` }] };
        }

        const entries = readdirSync(dirPath, { withFileTypes: true });
        const listing = entries.map(e => {
          const prefix = e.isDirectory() ? '📁 ' : '📄 ';
          return prefix + e.name;
        }).join('\n');

        return { content: [{ type: 'text', text: `Contents of ${dirPath}:\n\n${listing}` }] };
      }

      case 'search_files': {
        const searchPath = args.path || WORKING_DIR;
        const result = await runShell(`find . -name "${args.pattern}" -type f 2>/dev/null | head -50`, searchPath);
        return { content: [{ type: 'text', text: result.output || 'No files found' }] };
      }

      case 'search_content': {
        const searchPath = args.path || WORKING_DIR;
        let cmd = `grep -r -n "${args.pattern}" . 2>/dev/null`;
        if (args.file_pattern) {
          cmd = `grep -r -n --include="${args.file_pattern}" "${args.pattern}" . 2>/dev/null`;
        }
        cmd += ' | head -100';
        const result = await runShell(cmd, searchPath);
        return { content: [{ type: 'text', text: result.output || 'No matches found' }] };
      }

      case 'create_channel': {
        const channelName = args.name.toLowerCase().replace(/\s+/g, '-');
        const workDir = args.working_dir || join(WORKING_DIR, channelName);

        const result = await sendDiscordCommand('create_channel', {
          name: channelName,
          category: args.category,
          workingDir: workDir,
          guildId: GUILD_ID,
        });

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: `✅ Created channel #${result.channelName} (ID: ${result.channelId})\nWorking directory: ${workDir}\n\nYou can now switch to that channel to work on this project.`
            }]
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: `❌ Failed to create channel: ${result.error}`
            }]
          };
        }
      }

      case 'create_thread': {
        if (!CHANNEL_ID) {
          return {
            content: [{
              type: 'text',
              text: `❌ Cannot create thread: No channel context available. This tool works when invoked from a Discord channel.`
            }]
          };
        }

        const result = await sendDiscordCommand('create_thread', {
          channelId: CHANNEL_ID,
          name: args.name,
          message: args.message,
        });

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: `✅ Created thread "${result.threadName}" (ID: ${result.threadId})\n\nContinue the conversation there for this specific task.`
            }]
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: `❌ Failed to create thread: ${result.error}`
            }]
          };
        }
      }

      case 'list_channels': {
        const result = await sendDiscordCommand('list_channels', {
          guildId: GUILD_ID,
        });

        if (result.success) {
          const channelList = result.channels.map(c => {
            const dir = c.workingDir ? ` → ${c.workingDir}` : '';
            const cat = c.category ? ` (${c.category})` : '';
            return `#${c.name} [${c.id}]${cat}${dir}`;
          }).join('\n');

          return {
            content: [{
              type: 'text',
              text: `Discord Channels:\n\n${channelList}`
            }]
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: `❌ Failed to list channels: ${result.error}`
            }]
          };
        }
      }

      case 'update_context': {
        const contextId = getContextId();
        if (!contextId) {
          return { content: [{ type: 'text', text: '❌ No channel/thread context available' }] };
        }

        const context = loadContextData(contextId);
        const now = new Date().toISOString();

        switch (args.type) {
          case 'decision':
            context.knowledge.decisions.push({ decision: args.content, timestamp: now });
            if (context.knowledge.decisions.length > 20) {
              context.knowledge.decisions = context.knowledge.decisions.slice(-20);
            }
            break;
          case 'finding':
            context.knowledge.findings.push({ finding: args.content, timestamp: now });
            if (context.knowledge.findings.length > 30) {
              context.knowledge.findings = context.knowledge.findings.slice(-30);
            }
            break;
          case 'task':
            // Archive current task
            if (context.knowledge.currentTask) {
              context.knowledge.completedTasks.push({
                task: context.knowledge.currentTask,
                completedAt: now
              });
            }
            context.knowledge.currentTask = args.content;
            break;
          case 'notes':
            context.notes = args.content;
            break;
          case 'summary':
            context.recentSummary = args.content;
            break;
          case 'project':
            if (args.project_info) {
              context.project = { ...context.project, ...args.project_info };
            } else {
              context.project.description = args.content;
            }
            break;
        }

        saveContextData(contextId, context);
        return { content: [{ type: 'text', text: `✅ Context updated (${args.type})` }] };
      }

      case 'get_context': {
        const contextId = getContextId();
        if (!contextId) {
          return { content: [{ type: 'text', text: '❌ No channel/thread context available' }] };
        }

        const context = loadContextData(contextId);
        const parts = [];

        parts.push(`=== CHANNEL CONTEXT (${contextId}) ===\n`);

        if (context.project.name) {
          parts.push(`PROJECT: ${context.project.name}`);
          if (context.project.description) parts.push(`Description: ${context.project.description}`);
          if (context.project.type) parts.push(`Type: ${context.project.type}`);
          if (context.project.mainFiles?.length > 0) parts.push(`Key files: ${context.project.mainFiles.join(', ')}`);
          parts.push('');
        }

        if (context.knowledge.currentTask) {
          parts.push(`CURRENT TASK: ${context.knowledge.currentTask}\n`);
        }

        if (context.knowledge.decisions.length > 0) {
          parts.push(`RECENT DECISIONS:`);
          for (const d of context.knowledge.decisions.slice(-5)) {
            parts.push(`- ${d.decision}`);
          }
          parts.push('');
        }

        if (context.knowledge.findings.length > 0) {
          parts.push(`KEY FINDINGS:`);
          for (const f of context.knowledge.findings.slice(-5)) {
            parts.push(`- ${f.finding}`);
          }
          parts.push('');
        }

        if (context.notes) {
          parts.push(`NOTES:\n${context.notes}\n`);
        }

        if (context.recentSummary) {
          parts.push(`RECENT ACTIVITY:\n${context.recentSummary}\n`);
        }

        if (context.knowledge.completedTasks.length > 0) {
          parts.push(`COMPLETED TASKS:`);
          for (const t of context.knowledge.completedTasks.slice(-5)) {
            parts.push(`- ${t.task}`);
          }
        }

        return { content: [{ type: 'text', text: parts.join('\n') || 'No context saved yet.' }] };
      }

      case 'list_projects': {
        const basePath = args.base_path || WORKING_DIR;
        const entries = readdirSync(basePath, { withFileTypes: true });
        const dirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name);

        return {
          content: [{
            type: 'text',
            text: `Projects in ${basePath}:\n\n${dirs.join('\n')}`
          }]
        };
      }

      case 'git_status': {
        const repoPath = args.path || WORKING_DIR;
        const result = await runShell('git status', repoPath);
        return { content: [{ type: 'text', text: result.output }] };
      }

      case 'git_diff': {
        const repoPath = args.path || WORKING_DIR;
        const cmd = args.staged ? 'git diff --staged' : 'git diff';
        const result = await runShell(cmd, repoPath);
        return { content: [{ type: 'text', text: result.output || '(no changes)' }] };
      }

      case 'read_channel_history': {
        const channelId = args.channel_id || CHANNEL_ID;
        if (!channelId) {
          return {
            content: [{
              type: 'text',
              text: '❌ No channel ID provided and no current channel context available.'
            }]
          };
        }

        const limit = Math.min(args.limit || 20, 100);

        const result = await sendDiscordCommand('read_channel_history', {
          channelId,
          limit,
        });

        if (result.success) {
          const messages = result.messages.map(m => {
            const time = new Date(m.timestamp).toLocaleString();
            return `[${time}] ${m.author}: ${m.content}`;
          }).join('\n\n');

          return {
            content: [{
              type: 'text',
              text: `=== Channel History (#${result.channelName}) ===\n\n${messages || '(no messages)'}`
            }]
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: `❌ Failed to read channel history: ${result.error}`
            }]
          };
        }
      }

      case 'restart_bot': {
        const channelId = CHANNEL_ID;
        if (!channelId) {
          return {
            content: [{
              type: 'text',
              text: '❌ No channel context available to send restart message.'
            }]
          };
        }

        const delay = args.delay_seconds || 2;
        const message = `🔄 **Restarting bot...**\n\n${args.message}`;

        // Send message to Discord first
        const result = await sendDiscordCommand('send_message', {
          channelId,
          message,
        });

        if (!result.success) {
          return {
            content: [{
              type: 'text',
              text: `❌ Failed to send restart message: ${result.error}`
            }]
          };
        }

        // Schedule the restart after a short delay
        setTimeout(() => {
          // Run npm start in the bot directory
          const botDir = join(dirname(fileURLToPath(import.meta.url)), '..');
          exec(`cd "${botDir}" && npm start`, (error) => {
            if (error) {
              console.error('Failed to restart:', error);
            }
          });
          // Exit this process to trigger the restart
          process.exit(0);
        }, delay * 1000);

        return {
          content: [{
            type: 'text',
            text: `✅ Restart message sent. Bot will restart in ${delay} seconds.`
          }]
        };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DiscordMyPC MCP server running');
}

main().catch(console.error);
