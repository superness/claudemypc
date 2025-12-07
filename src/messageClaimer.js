import { config } from './config.js';
import { Logger } from './logger.js';

const logger = new Logger('messageClaimer');

// Track claimed messages locally to avoid race conditions
const claimedMessages = new Map();

// Cleanup old claims periodically (keep last 5 minutes)
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [msgId, timestamp] of claimedMessages.entries()) {
    if (timestamp < cutoff) {
      claimedMessages.delete(msgId);
    }
  }
}, 60 * 1000);

/**
 * Get the category name for a channel
 */
function getChannelCategory(channel) {
  if (channel.parent) {
    return channel.parent.name.toLowerCase();
  }
  return null;
}

/**
 * Check if this instance owns the category
 * 
 * Category naming convention:
 * - "BLD" or "Desktop" category → instance with id "bld" or "desktop"
 * - "Laptop" category → instance with id "laptop"
 * - Any other category → shared (any instance can respond)
 */
function doesInstanceOwnCategory(categoryName) {
  if (!categoryName) return null; // No category = shared
  
  const myId = config.instance.id.toLowerCase();
  const myName = config.instance.name.toLowerCase();
  const category = categoryName.toLowerCase();
  
  // Direct match: category name matches instance id or name
  if (category === myId || category === myName) {
    return true;
  }
  
  // Check for category containing instance identifier
  // e.g., "BLD Projects" or "Laptop Work"
  if (category.includes(myId) || category.includes(myName)) {
    return true;
  }
  
  // Check common aliases
  const instanceAliases = {
    'bld': ['bld', 'desktop', 'home-desktop', 'main-pc'],
    'laptop': ['laptop', 'portable', 'macbook', 'notebook'],
    'server': ['server', 'homelab', 'nas'],
  };
  
  const myAliases = instanceAliases[myId] || [myId, myName];
  
  for (const alias of myAliases) {
    if (category === alias || category.includes(alias)) {
      return true;
    }
  }
  
  // Check if category explicitly belongs to ANOTHER instance
  for (const [instanceId, aliases] of Object.entries(instanceAliases)) {
    if (instanceId === myId) continue;
    
    for (const alias of aliases) {
      if (category === alias || category.includes(alias)) {
        // Category belongs to another instance
        return false;
      }
    }
  }
  
  // Category doesn't match any instance - it's shared
  return null;
}

/**
 * Check if message explicitly mentions wanting a specific machine
 * e.g., "on the laptop", "from my desktop", "on BLD"
 */
function getMachineFromContent(content) {
  const lower = content.toLowerCase();
  
  // Note: "server" removed - too generic and conflicts with channel names like "minecraft-server"
  const patterns = [
    /\bon\s+(my\s+)?(laptop|desktop|bld|pc)\b/i,
    /\bfrom\s+(my\s+)?(laptop|desktop|bld|pc)\b/i,
    /\b(laptop|desktop|bld)[\s:,]/i,
    /^@?(laptop|desktop|bld)\b/i,
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      // Get the machine name (last capture group)
      const machine = match[match.length - 1].toLowerCase();
      return machine;
    }
  }
  
  return null;
}

/**
 * Check if the mentioned machine is this instance
 */
function isMachineThisInstance(machineName) {
  if (!machineName) return null;
  
  const myId = config.instance.id.toLowerCase();
  const myName = config.instance.name.toLowerCase();
  const machine = machineName.toLowerCase();
  
  // Direct match
  if (machine === myId || machine === myName) {
    return true;
  }
  
  // Aliases
  const instanceAliases = {
    'bld': ['bld', 'desktop', 'home-desktop', 'main-pc', 'pc'],
    'laptop': ['laptop', 'portable', 'macbook', 'notebook'],
    'server': ['server', 'homelab', 'nas'],
  };
  
  const myAliases = instanceAliases[myId] || [myId, myName];
  
  if (myAliases.includes(machine)) {
    return true;
  }
  
  // Check if it matches another instance
  for (const [instanceId, aliases] of Object.entries(instanceAliases)) {
    if (instanceId === myId) continue;
    if (aliases.includes(machine)) {
      return false;
    }
  }
  
  return null; // Unknown machine name
}

/**
 * Main claim logic - category-based routing
 */
export async function claimMessage(message) {
  const myId = config.instance.id;
  const msgId = message.id;
  
  // Already processed locally? Skip
  if (claimedMessages.has(msgId)) {
    return false;
  }
  
  // 1. Check message content for explicit machine targeting
  const targetMachine = getMachineFromContent(message.content);
  if (targetMachine) {
    const isMe = isMachineThisInstance(targetMachine);
    
    if (isMe === true) {
      claimedMessages.set(msgId, Date.now());
      logger.info(`Claimed ${msgId}: message explicitly targets ${targetMachine} (this instance)`);
      await markClaimed(message);
      return true;
    }
    
    if (isMe === false) {
      logger.info(`Skipping ${msgId}: message targets ${targetMachine} (different instance)`);
      return false;
    }
  }
  
  // 2. Check channel category ownership
  const categoryName = getChannelCategory(message.channel);
  const ownsCategory = doesInstanceOwnCategory(categoryName);
  
  if (ownsCategory === true) {
    claimedMessages.set(msgId, Date.now());
    logger.info(`Claimed ${msgId}: this instance owns category "${categoryName}"`);
    await markClaimed(message);
    return true;
  }
  
  if (ownsCategory === false) {
    logger.info(`Skipping ${msgId}: another instance owns category "${categoryName}"`);
    return false;
  }
  
  // 3. Shared category or no category - use primary/fallback
  if (isPrimaryInstance()) {
    claimedMessages.set(msgId, Date.now());
    logger.info(`Claimed ${msgId}: shared category, primary instance`);
    await markClaimed(message);
    return true;
  }
  
  // 4. Not primary - use reaction-based claiming as last resort
  return await tryClaimWithReaction(message);
}

/**
 * Check if this is the primary (default) instance
 */
function isPrimaryInstance() {
  return process.env.INSTANCE_PRIMARY === 'true';
}

/**
 * Fallback: reaction-based claiming for shared categories when primary is offline
 */
async function tryClaimWithReaction(message) {
  const msgId = message.id;
  
  try {
    // Wait a bit to let primary instance claim first
    await sleep(800);
    
    // Check if someone else already responded
    if (await isMessageBeingHandled(message)) {
      logger.debug(`Message ${msgId} already being handled`);
      return false;
    }
    
    // Add claim reaction
    await message.react('🔒');
    claimedMessages.set(msgId, Date.now());
    
    // Wait for other instances
    await sleep(500);
    
    // Check if we're still the only claimant
    const freshMessage = await message.fetch(true);
    const reaction = freshMessage.reactions.cache.get('🔒');
    
    if (!reaction) {
      return false;
    }
    
    const users = await reaction.users.fetch();
    const botUsers = users.filter(u => u.bot);
    
    if (botUsers.size === 1) {
      logger.info(`Claimed ${msgId}: reaction fallback (only claimant)`);
      return true;
    }
    
    if (botUsers.size > 1) {
      // Multiple claimants - alphabetical tiebreaker
      const myClientId = message.client.user.id;
      const sortedBotIds = Array.from(botUsers.keys()).sort();
      
      if (sortedBotIds[0] === myClientId) {
        logger.info(`Claimed ${msgId}: won tiebreaker`);
        return true;
      } else {
        try {
          await reaction.users.remove(message.client.user.id);
        } catch (e) {}
        logger.debug(`Lost claim for ${msgId}`);
        return false;
      }
    }
    
    return true;
  } catch (err) {
    logger.error(`Error in reaction claim for ${msgId}:`, err.message);
    return false;
  }
}

/**
 * Add a visual indicator that we're claiming this message
 */
async function markClaimed(message) {
  try {
    await message.react(config.instance.emoji);
  } catch (err) {
    // Ignore reaction errors
  }
}

/**
 * Check if any bot has started responding to this message
 */
async function isMessageBeingHandled(message) {
  try {
    const recentMessages = await message.channel.messages.fetch({
      after: message.id,
      limit: 5
    });

    for (const msg of recentMessages.values()) {
      if (msg.author.bot && msg.reference?.messageId === message.id) {
        return true;
      }
      
      if (msg.author.bot && msg.content.match(/^\[[\p{Emoji}\s\w]+\]/u)) {
        const timeDiff = msg.createdTimestamp - message.createdTimestamp;
        if (timeDiff < 5000 && timeDiff > 0) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Release claim on a message
 */
export async function releaseClaim(message) {
  try {
    const lockReaction = message.reactions.cache.get('🔒');
    if (lockReaction) {
      await lockReaction.users.remove(message.client.user.id);
    }
    claimedMessages.delete(message.id);
  } catch (err) {
    // Ignore cleanup errors
  }
}

// Utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
