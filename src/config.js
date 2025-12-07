import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hostname } from 'os';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Generate a unique instance identifier based on hostname or config override
const instanceId = process.env.INSTANCE_ID || hostname();

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    ownerId: process.env.OWNER_ID,
    guildId: process.env.GUILD_ID,
  },
  claude: {
    cliPath: process.env.CLAUDE_CLI_PATH || 'claude',
    workDir: process.env.WORK_DIR || process.env.HOME || '/home',
  },
  paths: {
    root: join(__dirname, '..'),
    sessions: join(__dirname, '..', 'sessions'),
    logs: join(__dirname, '..', 'logs'),
    history: join(__dirname, '..', 'history'),
    tasks: join(__dirname, '..', 'tasks'),
  },
  // Multi-PC instance configuration
  instance: {
    id: instanceId,
    name: process.env.INSTANCE_NAME || instanceId,
    emoji: process.env.INSTANCE_EMOJI || '🖥️',
    // Claim emoji - used to indicate this instance is handling a message
    // Each instance should have a unique claim emoji to identify who's working on it
    claimEmoji: process.env.CLAIM_EMOJI || '⚡',
  },
  // Multi-instance coordination
  multiInstance: {
    // Whether to coordinate with other instances (disable to always respond)
    enabled: process.env.MULTI_INSTANCE !== 'false',
    // Random delay range (ms) before claiming - helps distribute load
    claimDelayMin: parseInt(process.env.CLAIM_DELAY_MIN || '100', 10),
    claimDelayMax: parseInt(process.env.CLAIM_DELAY_MAX || '500', 10),
  },
  // Channel name to project directory mapping
  // Can be extended via bot commands
  projectMappings: {},
  // Task queue settings
  taskQueue: {
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_TASKS || '3', 10),
    timeoutMs: parseInt(process.env.TASK_TIMEOUT_MS || '600000', 10), // 10 minutes default
  },
};

export function validateConfig() {
  if (!config.discord.token) {
    throw new Error('DISCORD_TOKEN is required in .env file');
  }
  return true;
}

export function getInstancePrefix() {
  return `[${config.instance.emoji} ${config.instance.name}]`;
}
