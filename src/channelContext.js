/**
 * Channel Context Manager
 * Maintains persistent knowledge/context per channel and thread
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { Logger } from './logger.js';

const logger = new Logger('channelContext');

// Context storage directory
const CONTEXT_DIR = join(config.paths.root, 'context');

/**
 * Ensure context directory exists
 */
function ensureContextDir() {
  if (!existsSync(CONTEXT_DIR)) {
    mkdirSync(CONTEXT_DIR, { recursive: true });
  }
}

/**
 * Get path to context file for a channel/thread
 */
function getContextPath(channelId) {
  ensureContextDir();
  return join(CONTEXT_DIR, `${channelId}.json`);
}

/**
 * Channel context structure
 */
const DEFAULT_CONTEXT = {
  channelId: '',
  channelName: '',
  workingDir: '',
  createdAt: null,
  updatedAt: null,

  // Project info discovered/set
  project: {
    name: '',
    description: '',
    type: '', // e.g., 'nodejs', 'python', 'rust', etc.
    mainFiles: [], // Key files to know about
  },

  // Accumulated knowledge
  knowledge: {
    // Key decisions made
    decisions: [],
    // Important findings
    findings: [],
    // Known issues/bugs being tracked
    issues: [],
    // Completed tasks
    completedTasks: [],
    // Current focus/active task
    currentTask: '',
  },

  // Quick notes - freeform context
  notes: '',

  // Recent activity summary (auto-updated)
  recentSummary: '',
};

/**
 * Load context for a channel
 */
export function loadContext(channelId) {
  const contextPath = getContextPath(channelId);

  if (existsSync(contextPath)) {
    try {
      const data = JSON.parse(readFileSync(contextPath, 'utf-8'));
      return { ...DEFAULT_CONTEXT, ...data };
    } catch (err) {
      logger.error(`Failed to load context for ${channelId}:`, err);
    }
  }

  return { ...DEFAULT_CONTEXT, channelId, createdAt: new Date().toISOString() };
}

/**
 * Save context for a channel
 */
export function saveContext(channelId, context) {
  const contextPath = getContextPath(channelId);

  try {
    context.updatedAt = new Date().toISOString();
    writeFileSync(contextPath, JSON.stringify(context, null, 2));
    logger.info(`Saved context for channel ${channelId}`);
    return true;
  } catch (err) {
    logger.error(`Failed to save context for ${channelId}:`, err);
    return false;
  }
}

/**
 * Update specific fields in context
 */
export function updateContext(channelId, updates) {
  const context = loadContext(channelId);

  // Deep merge updates
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === 'object' && !Array.isArray(value) && context[key]) {
      context[key] = { ...context[key], ...value };
    } else {
      context[key] = value;
    }
  }

  return saveContext(channelId, context);
}

/**
 * Add a decision to the context
 */
export function addDecision(channelId, decision) {
  const context = loadContext(channelId);
  context.knowledge.decisions.push({
    decision,
    timestamp: new Date().toISOString(),
  });
  // Keep last 20 decisions
  if (context.knowledge.decisions.length > 20) {
    context.knowledge.decisions = context.knowledge.decisions.slice(-20);
  }
  return saveContext(channelId, context);
}

/**
 * Add a finding to the context
 */
export function addFinding(channelId, finding) {
  const context = loadContext(channelId);
  context.knowledge.findings.push({
    finding,
    timestamp: new Date().toISOString(),
  });
  // Keep last 30 findings
  if (context.knowledge.findings.length > 30) {
    context.knowledge.findings = context.knowledge.findings.slice(-30);
  }
  return saveContext(channelId, context);
}

/**
 * Set current task
 */
export function setCurrentTask(channelId, task) {
  const context = loadContext(channelId);

  // Archive previous task if exists
  if (context.knowledge.currentTask) {
    context.knowledge.completedTasks.push({
      task: context.knowledge.currentTask,
      completedAt: new Date().toISOString(),
    });
    // Keep last 20 completed tasks
    if (context.knowledge.completedTasks.length > 20) {
      context.knowledge.completedTasks = context.knowledge.completedTasks.slice(-20);
    }
  }

  context.knowledge.currentTask = task;
  return saveContext(channelId, context);
}

/**
 * Update notes
 */
export function updateNotes(channelId, notes) {
  const context = loadContext(channelId);
  context.notes = notes;
  return saveContext(channelId, context);
}

/**
 * Update recent summary
 */
export function updateRecentSummary(channelId, summary) {
  const context = loadContext(channelId);
  context.recentSummary = summary;
  return saveContext(channelId, context);
}

/**
 * Format context for inclusion in prompt
 */
export function formatContextForPrompt(channelId) {
  const context = loadContext(channelId);

  const parts = [];

  parts.push(`=== CHANNEL CONTEXT ===`);

  if (context.project.name) {
    parts.push(`\nPROJECT: ${context.project.name}`);
    if (context.project.description) {
      parts.push(`Description: ${context.project.description}`);
    }
    if (context.project.type) {
      parts.push(`Type: ${context.project.type}`);
    }
    if (context.project.mainFiles.length > 0) {
      parts.push(`Key files: ${context.project.mainFiles.join(', ')}`);
    }
  }

  if (context.knowledge.currentTask) {
    parts.push(`\nCURRENT TASK: ${context.knowledge.currentTask}`);
  }

  if (context.knowledge.decisions.length > 0) {
    parts.push(`\nRECENT DECISIONS:`);
    for (const d of context.knowledge.decisions.slice(-5)) {
      parts.push(`- ${d.decision}`);
    }
  }

  if (context.knowledge.findings.length > 0) {
    parts.push(`\nKEY FINDINGS:`);
    for (const f of context.knowledge.findings.slice(-5)) {
      parts.push(`- ${f.finding}`);
    }
  }

  if (context.knowledge.issues.length > 0) {
    parts.push(`\nKNOWN ISSUES:`);
    for (const i of context.knowledge.issues.slice(-5)) {
      parts.push(`- ${i}`);
    }
  }

  if (context.notes) {
    parts.push(`\nNOTES:\n${context.notes}`);
  }

  if (context.recentSummary) {
    parts.push(`\nRECENT ACTIVITY:\n${context.recentSummary}`);
  }

  parts.push(`\n=== END CONTEXT ===`);

  // Only return if there's meaningful content
  if (parts.length <= 2) {
    return ''; // Just header/footer, no actual content
  }

  return parts.join('\n');
}

/**
 * Initialize context for a new channel
 */
export function initializeContext(channelId, channelName, workingDir) {
  const context = loadContext(channelId);
  context.channelName = channelName;
  context.workingDir = workingDir;
  context.createdAt = context.createdAt || new Date().toISOString();
  return saveContext(channelId, context);
}
