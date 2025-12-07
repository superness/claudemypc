import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config, getInstancePrefix } from './config.js';
import { Logger } from './logger.js';

const logger = new Logger('taskQueue');

/**
 * Task states
 */
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Represents a background task
 */
export class Task {
  constructor(options) {
    this.id = uuidv4();
    this.type = options.type; // 'claude', 'shell', 'deploy', etc.
    this.command = options.command;
    this.workingDir = options.workingDir || config.claude.workDir;
    this.channelId = options.channelId;
    this.userId = options.userId;
    this.status = TaskStatus.PENDING;
    this.output = '';
    this.error = null;
    this.createdAt = new Date();
    this.startedAt = null;
    this.completedAt = null;
    this.process = null;
    this.description = options.description || options.command.slice(0, 50);
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      command: this.command,
      workingDir: this.workingDir,
      channelId: this.channelId,
      userId: this.userId,
      status: this.status,
      output: this.output.slice(-5000), // Keep last 5000 chars
      error: this.error,
      description: this.description,
      createdAt: this.createdAt.toISOString(),
      startedAt: this.startedAt?.toISOString(),
      completedAt: this.completedAt?.toISOString(),
    };
  }
}

/**
 * Manages background tasks with notifications
 */
export class TaskQueue extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.running = new Map();
    this.maxConcurrent = config.taskQueue.maxConcurrent;
    this.timeoutMs = config.taskQueue.timeoutMs;

    // Ensure tasks directory exists
    if (!existsSync(config.paths.tasks)) {
      mkdirSync(config.paths.tasks, { recursive: true });
    }

    // Load persisted tasks
    this.loadTasks();
  }

  /**
   * Add a new task to the queue
   */
  async addTask(options) {
    const task = new Task(options);
    this.tasks.set(task.id, task);
    this.saveTasks();

    logger.info(`Task added: ${task.id} - ${task.description}`);
    this.emit('taskAdded', task);

    // Try to run immediately if capacity available
    this.processQueue();

    return task;
  }

  /**
   * Process pending tasks
   */
  processQueue() {
    if (this.running.size >= this.maxConcurrent) {
      return;
    }

    for (const [id, task] of this.tasks) {
      if (task.status === TaskStatus.PENDING && !this.running.has(id)) {
        this.runTask(task);
        if (this.running.size >= this.maxConcurrent) {
          break;
        }
      }
    }
  }

  /**
   * Run a task
   */
  async runTask(task) {
    task.status = TaskStatus.RUNNING;
    task.startedAt = new Date();
    this.running.set(task.id, task);

    logger.info(`Task starting: ${task.id} - ${task.description}`);
    this.emit('taskStarted', task);

    try {
      let args;
      let cmd;

      if (task.type === 'claude') {
        cmd = config.claude.cliPath;
        args = ['--print', '--output-format', 'text', task.command];
      } else {
        cmd = 'bash';
        args = ['-c', task.command];
      }

      task.process = spawn(cmd, args, {
        cwd: task.workingDir,
        env: { ...process.env, TERM: 'dumb' },
        shell: task.type !== 'claude',
      });

      task.process.stdout.on('data', (data) => {
        task.output += data.toString();
        this.emit('taskOutput', task, data.toString());
      });

      task.process.stderr.on('data', (data) => {
        task.output += data.toString();
      });

      // Timeout handler
      const timeout = setTimeout(() => {
        if (task.process) {
          task.process.kill('SIGTERM');
          task.error = 'Task timed out';
          task.status = TaskStatus.FAILED;
        }
      }, this.timeoutMs);

      task.process.on('close', (code) => {
        clearTimeout(timeout);
        this.running.delete(task.id);
        task.completedAt = new Date();
        task.process = null;

        if (task.status === TaskStatus.CANCELLED) {
          logger.info(`Task cancelled: ${task.id}`);
          this.emit('taskCancelled', task);
        } else if (code === 0) {
          task.status = TaskStatus.COMPLETED;
          logger.info(`Task completed: ${task.id}`);
          this.emit('taskCompleted', task);
        } else {
          task.status = TaskStatus.FAILED;
          task.error = task.error || `Exited with code ${code}`;
          logger.error(`Task failed: ${task.id} - ${task.error}`);
          this.emit('taskFailed', task);
        }

        this.saveTasks();
        this.processQueue();
      });

      task.process.on('error', (err) => {
        clearTimeout(timeout);
        this.running.delete(task.id);
        task.completedAt = new Date();
        task.status = TaskStatus.FAILED;
        task.error = err.message;
        task.process = null;

        logger.error(`Task error: ${task.id} - ${err.message}`);
        this.emit('taskFailed', task);
        this.saveTasks();
        this.processQueue();
      });

    } catch (err) {
      task.status = TaskStatus.FAILED;
      task.error = err.message;
      task.completedAt = new Date();
      this.running.delete(task.id);
      this.emit('taskFailed', task);
      this.saveTasks();
    }
  }

  /**
   * Cancel a task
   */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === TaskStatus.RUNNING && task.process) {
      task.status = TaskStatus.CANCELLED;
      task.process.kill('SIGTERM');
      return true;
    } else if (task.status === TaskStatus.PENDING) {
      task.status = TaskStatus.CANCELLED;
      task.completedAt = new Date();
      this.saveTasks();
      return true;
    }

    return false;
  }

  /**
   * Cancel all tasks
   */
  cancelAll() {
    for (const [id, task] of this.tasks) {
      if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.PENDING) {
        this.cancelTask(id);
      }
    }
  }

  /**
   * Get task by ID
   */
  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks for a channel
   */
  getChannelTasks(channelId) {
    return Array.from(this.tasks.values()).filter(t => t.channelId === channelId);
  }

  /**
   * Get pending and running tasks
   */
  getActiveTasks() {
    return Array.from(this.tasks.values()).filter(
      t => t.status === TaskStatus.PENDING || t.status === TaskStatus.RUNNING
    );
  }

  /**
   * Get queue status
   */
  getStatus() {
    const all = Array.from(this.tasks.values());
    return {
      total: all.length,
      pending: all.filter(t => t.status === TaskStatus.PENDING).length,
      running: all.filter(t => t.status === TaskStatus.RUNNING).length,
      completed: all.filter(t => t.status === TaskStatus.COMPLETED).length,
      failed: all.filter(t => t.status === TaskStatus.FAILED).length,
      cancelled: all.filter(t => t.status === TaskStatus.CANCELLED).length,
    };
  }

  /**
   * Clean up old completed/failed tasks
   */
  cleanup(maxAge = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (
        (task.status === TaskStatus.COMPLETED ||
         task.status === TaskStatus.FAILED ||
         task.status === TaskStatus.CANCELLED) &&
        task.completedAt &&
        now - task.completedAt.getTime() > maxAge
      ) {
        this.tasks.delete(id);
      }
    }
    this.saveTasks();
  }

  /**
   * Save tasks to disk
   */
  saveTasks() {
    const tasksFile = join(config.paths.tasks, `tasks-${config.instance.id}.json`);
    const data = Array.from(this.tasks.values()).map(t => t.toJSON());
    try {
      writeFileSync(tasksFile, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error('Failed to save tasks:', err);
    }
  }

  /**
   * Load tasks from disk
   */
  loadTasks() {
    const tasksFile = join(config.paths.tasks, `tasks-${config.instance.id}.json`);
    if (existsSync(tasksFile)) {
      try {
        const data = JSON.parse(readFileSync(tasksFile, 'utf-8'));
        for (const taskData of data) {
          // Only restore non-running tasks
          if (taskData.status !== TaskStatus.RUNNING) {
            const task = new Task(taskData);
            Object.assign(task, taskData);
            task.createdAt = new Date(taskData.createdAt);
            if (taskData.startedAt) task.startedAt = new Date(taskData.startedAt);
            if (taskData.completedAt) task.completedAt = new Date(taskData.completedAt);
            this.tasks.set(task.id, task);
          }
        }
        logger.info(`Loaded ${this.tasks.size} tasks from disk`);
      } catch (err) {
        logger.error('Failed to load tasks:', err);
      }
    }
  }
}
