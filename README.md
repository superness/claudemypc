# DiscordMyPC

A Discord bot that acts as a bridge to Claude Code CLI, allowing you to control your local machine through Discord. Supports multiple PCs running the same bot with distinct identities.

## Features

- **Channel-based Context**: Each Discord channel maintains its own Claude Code session with isolated working directories
- **Multi-PC Support**: Run the bot on multiple computers, each with a unique identity and independently addressable
- **Auto Project Detection**: Channel names automatically map to project directories
- **Dynamic Channel Creation**: Create new channels on-the-fly for different projects
- **Background Tasks**: Run long-running commands in the background with completion notifications
- **Task Queue**: Manage multiple background tasks with status tracking
- **File Operations**: Download files from your PC through Discord
- **Git Integration**: Quick git status, pull, and log commands
- **Deployment Support**: Run deployment scripts directly from Discord
- **Self-Updating**: Update the bot code through Discord commands
- **Shell Access**: Run arbitrary shell commands through the bot
- **Message Chunking**: Handles long responses by splitting them appropriately
- **Code Formatting**: Automatic syntax highlighting for code responses
- **Logging**: Comprehensive file-based logging for debugging

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Bot" section and click "Add Bot"
4. Enable these Privileged Gateway Intents:
   - MESSAGE CONTENT INTENT
   - SERVER MEMBERS INTENT (optional)
5. Copy the bot token

### 2. Invite Bot to Your Server

1. Go to "OAuth2" -> "URL Generator"
2. Select scopes: `bot`, `applications.commands`
3. Select permissions:
   - Send Messages
   - Manage Channels
   - Read Message History
   - Use Slash Commands
   - Embed Links
   - Attach Files
   - Manage Nicknames (for multi-PC identification)
4. Copy the generated URL and open it to invite the bot

### 3. Configure the Bot

```bash
# Clone/navigate to the bot directory
cd /mnt/c/github/discordmypc

# Copy environment template
cp .env.example .env

# Edit .env with your values
```

Required `.env` values:
- `DISCORD_TOKEN`: Your bot token from Discord Developer Portal
- `OWNER_ID`: Your Discord user ID
- `GUILD_ID`: Your server ID (for instant command registration)
- `WORK_DIR`: Base directory for projects (e.g., `/mnt/c/github`)

Multi-PC Configuration:
- `INSTANCE_ID`: Unique identifier for this PC (defaults to hostname)
- `INSTANCE_NAME`: Human-friendly name shown in Discord
- `INSTANCE_EMOJI`: Emoji to identify this instance (default: 🖥️)

### 4. Install and Run

```bash
npm install
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Usage

### Slash Commands

| Command | Description |
|---------|-------------|
| `/newchannel <name> [path] [category]` | Create a new channel for a project |
| `/setdir <path>` | Set working directory for current channel |
| `/info` | Show current channel session info |
| `/projects` | List available project directories |
| `/reset` | Reset/kill the Claude session for this channel |
| `/status` | Show bot status and all active sessions |
| `/shell <command> [background]` | Run a shell command |
| `/task run <command> [description]` | Run a background task |
| `/task list` | List all active tasks |
| `/task status <id>` | Get task status |
| `/task output <id>` | Get task output |
| `/task cancel <id>` | Cancel a running task |
| `/file get <path>` | Download a file |
| `/file list [path]` | List directory contents |
| `/git status` | Show git status |
| `/git pull` | Pull latest changes |
| `/git log [count]` | Show recent commits |
| `/deploy [script] [background]` | Run deployment script |
| `/instances` | Show all connected bot instances |
| `/whoami` | Show which PC instance this is |
| `/pc <target> <message>` | Send message to specific PC |
| `/update` | Pull latest bot code and restart |
| `/restart` | Restart the bot |

### Chat Commands

Simply type messages in any channel where the bot is active:

- Messages in channels with configured working directories are sent directly to Claude
- In other channels, mention the bot: `@BotName your message`
- Type `stop` or `cancel` to kill a running Claude session
- Type `ping` for a quick response test
- Type `whoami` to see which PC instance responded

### Multi-PC Usage

When running the bot on multiple PCs:

1. Each PC should have a unique `INSTANCE_NAME` in its `.env` file
2. All instances respond to `/instances` showing their identity
3. Target specific PCs with `/pc target:MyPC message:do something`
4. Or prefix chat messages: `@MyPC what's in the src folder?`
5. Each PC shows its identity in the status line: `[🖥️ MyPC]`

Example multi-PC setup:
- PC1: `INSTANCE_NAME=Desktop`, `INSTANCE_EMOJI=🖥️`
- PC2: `INSTANCE_NAME=Laptop`, `INSTANCE_EMOJI=💻`
- PC3: `INSTANCE_NAME=Server`, `INSTANCE_EMOJI=🖧`

### Project Workflow Example

1. Create a channel for your project:
   ```
   /newchannel name:CoiniumServ category:Projects
   ```

2. If the directory `/mnt/c/github/CoiniumServ` exists, it's auto-detected

3. Or set it manually:
   ```
   /setdir path:/mnt/c/github/CoiniumServ
   ```

4. Now just chat! All messages go to Claude with that project context:
   ```
   What's in the src folder?
   Fix the bug in the mining code
   Run the tests
   ```

5. Run background tasks for long operations:
   ```
   /task run command:npm run build description:Building project
   ```

6. Deploy your project:
   ```
   /deploy script:./deploy.sh background:true
   ```

## Architecture

```
discordmypc/
├── src/
│   ├── index.js          # Main entry, Discord client setup
│   ├── config.js         # Configuration with multi-PC support
│   ├── claudeSession.js  # Claude Code CLI integration
│   ├── sessionManager.js # Multi-channel session management
│   ├── taskQueue.js      # Background task management
│   ├── commands.js       # Slash command handlers
│   ├── messageHandler.js # Message processing & notifications
│   └── logger.js         # File-based logging
├── logs/                  # Daily log files
├── tasks/                 # Persisted task state
├── .env                   # Your configuration (not committed)
├── .env.example           # Configuration template
├── channel-mappings.json  # Persisted channel->directory mappings
└── package.json
```

## Notes

- Claude Code CLI must be installed and accessible
- The bot uses `claude --print` for single-shot commands
- Sessions timeout after 10 minutes of processing (configurable)
- Background tasks are persisted and survive bot restarts
- Logs are stored in daily files under `logs/`
- Each PC instance maintains its own task queue

## Troubleshooting

**Bot not responding:**
- Check that MESSAGE CONTENT INTENT is enabled in Discord Developer Portal
- Verify your OWNER_ID is correct
- Check console and log files for errors

**Commands not appearing:**
- Set GUILD_ID for instant command registration
- Without GUILD_ID, global commands take up to an hour to propagate

**Claude errors:**
- Ensure `claude` command is in PATH, or set CLAUDE_CLI_PATH
- Check working directory exists and is accessible

**Multi-PC issues:**
- Ensure each PC has a unique INSTANCE_ID or INSTANCE_NAME
- Check that all PCs can see the Discord server
- Use `/instances` to verify which PCs are online

**Tasks not completing:**
- Check task timeout settings (TASK_TIMEOUT_MS)
- Use `/task output <id>` to see what's happening
- Check log files for errors
