import { SlashCommandBuilder, ChannelType, AttachmentBuilder } from 'discord.js';
import { config, getInstancePrefix } from './config.js';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { spawn } from 'child_process';
import { Logger } from './logger.js';
import { TaskStatus } from './taskQueue.js';

const logger = new Logger('commands');

/**
 * Slash command definitions
 */
export const commands = [
  // Create a new project channel
  new SlashCommandBuilder()
    .setName('newchannel')
    .setDescription('Create a new channel for a project/context')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Channel name (will try to match project directory)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('path')
        .setDescription('Working directory path (optional, auto-detects from name)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Category to create channel in')
        .setRequired(false)),

  // Set working directory for current channel
  new SlashCommandBuilder()
    .setName('setdir')
    .setDescription('Set the working directory for this channel')
    .addStringOption(option =>
      option.setName('path')
        .setDescription('Full path to working directory')
        .setRequired(true)),

  // Show current session info
  new SlashCommandBuilder()
    .setName('info')
    .setDescription('Show current channel session info'),

  // List available projects
  new SlashCommandBuilder()
    .setName('projects')
    .setDescription('List available project directories'),

  // Kill current session
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset/kill the Claude session for this channel'),

  // Bot status
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status and all active sessions'),

  // Self-update command
  new SlashCommandBuilder()
    .setName('update')
    .setDescription('Update the bot code and restart'),

  // Restart bot
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the bot'),

  // Run arbitrary shell command
  new SlashCommandBuilder()
    .setName('shell')
    .setDescription('Run a shell command in the channel working directory')
    .addStringOption(option =>
      option.setName('command')
        .setDescription('Shell command to execute')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('background')
        .setDescription('Run in background as a task')
        .setRequired(false)),

  // Run a background task
  new SlashCommandBuilder()
    .setName('task')
    .setDescription('Manage background tasks')
    .addSubcommand(sub =>
      sub.setName('run')
        .setDescription('Run a command as a background task')
        .addStringOption(opt =>
          opt.setName('command')
            .setDescription('Command to run')
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('description')
            .setDescription('Task description')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all tasks'))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Get status of a specific task')
        .addStringOption(opt =>
          opt.setName('id')
            .setDescription('Task ID')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel a task')
        .addStringOption(opt =>
          opt.setName('id')
            .setDescription('Task ID')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('output')
        .setDescription('Get output of a task')
        .addStringOption(opt =>
          opt.setName('id')
            .setDescription('Task ID')
            .setRequired(true))),

  // File operations
  new SlashCommandBuilder()
    .setName('file')
    .setDescription('File operations')
    .addSubcommand(sub =>
      sub.setName('get')
        .setDescription('Download a file from the working directory')
        .addStringOption(opt =>
          opt.setName('path')
            .setDescription('File path (relative to working dir or absolute)')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List files in a directory')
        .addStringOption(opt =>
          opt.setName('path')
            .setDescription('Directory path (relative or absolute)')
            .setRequired(false))),

  // Instance management (for multi-PC)
  new SlashCommandBuilder()
    .setName('instances')
    .setDescription('Show all connected bot instances'),

  // Which PC is this?
  new SlashCommandBuilder()
    .setName('whoami')
    .setDescription('Show which PC instance this is'),

  // Run command on specific PC (uses channel topic or prefix)
  new SlashCommandBuilder()
    .setName('pc')
    .setDescription('Send command to a specific PC instance')
    .addStringOption(opt =>
      opt.setName('target')
        .setDescription('Target PC name or ID')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Message/command to send')
        .setRequired(true)),

  // Deploy command
  new SlashCommandBuilder()
    .setName('deploy')
    .setDescription('Run deployment script')
    .addStringOption(opt =>
      opt.setName('script')
        .setDescription('Deployment script path (default: ./deploy.sh)')
        .setRequired(false))
    .addBooleanOption(opt =>
      opt.setName('background')
        .setDescription('Run in background')
        .setRequired(false)),

  // Git shortcuts
  new SlashCommandBuilder()
    .setName('git')
    .setDescription('Git operations')
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show git status'))
    .addSubcommand(sub =>
      sub.setName('pull')
        .setDescription('Pull latest changes'))
    .addSubcommand(sub =>
      sub.setName('log')
        .setDescription('Show recent commits')
        .addIntegerOption(opt =>
          opt.setName('count')
            .setDescription('Number of commits to show')
            .setRequired(false))),
];

/**
 * Handle slash commands
 */
export async function handleCommand(interaction, sessionManager, taskQueue, client) {
  const { commandName, channelId, channel } = interaction;
  const prefix = getInstancePrefix();

  switch (commandName) {
    case 'newchannel': {
      await interaction.deferReply();
      const name = interaction.options.getString('name').toLowerCase().replace(/\s+/g, '-');
      const path = interaction.options.getString('path');
      const categoryName = interaction.options.getString('category');

      try {
        // Find or create category
        let category = null;
        if (categoryName) {
          category = interaction.guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
          );
          if (!category) {
            category = await interaction.guild.channels.create({
              name: categoryName,
              type: ChannelType.GuildCategory,
            });
          }
        }

        // Create the channel
        const newChannel = await interaction.guild.channels.create({
          name: name,
          type: ChannelType.GuildText,
          parent: category?.id,
          topic: `${prefix} Claude Code session - Working dir: ${path || 'auto-detect'}`,
        });

        // Set working directory if provided
        if (path && existsSync(path)) {
          sessionManager.setChannelMapping(newChannel.id, path);
        } else {
          // Try auto-detect
          const autoPath = join(config.claude.workDir, name);
          if (existsSync(autoPath)) {
            sessionManager.setChannelMapping(newChannel.id, autoPath);
          }
        }

        await interaction.editReply(`${prefix} ✅ Created channel <#${newChannel.id}>`);
      } catch (err) {
        await interaction.editReply(`${prefix} ❌ Failed to create channel: ${err.message}`);
      }
      break;
    }

    case 'setdir': {
      const path = interaction.options.getString('path');
      if (!existsSync(path)) {
        await interaction.reply({ content: `${prefix} ❌ Directory does not exist: ${path}`, ephemeral: true });
        return;
      }
      sessionManager.setChannelMapping(channelId, path);
      await interaction.reply(`${prefix} ✅ Working directory set to: \`${path}\``);
      break;
    }

    case 'info': {
      const session = sessionManager.getSession(channelId, channel.name);
      const workDir = session.workingDir;
      const isActive = session.isActive();
      const isProcessing = session.isProcessing;
      const queueLength = session.messageQueue.length;

      await interaction.reply({
        embeds: [{
          title: `${prefix} 📊 Channel Session Info`,
          fields: [
            { name: 'Instance', value: `${config.instance.emoji} ${config.instance.name}`, inline: true },
            { name: 'Channel', value: `<#${channelId}>`, inline: true },
            { name: 'Working Directory', value: `\`${workDir}\``, inline: false },
            { name: 'Session Active', value: isActive ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Processing', value: isProcessing ? '⏳ Yes' : '✅ No', inline: true },
            { name: 'Queue Length', value: `${queueLength}`, inline: true },
          ],
          color: 0x5865F2,
        }],
      });
      break;
    }

    case 'projects': {
      try {
        const baseDir = config.claude.workDir;
        const entries = readdirSync(baseDir, { withFileTypes: true });
        const dirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name)
          .slice(0, 30);

        await interaction.reply({
          embeds: [{
            title: `${prefix} 📁 Available Projects`,
            description: dirs.map(d => `\`${d}\``).join('\n') || 'No directories found',
            footer: { text: `Base: ${baseDir}` },
            color: 0x5865F2,
          }],
        });
      } catch (err) {
        await interaction.reply(`${prefix} ❌ Error listing projects: ${err.message}`);
      }
      break;
    }

    case 'reset': {
      const removed = sessionManager.removeSession(channelId);
      await interaction.reply(removed ? `${prefix} ✅ Session reset.` : `${prefix} ℹ️ No active session to reset.`);
      break;
    }

    case 'status': {
      const sessionStatus = sessionManager.getStatus();
      const taskStatus = taskQueue.getStatus();

      const sessionFields = sessionStatus.slice(0, 5).map(s => ({
        name: `<#${s.channelId}>`,
        value: `Dir: \`${s.workingDir}\`\nActive: ${s.isActive ? '✅' : '❌'} | Processing: ${s.isProcessing ? '⏳' : '✅'} | Queue: ${s.queueLength}`,
        inline: false,
      }));

      await interaction.reply({
        embeds: [{
          title: `${prefix} 🤖 Bot Status`,
          description: [
            `**Instance:** ${config.instance.emoji} ${config.instance.name} (\`${config.instance.id}\`)`,
            `**Sessions:** ${sessionStatus.length}`,
            `**Tasks:** ${taskStatus.running} running, ${taskStatus.pending} pending`,
            `**Uptime:** ${formatUptime(process.uptime())}`,
          ].join('\n'),
          fields: sessionFields,
          color: 0x5865F2,
        }],
      });
      break;
    }

    case 'update': {
      await interaction.reply(`${prefix} 🔄 Pulling latest changes and restarting...`);
      return { action: 'update' };
    }

    case 'restart': {
      await interaction.reply(`${prefix} 🔄 Restarting...`);
      return { action: 'restart' };
    }

    case 'shell': {
      const command = interaction.options.getString('command');
      const background = interaction.options.getBoolean('background') || false;
      const session = sessionManager.getSession(channelId, channel.name);

      if (background) {
        await interaction.deferReply();
        const task = await taskQueue.addTask({
          type: 'shell',
          command,
          workingDir: session.workingDir,
          channelId,
          userId: interaction.user.id,
          description: command.slice(0, 50),
        });
        await interaction.editReply(`${prefix} ✅ Task started: \`${task.id}\`\nUse \`/task status id:${task.id}\` to check progress.`);
      } else {
        await interaction.deferReply();
        const proc = spawn('bash', ['-c', command], {
          cwd: session.workingDir,
          timeout: 60000,
        });

        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.stderr.on('data', d => output += d.toString());

        proc.on('close', async (code) => {
          const result = output.trim() || '(No output)';
          const truncated = result.length > 1800 ? result.slice(0, 1800) + '\n...(truncated)' : result;
          await interaction.editReply(`${prefix}\n\`\`\`\n$ ${command}\n\n${truncated}\n\nExit code: ${code}\`\`\``);
        });

        proc.on('error', async (err) => {
          await interaction.editReply(`${prefix} ❌ Error: ${err.message}`);
        });
      }
      break;
    }

    case 'task': {
      const subcommand = interaction.options.getSubcommand();

      switch (subcommand) {
        case 'run': {
          await interaction.deferReply();
          const command = interaction.options.getString('command');
          const description = interaction.options.getString('description');
          const session = sessionManager.getSession(channelId, channel.name);

          const task = await taskQueue.addTask({
            type: 'shell',
            command,
            workingDir: session.workingDir,
            channelId,
            userId: interaction.user.id,
            description: description || command.slice(0, 50),
          });

          await interaction.editReply({
            embeds: [{
              title: `${prefix} ✅ Task Created`,
              fields: [
                { name: 'ID', value: `\`${task.id}\``, inline: true },
                { name: 'Status', value: task.status, inline: true },
                { name: 'Command', value: `\`${command.slice(0, 100)}\``, inline: false },
              ],
              color: 0x5865F2,
            }],
          });
          break;
        }

        case 'list': {
          const tasks = taskQueue.getActiveTasks();
          const channelTasks = taskQueue.getChannelTasks(channelId);

          await interaction.reply({
            embeds: [{
              title: `${prefix} 📋 Tasks`,
              description: tasks.length === 0 ? 'No active tasks' :
                tasks.map(t =>
                  `\`${t.id.slice(0, 8)}\` - ${getStatusEmoji(t.status)} ${t.description}`
                ).join('\n'),
              footer: { text: `Total channel tasks: ${channelTasks.length}` },
              color: 0x5865F2,
            }],
          });
          break;
        }

        case 'status': {
          const taskId = interaction.options.getString('id');
          const task = taskQueue.getTask(taskId);

          if (!task) {
            await interaction.reply({ content: `${prefix} ❌ Task not found`, ephemeral: true });
            return;
          }

          await interaction.reply({
            embeds: [{
              title: `${prefix} Task Status`,
              fields: [
                { name: 'ID', value: `\`${task.id}\``, inline: true },
                { name: 'Status', value: `${getStatusEmoji(task.status)} ${task.status}`, inline: true },
                { name: 'Type', value: task.type, inline: true },
                { name: 'Command', value: `\`${task.command.slice(0, 100)}\``, inline: false },
                { name: 'Working Dir', value: `\`${task.workingDir}\``, inline: false },
                { name: 'Created', value: task.createdAt.toISOString(), inline: true },
                { name: 'Duration', value: task.completedAt
                  ? `${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s`
                  : task.startedAt
                    ? `${((Date.now() - task.startedAt.getTime()) / 1000).toFixed(1)}s (running)`
                    : 'Not started', inline: true },
              ],
              color: task.status === TaskStatus.COMPLETED ? 0x00FF00 :
                     task.status === TaskStatus.FAILED ? 0xFF0000 : 0x5865F2,
            }],
          });
          break;
        }

        case 'cancel': {
          const taskId = interaction.options.getString('id');
          const cancelled = taskQueue.cancelTask(taskId);
          await interaction.reply(cancelled
            ? `${prefix} ✅ Task cancelled`
            : `${prefix} ❌ Could not cancel task (not found or already completed)`);
          break;
        }

        case 'output': {
          const taskId = interaction.options.getString('id');
          const task = taskQueue.getTask(taskId);

          if (!task) {
            await interaction.reply({ content: `${prefix} ❌ Task not found`, ephemeral: true });
            return;
          }

          const output = task.output || '(No output yet)';
          const truncated = output.length > 1800 ? '...' + output.slice(-1800) : output;

          await interaction.reply(`${prefix} **Task Output** (\`${taskId.slice(0, 8)}\`):\n\`\`\`\n${truncated}\n\`\`\``);
          break;
        }
      }
      break;
    }

    case 'file': {
      const subcommand = interaction.options.getSubcommand();
      const session = sessionManager.getSession(channelId, channel.name);

      switch (subcommand) {
        case 'get': {
          await interaction.deferReply();
          const filePath = interaction.options.getString('path');
          const fullPath = filePath.startsWith('/') ? filePath : join(session.workingDir, filePath);

          if (!existsSync(fullPath)) {
            await interaction.editReply(`${prefix} ❌ File not found: ${filePath}`);
            return;
          }

          const stats = statSync(fullPath);
          if (stats.size > 8 * 1024 * 1024) { // 8MB Discord limit
            await interaction.editReply(`${prefix} ❌ File too large (${(stats.size / 1024 / 1024).toFixed(2)}MB > 8MB limit)`);
            return;
          }

          const attachment = new AttachmentBuilder(fullPath, { name: basename(fullPath) });
          await interaction.editReply({
            content: `${prefix} 📎 File: \`${filePath}\``,
            files: [attachment],
          });
          break;
        }

        case 'list': {
          const dirPath = interaction.options.getString('path') || '.';
          const fullPath = dirPath.startsWith('/') ? dirPath : join(session.workingDir, dirPath);

          if (!existsSync(fullPath)) {
            await interaction.reply(`${prefix} ❌ Directory not found: ${dirPath}`);
            return;
          }

          try {
            const entries = readdirSync(fullPath, { withFileTypes: true });
            const files = entries.slice(0, 50).map(e => {
              const icon = e.isDirectory() ? '📁' : '📄';
              return `${icon} ${e.name}`;
            });

            await interaction.reply({
              embeds: [{
                title: `${prefix} 📂 ${dirPath}`,
                description: files.join('\n') || 'Empty directory',
                footer: { text: `Total: ${entries.length} items` },
                color: 0x5865F2,
              }],
            });
          } catch (err) {
            await interaction.reply(`${prefix} ❌ Error: ${err.message}`);
          }
          break;
        }
      }
      break;
    }

    case 'instances': {
      // This shows this instance - in a multi-bot setup, all bots would respond
      await interaction.reply({
        embeds: [{
          title: '🖥️ Connected Instances',
          description: `${config.instance.emoji} **${config.instance.name}** (\`${config.instance.id}\`)\n` +
            `Working Dir: \`${config.claude.workDir}\`\n` +
            `Uptime: ${formatUptime(process.uptime())}`,
          footer: { text: 'Each PC running the bot will respond to this command' },
          color: 0x5865F2,
        }],
      });
      break;
    }

    case 'whoami': {
      await interaction.reply({
        embeds: [{
          title: `${config.instance.emoji} ${config.instance.name}`,
          fields: [
            { name: 'Instance ID', value: `\`${config.instance.id}\``, inline: true },
            { name: 'Working Directory', value: `\`${config.claude.workDir}\``, inline: false },
            { name: 'Claude CLI', value: `\`${config.claude.cliPath}\``, inline: true },
            { name: 'Uptime', value: formatUptime(process.uptime()), inline: true },
          ],
          color: 0x5865F2,
        }],
      });
      break;
    }

    case 'pc': {
      const target = interaction.options.getString('target').toLowerCase();
      const message = interaction.options.getString('message');

      // Check if this instance is the target
      const isTarget = config.instance.id.toLowerCase().includes(target) ||
                       config.instance.name.toLowerCase().includes(target);

      if (isTarget) {
        // This instance should handle the command
        await interaction.reply(`${prefix} 🎯 Received command from PC targeting.`);
        // Re-route as a message to Claude
        const session = sessionManager.getSession(channelId, channel.name);
        await interaction.channel.sendTyping();
        try {
          const response = await session.send(message);
          const chunks = splitMessage(response);
          for (const chunk of chunks) {
            await interaction.channel.send(`${prefix} ${chunk}`);
          }
        } catch (err) {
          await interaction.channel.send(`${prefix} ❌ Error: ${err.message}`);
        }
      } else {
        // Not for this instance - don't respond
        // In a multi-bot setup, the target bot would respond
        await interaction.reply({
          content: `${prefix} ℹ️ Command is for \`${target}\`, not me (\`${config.instance.name}\`)`,
          ephemeral: true
        });
      }
      break;
    }

    case 'deploy': {
      await interaction.deferReply();
      const scriptPath = interaction.options.getString('script') || './deploy.sh';
      const background = interaction.options.getBoolean('background') || false;
      const session = sessionManager.getSession(channelId, channel.name);
      const fullPath = scriptPath.startsWith('/') ? scriptPath : join(session.workingDir, scriptPath);

      if (!existsSync(fullPath)) {
        await interaction.editReply(`${prefix} ❌ Deploy script not found: ${scriptPath}`);
        return;
      }

      if (background) {
        const task = await taskQueue.addTask({
          type: 'shell',
          command: `bash ${fullPath}`,
          workingDir: session.workingDir,
          channelId,
          userId: interaction.user.id,
          description: `Deploy: ${basename(fullPath)}`,
        });
        await interaction.editReply(`${prefix} 🚀 Deployment started as task \`${task.id}\``);
      } else {
        const proc = spawn('bash', [fullPath], {
          cwd: session.workingDir,
          timeout: 300000, // 5 min for deploy
        });

        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.stderr.on('data', d => output += d.toString());

        proc.on('close', async (code) => {
          const result = output.trim() || '(No output)';
          const truncated = result.length > 1800 ? '...' + result.slice(-1800) : result;
          const status = code === 0 ? '✅ Success' : '❌ Failed';
          await interaction.editReply(`${prefix} 🚀 **Deployment ${status}**\n\`\`\`\n${truncated}\n\`\`\``);
        });

        proc.on('error', async (err) => {
          await interaction.editReply(`${prefix} ❌ Error: ${err.message}`);
        });
      }
      break;
    }

    case 'git': {
      const subcommand = interaction.options.getSubcommand();
      const session = sessionManager.getSession(channelId, channel.name);
      await interaction.deferReply();

      let cmd;
      switch (subcommand) {
        case 'status':
          cmd = 'git status';
          break;
        case 'pull':
          cmd = 'git pull';
          break;
        case 'log':
          const count = interaction.options.getInteger('count') || 5;
          cmd = `git log --oneline -n ${count}`;
          break;
      }

      const proc = spawn('bash', ['-c', cmd], {
        cwd: session.workingDir,
        timeout: 30000,
      });

      let output = '';
      proc.stdout.on('data', d => output += d.toString());
      proc.stderr.on('data', d => output += d.toString());

      proc.on('close', async (code) => {
        const result = output.trim() || '(No output)';
        const truncated = result.length > 1800 ? result.slice(0, 1800) + '\n...' : result;
        await interaction.editReply(`${prefix}\n\`\`\`\n$ ${cmd}\n\n${truncated}\`\`\``);
      });

      proc.on('error', async (err) => {
        await interaction.editReply(`${prefix} ❌ Error: ${err.message}`);
      });
      break;
    }
  }

  return null;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function getStatusEmoji(status) {
  switch (status) {
    case TaskStatus.PENDING: return '⏳';
    case TaskStatus.RUNNING: return '🔄';
    case TaskStatus.COMPLETED: return '✅';
    case TaskStatus.FAILED: return '❌';
    case TaskStatus.CANCELLED: return '🚫';
    default: return '❓';
  }
}

function splitMessage(content, maxLength = 1900) {
  if (content.length <= maxLength) return [content];

  const chunks = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLength;
    const newlinePos = remaining.lastIndexOf('\n', maxLength);
    if (newlinePos > maxLength - 200) {
      splitAt = newlinePos + 1;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}
