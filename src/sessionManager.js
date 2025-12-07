import { ClaudeSession } from './claudeSession.js';
import { config } from './config.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Manages Claude sessions across multiple Discord channels
 */
export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.channelMappings = new Map(); // channelId -> workingDir
    this.loadMappings();
  }

  /**
   * Get or create a session for a channel
   */
  getSession(channelId, channelName = null) {
    if (!this.sessions.has(channelId)) {
      const workDir = this.getWorkingDir(channelId, channelName);
      const session = new ClaudeSession(channelId, workDir);
      this.sessions.set(channelId, session);
    }
    return this.sessions.get(channelId);
  }

  /**
   * Determine working directory for a channel
   */
  getWorkingDir(channelId, channelName) {
    // Check if we have a stored mapping
    if (this.channelMappings.has(channelId)) {
      return this.channelMappings.get(channelId);
    }

    // Try to match channel name to a project directory
    if (channelName) {
      const projectDir = join(config.claude.workDir, channelName);
      if (existsSync(projectDir)) {
        this.setChannelMapping(channelId, projectDir);
        return projectDir;
      }
    }

    // Default to base work directory
    return config.claude.workDir;
  }

  /**
   * Set working directory mapping for a channel
   */
  setChannelMapping(channelId, workDir) {
    this.channelMappings.set(channelId, workDir);

    // Update existing session if any
    if (this.sessions.has(channelId)) {
      this.sessions.get(channelId).setWorkingDir(workDir);
    }

    this.saveMappings();
  }

  /**
   * Remove a session
   */
  removeSession(channelId) {
    if (this.sessions.has(channelId)) {
      const session = this.sessions.get(channelId);
      session.kill();
      this.sessions.delete(channelId);
      return true;
    }
    return false;
  }

  /**
   * Kill all active sessions
   */
  killAll() {
    for (const [channelId, session] of this.sessions) {
      session.kill();
    }
    this.sessions.clear();
  }

  /**
   * Get status of all sessions
   */
  getStatus() {
    const status = [];
    for (const [channelId, session] of this.sessions) {
      status.push({
        channelId,
        workingDir: session.workingDir,
        isActive: session.isActive(),
        isProcessing: session.isProcessing,
        queueLength: session.messageQueue.length,
      });
    }
    return status;
  }

  /**
   * Load channel mappings from disk
   */
  loadMappings() {
    const mappingFile = join(config.paths.root, 'channel-mappings.json');
    if (existsSync(mappingFile)) {
      try {
        const data = JSON.parse(readFileSync(mappingFile, 'utf-8'));
        for (const [channelId, workDir] of Object.entries(data)) {
          this.channelMappings.set(channelId, workDir);
        }
      } catch (err) {
        console.error('Failed to load channel mappings:', err);
      }
    }
  }

  /**
   * Save channel mappings to disk
   */
  saveMappings() {
    const mappingFile = join(config.paths.root, 'channel-mappings.json');
    const data = Object.fromEntries(this.channelMappings);
    try {
      writeFileSync(mappingFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Failed to save channel mappings:', err);
    }
  }
}
