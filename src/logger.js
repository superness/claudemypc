import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

/**
 * Simple file and console logger with instance identification
 */
export class Logger {
  constructor(module = 'app') {
    this.module = module;
    this.logDir = config.paths.logs;

    // Ensure log directory exists
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Format a log message with timestamp, instance, and level
   */
  format(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const instanceId = config.instance.id;
    const formatted = args.length > 0
      ? `${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`
      : message;
    return `[${timestamp}] [${instanceId}] [${level.toUpperCase()}] [${this.module}] ${formatted}`;
  }

  /**
   * Write to log file
   */
  writeToFile(line) {
    const date = new Date().toISOString().split('T')[0];
    const logFile = join(this.logDir, `${date}.log`);
    appendFileSync(logFile, line + '\n');
  }

  /**
   * Log info message
   */
  info(message, ...args) {
    const line = this.format('info', message, ...args);
    console.log(line);
    this.writeToFile(line);
  }

  /**
   * Log warning message
   */
  warn(message, ...args) {
    const line = this.format('warn', message, ...args);
    console.warn(line);
    this.writeToFile(line);
  }

  /**
   * Log error message
   */
  error(message, ...args) {
    const line = this.format('error', message, ...args);
    console.error(line);
    this.writeToFile(line);
  }

  /**
   * Log debug message (only in non-production)
   */
  debug(message, ...args) {
    if (process.env.NODE_ENV !== 'production') {
      const line = this.format('debug', message, ...args);
      console.log(line);
      this.writeToFile(line);
    }
  }
}
