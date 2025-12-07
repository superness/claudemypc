import { Client, GatewayIntentBits, REST, Routes, ActivityType } from 'discord.js';
import { config, validateConfig, getInstancePrefix } from './config.js';
import { SessionManager } from './sessionManager.js';
import { commands, handleCommand } from './commands.js';
import { handleMessage, setupTaskNotifications } from './messageHandler.js';
import { TaskQueue } from './taskQueue.js';
import { DiscordIpcHandler } from './discordIpc.js';
import { Logger } from './logger.js';
import { spawn } from 'child_process';
import { mkdirSync, existsSync } from 'fs';

// Ensure required directories exist
[config.paths.logs, config.paths.history, config.paths.tasks].forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

// Initialize logger
const logger = new Logger('bot');

// Validate configuration
try {
  validateConfig();
} catch (err) {
  console.error('Configuration error:', err.message);
  console.error('Please copy .env.example to .env and fill in the required values.');
  process.exit(1);
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// Create session manager, task queue, and IPC handler
const sessionManager = new SessionManager();
const taskQueue = new TaskQueue();
let ipcHandler = null;

// Register slash commands
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    console.log('Registering slash commands...');

    const commandData = commands.map(cmd => cmd.toJSON());

    if (config.discord.guildId) {
      // Register to specific guild (instant)
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, config.discord.guildId),
        { body: commandData }
      );
      console.log(`Registered ${commands.length} commands to guild ${config.discord.guildId}`);
    } else {
      // Register globally (takes up to an hour)
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commandData }
      );
      console.log(`Registered ${commands.length} commands globally`);
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// Handle ready event
client.once('ready', async () => {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Instance: ${config.instance.name} (${config.instance.id})`);

  // Set activity with instance identifier
  const activityText = `${config.instance.emoji} ${config.instance.name}`;
  client.user.setActivity(activityText, { type: ActivityType.Watching });

  // Set nickname to include instance name (if in a guild)
  for (const guild of client.guilds.cache.values()) {
    try {
      const me = guild.members.cache.get(client.user.id);
      if (me && me.manageable) {
        await me.setNickname(`Claude ${getInstancePrefix()}`);
      }
    } catch (err) {
      logger.warn(`Could not set nickname in ${guild.name}: ${err.message}`);
    }
  }

  // Register slash commands
  await registerCommands();

  // Set up task completion notifications
  setupTaskNotifications(taskQueue, client);

  // Start Discord IPC handler for MCP server communication
  ipcHandler = new DiscordIpcHandler(client, sessionManager);
  ipcHandler.start();

  logger.info('Bot is ready!');
  logger.info(`Working directory: ${config.claude.workDir}`);
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const result = await handleCommand(interaction, sessionManager, taskQueue, client);

    // Handle special actions
    if (result?.action === 'update') {
      await performUpdate();
    } else if (result?.action === 'restart') {
      await performRestart();
    }
  } catch (err) {
    logger.error('Command error:', err);
    const reply = interaction.deferred
      ? interaction.editReply.bind(interaction)
      : interaction.reply.bind(interaction);
    await reply({ content: `${getInstancePrefix()} ❌ Error: ${err.message}`, ephemeral: true });
  }
});

// Handle messages
client.on('messageCreate', async (message) => {
  try {
    await handleMessage(message, sessionManager, taskQueue, client);
  } catch (err) {
    logger.error('Message handling error:', err);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  if (ipcHandler) ipcHandler.stop();
  sessionManager.killAll();
  taskQueue.cancelAll();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  if (ipcHandler) ipcHandler.stop();
  sessionManager.killAll();
  taskQueue.cancelAll();
  client.destroy();
  process.exit(0);
});

// Self-update function
async function performUpdate() {
  logger.info('Performing self-update...');

  return new Promise((resolve, reject) => {
    const gitPull = spawn('git', ['pull'], { cwd: config.paths.root });

    gitPull.on('close', (code) => {
      if (code === 0) {
        logger.info('Git pull successful, installing dependencies...');

        const npmInstall = spawn('npm', ['install'], { cwd: config.paths.root });

        npmInstall.on('close', (installCode) => {
          if (installCode === 0) {
            logger.info('Dependencies installed, restarting...');
            performRestart();
            resolve();
          } else {
            reject(new Error('npm install failed'));
          }
        });
      } else {
        reject(new Error('git pull failed'));
      }
    });
  });
}

// Restart function
async function performRestart() {
  logger.info('Restarting...');
  sessionManager.killAll();
  taskQueue.cancelAll();

  // Spawn new process
  const child = spawn(process.argv[0], process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: 'inherit',
  });

  child.unref();

  // Exit current process
  process.exit(0);
}

// Start the bot
logger.info(`Starting Discord bot (${config.instance.name})...`);
client.login(config.discord.token);
