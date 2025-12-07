import { config, getInstancePrefix } from './config.js';
import { AttachmentBuilder } from 'discord.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { Logger } from './logger.js';
import { claimMessage, releaseClaim } from './messageClaimer.js';
import https from 'https';
import http from 'http';

const logger = new Logger('messageHandler');

// Discord message character limit
const MAX_MESSAGE_LENGTH = 2000;

// How many previous messages to fetch for context
const CONTEXT_MESSAGE_COUNT = 20;

/**
 * Fetch recent messages from channel/thread for context
 */
async function getConversationContext(channel, currentMessageId, botId) {
  try {
    // Fetch recent messages before the current one
    const messages = await channel.messages.fetch({
      limit: CONTEXT_MESSAGE_COUNT + 1,
      before: currentMessageId
    });

    // Convert to array and reverse to chronological order
    const msgArray = Array.from(messages.values()).reverse();

    // Format as conversation
    const conversation = msgArray.map(msg => {
      const role = msg.author.bot ? 'Assistant' : 'User';
      const content = msg.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      if (!content) return null;
      return `${role}: ${content}`;
    }).filter(Boolean);

    if (conversation.length === 0) {
      return '';
    }

    return '--- Previous conversation ---\n' + conversation.join('\n\n') + '\n--- End of previous conversation ---\n\n';
  } catch (err) {
    logger.error('Failed to fetch conversation context:', err);
    return '';
  }
}

// Language detection for code blocks
const LANGUAGE_HINTS = {
  'function': 'javascript',
  'const ': 'javascript',
  'let ': 'javascript',
  'import ': 'javascript',
  'export ': 'javascript',
  'class ': 'javascript',
  '=>': 'javascript',
  'def ': 'python',
  'import ': 'python',
  'from ': 'python',
  'print(': 'python',
  'async def': 'python',
  'fn ': 'rust',
  'let mut': 'rust',
  'impl ': 'rust',
  'pub fn': 'rust',
  'func ': 'go',
  'package ': 'go',
  'fmt.': 'go',
  '<?php': 'php',
  'public static void': 'java',
  'System.out': 'java',
  '#include': 'cpp',
  'std::': 'cpp',
  'using namespace': 'cpp',
  '#!/bin/bash': 'bash',
  '#!/bin/sh': 'bash',
  'echo ': 'bash',
  'SELECT ': 'sql',
  'INSERT ': 'sql',
  'UPDATE ': 'sql',
  'CREATE TABLE': 'sql',
};

/**
 * Detect programming language from code content
 */
function detectLanguage(content) {
  for (const [hint, lang] of Object.entries(LANGUAGE_HINTS)) {
    if (content.includes(hint)) {
      return lang;
    }
  }
  return '';
}

/**
 * Split a long message into multiple chunks
 */
function splitMessage(content, maxLength = MAX_MESSAGE_LENGTH - 100) {
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLength;

    // Look for newline within last 200 chars
    const newlinePos = remaining.lastIndexOf('\n', maxLength);
    if (newlinePos > maxLength - 200) {
      splitAt = newlinePos + 1;
    } else {
      // Look for space
      const spacePos = remaining.lastIndexOf(' ', maxLength);
      if (spacePos > maxLength - 100) {
        splitAt = spacePos + 1;
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

/**
 * Format response for Discord (handle code blocks, length limits, etc.)
 */
function formatResponse(response, prefix = '') {
  // Strip any existing prefix from Claude's response (it may echo it from context)
  // Match patterns like "[🖥️ BLD]" or "[💻 Laptop]" at the start
  let cleanResponse = response.replace(/^\[[\p{Emoji}\s\w]+\]\s*/u, '').trim();
  
  // Also strip if it appears after a newline at the very start
  cleanResponse = cleanResponse.replace(/^\n*\[[\p{Emoji}\s\w]+\]\s*/u, '').trim();

  // Check if response already has code blocks
  const hasCodeBlocks = cleanResponse.includes('```');

  // If response is long and looks like code, wrap it
  if (!hasCodeBlocks && cleanResponse.length > 500) {
    const looksLikeCode = cleanResponse.includes('\n') && (
      cleanResponse.includes('function') ||
      cleanResponse.includes('const ') ||
      cleanResponse.includes('import ') ||
      cleanResponse.includes('export ') ||
      cleanResponse.includes('class ') ||
      cleanResponse.includes('  ') ||
      cleanResponse.includes('->') ||
      cleanResponse.includes('=>') ||
      cleanResponse.includes('def ') ||
      cleanResponse.includes('fn ') ||
      cleanResponse.includes('pub ')
    );

    if (looksLikeCode) {
      const lang = detectLanguage(cleanResponse);
      cleanResponse = '```' + lang + '\n' + cleanResponse + '\n```';
    }
  }

  // Add prefix to first chunk
  const prefixedResponse = prefix ? `${prefix}\n${cleanResponse}` : cleanResponse;
  return splitMessage(prefixedResponse);
}

/**
 * Download a file from a URL to a temporary location
 */
async function downloadAttachment(url, filename, workingDir) {
  return new Promise((resolve, reject) => {
    const tempDir = join(workingDir, '.discord-uploads');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const filePath = join(tempDir, filename);
    const protocol = url.startsWith('https') ? https : http;

    const file = require('fs').createWriteStream(filePath);
    protocol.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(filePath);
      });
    }).on('error', (err) => {
      require('fs').unlink(filePath, () => {});
      reject(err);
    });
  });
}

/**
 * Handle incoming messages
 */
export async function handleMessage(message, sessionManager, taskQueue, client) {
  // Ignore bot messages
  if (message.author.bot) return;

  const prefix = getInstancePrefix();

  const channelId = message.channel.id;
  const channelName = message.channel.name || '';

  // Get the content (remove bot mention if present)
  let cleanContent = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!cleanContent && message.attachments.size === 0) {
    return;
  }

  // === Multi-instance coordination ===
  // Try to claim this message before processing
  const claimed = await claimMessage(message);
  if (!claimed) {
    logger.info(`Message ${message.id} claimed by another instance, skipping`);
    return;
  }
  logger.info(`Claimed message ${message.id} for processing`);

  // Handle file uploads
  const session = sessionManager.getSession(channelId, message.channel.name);
  let attachmentContext = '';

  if (message.attachments.size > 0) {
    const attachments = Array.from(message.attachments.values());
    const uploadedFiles = [];

    for (const attachment of attachments) {
      try {
        const tempDir = join(session.workingDir, '.discord-uploads');
        if (!existsSync(tempDir)) {
          mkdirSync(tempDir, { recursive: true });
        }

        // For text files, we can include content directly
        const ext = extname(attachment.name).toLowerCase();
        const textExtensions = ['.txt', '.md', '.js', '.ts', '.py', '.json', '.yaml', '.yml', '.sh', '.css', '.html', '.xml', '.sql', '.rs', '.go', '.java', '.c', '.cpp', '.h'];

        if (textExtensions.includes(ext) && attachment.size < 50000) {
          // Small text file - include content in context
          uploadedFiles.push(`File: ${attachment.name} (uploaded, content available at .discord-uploads/${attachment.name})`);
        } else {
          uploadedFiles.push(`File: ${attachment.name} (${(attachment.size / 1024).toFixed(1)}KB, available at .discord-uploads/${attachment.name})`);
        }

        // Note: Actual download would require additional setup
        // For now, just note the attachment info
      } catch (err) {
        logger.error(`Failed to process attachment ${attachment.name}:`, err);
      }
    }

    if (uploadedFiles.length > 0) {
      attachmentContext = '\n[Attached files: ' + uploadedFiles.join(', ') + ']';
    }
  }

  // Special commands that don't go to Claude
  const lowerContent = cleanContent.toLowerCase();

  if (lowerContent === 'ping') {
    await message.reply(`${prefix} Pong! 🏓`);
    return;
  }

  if (lowerContent === 'stop' || lowerContent === 'cancel') {
    if (session.kill()) {
      await message.reply(`${prefix} ⏹️ Session stopped.`);
    } else {
      await message.reply(`${prefix} ℹ️ No active session to stop.`);
    }
    return;
  }

  if (lowerContent === 'whoami' || lowerContent === 'which pc') {
    await message.reply(`${prefix} I am **${config.instance.name}** (\`${config.instance.id}\`)`);
    return;
  }

  // Check if this is a thread
  const isThread = message.channel.isThread?.() || false;
  if (isThread) {
    session.setThreadId(message.channel.id);
  }

  // Show typing indicator
  await message.channel.sendTyping();

  // Keep typing indicator alive for long responses
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 5000);

  // Track progress messages
  let lastProgressUpdate = Date.now();
  let progressMessage = null;
  let statusLog = [];  // Array of status updates to show history
  let streamingText = '';  // Accumulate streaming text

  try {
    // Get conversation context from channel history
    const conversationContext = await getConversationContext(message.channel, message.id, client.user.id);

    // Combine context + current message + attachments
    const fullMessage = conversationContext + 'User: ' + cleanContent + attachmentContext;

    logger.info(`Message from ${message.author.tag} in ${channelName}: ${cleanContent}`);

    // Set up progress handler to show what Claude is doing
    const onProgress = async (chunk) => {
      const progressText = chunk.trim();
      if (!progressText) return;

      // Check if this is a status message or actual text
      const isStatus = progressText.startsWith('Using tool:') ||
                       progressText === 'Thinking...' ||
                       progressText === 'Running tool...';

      if (isStatus) {
        // Status messages - append to log
        streamingText = '';  // Reset streaming text on status change
        
        // Add to status log (keep last 8 entries to avoid message limit)
        statusLog.push(progressText);
        if (statusLog.length > 8) {
          statusLog.shift();
        }
        
        // Format the status log with timestamps relative to start
        const logDisplay = statusLog.map((s, i) => {
          const icon = i === statusLog.length - 1 ? '⏳' : '✓';
          return `${icon} ${s}`;
        }).join('\n');
        
        try {
          if (progressMessage) {
            await progressMessage.edit(`${prefix}\n${logDisplay}`);
          } else {
            progressMessage = await message.channel.send(`${prefix}\n${logDisplay}`);
          }
        } catch (e) {
          logger.error('Failed to update progress:', e.message);
        }
      } else {
        // Streaming text - accumulate and show periodically
        streamingText += progressText;

        // Only update every 1.5 seconds to avoid rate limits
        if (Date.now() - lastProgressUpdate < 1500) return;
        lastProgressUpdate = Date.now();

        // Show last 300 chars of accumulated text
        const displayText = streamingText.length > 300
          ? '...' + streamingText.slice(-300)
          : streamingText;

        // Format with status log + current streaming text
        const logDisplay = statusLog.map((s, i) => {
          const icon = i === statusLog.length - 1 ? '💬' : '✓';
          return `${icon} ${s}`;
        }).join('\n');
        
        const fullDisplay = logDisplay 
          ? `${prefix}\n${logDisplay}\n\n💬 ${displayText}`
          : `${prefix} 💬 ${displayText}`;

        try {
          if (progressMessage) {
            await progressMessage.edit(fullDisplay);
          } else {
            progressMessage = await message.channel.send(fullDisplay);
          }
        } catch (e) {
          logger.error('Failed to update progress:', e.message);
        }
      }
    };

    // Send to Claude with progress updates
    const response = await session.sendWithProgress(fullMessage, onProgress);

    // Delete progress message if it exists
    if (progressMessage) {
      try { await progressMessage.delete(); } catch (e) {}
    }

    logger.info(`Response from Claude: ${response}`);

    // Format and send response
    const chunks = formatResponse(response, prefix);

    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }

    logger.info(`Response sent to Discord (${response.length} chars)`);

  } catch (err) {
    logger.error('Error handling message:', err);
    // Delete progress message on error
    if (progressMessage) {
      try { await progressMessage.delete(); } catch (e) {}
    }
    await message.reply(`${prefix} ❌ Error: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
    // Release the claim (remove lock reaction)
    await releaseClaim(message);
  }
}

/**
 * Set up task completion notifications
 */
export function setupTaskNotifications(taskQueue, client) {
  const prefix = getInstancePrefix();

  taskQueue.on('taskCompleted', async (task) => {
    try {
      const channel = await client.channels.fetch(task.channelId);
      if (channel) {
        const output = task.output.length > 500
          ? '...' + task.output.slice(-500)
          : task.output;
        await channel.send(
          `${prefix} ✅ **Task Completed**: \`${task.id.slice(0, 8)}\`\n` +
          `**${task.description}**\n` +
          `\`\`\`\n${output || '(No output)'}\n\`\`\``
        );
      }
    } catch (err) {
      logger.error('Failed to send task completion notification:', err);
    }
  });

  taskQueue.on('taskFailed', async (task) => {
    try {
      const channel = await client.channels.fetch(task.channelId);
      if (channel) {
        const output = task.output.length > 500
          ? '...' + task.output.slice(-500)
          : task.output;
        await channel.send(
          `${prefix} ❌ **Task Failed**: \`${task.id.slice(0, 8)}\`\n` +
          `**${task.description}**\n` +
          `Error: ${task.error}\n` +
          `\`\`\`\n${output || '(No output)'}\n\`\`\``
        );
      }
    } catch (err) {
      logger.error('Failed to send task failure notification:', err);
    }
  });
}
