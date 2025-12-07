/**
 * Discord IPC Handler
 * Processes requests from MCP server to perform Discord API operations
 */

import { ChannelType } from 'discord.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, watch } from 'fs';
import { join } from 'path';
import { Logger } from './logger.js';

const logger = new Logger('discordIpc');

const IPC_DIR = process.env.IPC_DIR || '/tmp/discordmypc-ipc';

export class DiscordIpcHandler {
  constructor(client, sessionManager) {
    this.client = client;
    this.sessionManager = sessionManager;
    this.running = false;
    this.watcher = null;
  }

  start() {
    // Ensure IPC directory exists
    if (!existsSync(IPC_DIR)) {
      mkdirSync(IPC_DIR, { recursive: true });
    }

    // Clean up old request files
    this.cleanupOldFiles();

    // Watch for new request files
    this.running = true;
    this.pollForRequests();

    logger.info(`Discord IPC handler started, watching ${IPC_DIR}`);
  }

  stop() {
    this.running = false;
    if (this.watcher) {
      this.watcher.close();
    }
  }

  cleanupOldFiles() {
    try {
      const files = readdirSync(IPC_DIR);
      for (const file of files) {
        if (file.startsWith('request-') || file.startsWith('response-')) {
          try {
            unlinkSync(join(IPC_DIR, file));
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  async pollForRequests() {
    while (this.running) {
      try {
        const files = readdirSync(IPC_DIR);
        const requestFiles = files.filter(f => f.startsWith('request-'));

        for (const file of requestFiles) {
          const requestPath = join(IPC_DIR, file);
          try {
            const request = JSON.parse(readFileSync(requestPath, 'utf-8'));
            const response = await this.handleRequest(request);

            // Write response
            if (request.responseFile) {
              writeFileSync(request.responseFile, JSON.stringify(response));
            }

            // Delete request file
            unlinkSync(requestPath);
          } catch (err) {
            logger.error(`Failed to process IPC request ${file}:`, err);
            try { unlinkSync(requestPath); } catch (e) {}
          }
        }
      } catch (err) {
        // Directory might not exist yet
      }

      // Poll every 100ms
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async handleRequest(request) {
    const { command, params } = request;
    logger.info(`IPC request: ${command}`);

    try {
      switch (command) {
        case 'create_channel':
          return await this.createChannel(params);

        case 'create_thread':
          return await this.createThread(params);

        case 'send_message':
          return await this.sendMessage(params);

        case 'set_channel_dir':
          return await this.setChannelDir(params);

        case 'list_channels':
          return await this.listChannels(params);

        case 'read_channel_history':
          return await this.readChannelHistory(params);

        default:
          return { success: false, error: `Unknown command: ${command}` };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async createChannel(params) {
    const { name, category, workingDir, guildId } = params;
    const channelName = name.toLowerCase().replace(/\s+/g, '-');

    // Get the guild
    const guild = this.client.guilds.cache.get(guildId) || this.client.guilds.cache.first();
    if (!guild) {
      return { success: false, error: 'No guild found' };
    }

    // Find or create category
    let categoryChannel = null;
    if (category) {
      categoryChannel = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === category.toLowerCase()
      );
      if (!categoryChannel) {
        categoryChannel = await guild.channels.create({
          name: category,
          type: ChannelType.GuildCategory,
        });
      }
    }

    // Create the channel
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryChannel?.id,
      topic: workingDir ? `Working directory: ${workingDir}` : undefined,
    });

    // Set working directory mapping if provided
    if (workingDir) {
      this.sessionManager.setChannelMapping(channel.id, workingDir);
    }

    return {
      success: true,
      channelId: channel.id,
      channelName: channel.name,
      message: `Created channel #${channel.name}`
    };
  }

  async createThread(params) {
    const { channelId, name, message } = params;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.threads) {
      return { success: false, error: 'Channel not found or does not support threads' };
    }

    const thread = await channel.threads.create({
      name: name,
      autoArchiveDuration: 1440, // 24 hours
      type: ChannelType.PublicThread,
      reason: 'Created by Claude via MCP',
    });

    // Send initial message if provided
    if (message) {
      await thread.send(message);
    }

    return {
      success: true,
      threadId: thread.id,
      threadName: thread.name,
      message: `Created thread "${thread.name}"`
    };
  }

  async sendMessage(params) {
    const { channelId, content } = params;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    const msg = await channel.send(content);
    return {
      success: true,
      messageId: msg.id,
    };
  }

  async setChannelDir(params) {
    const { channelId, workingDir } = params;
    this.sessionManager.setChannelMapping(channelId, workingDir);
    return {
      success: true,
      message: `Set working directory for channel to ${workingDir}`
    };
  }

  async listChannels(params) {
    const { guildId } = params;
    const guild = this.client.guilds.cache.get(guildId) || this.client.guilds.cache.first();

    if (!guild) {
      return { success: false, error: 'No guild found' };
    }

    const channels = guild.channels.cache
      .filter(c => c.type === ChannelType.GuildText)
      .map(c => ({
        id: c.id,
        name: c.name,
        category: c.parent?.name || null,
        workingDir: this.sessionManager.channelMappings.get(c.id) || null,
      }));

    return {
      success: true,
      channels
    };
  }

  async readChannelHistory(params) {
    const { channelId, limit = 20 } = params;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    // Fetch messages
    const messages = await channel.messages.fetch({ limit: Math.min(limit, 100) });

    // Convert to array and reverse to get chronological order (oldest first)
    const messageList = [...messages.values()].reverse().map(m => ({
      id: m.id,
      author: m.author.bot ? `${m.author.username} [BOT]` : m.author.username,
      content: m.content || '(no text content)',
      timestamp: m.createdAt.toISOString(),
      attachments: m.attachments.size > 0 ? m.attachments.map(a => a.url) : [],
    }));

    return {
      success: true,
      channelId: channel.id,
      channelName: channel.name,
      messages: messageList,
    };
  }
}

// Export IPC directory for MCP server to use
export const IPC_DIRECTORY = IPC_DIR;
