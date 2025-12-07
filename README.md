# ClaudeMyPC

A Discord bot that interfaces with your local Claude Code CLI, letting you interact with Claude on your PC through Discord. Features channel-based project context, persistent knowledge per channel, and real-time streaming output.

## Prerequisites

- **Claude Code CLI** installed and working (`claude --version`)
- **Node.js** 18+
- A Discord bot token

## Features

- **Channel-based Context**: Each Discord channel maps to a working directory - Claude knows the project context
- **Persistent Knowledge**: Claude saves findings, decisions, and notes per channel that survive restarts
- **Real-time Streaming**: See what Claude is thinking and doing as it works (tool calls, text generation)
- **MCP Tools**: Claude can run commands, read/write files, search code, create channels, and more
- **Dynamic Channel Creation**: Claude can create new channels for projects when you ask
- **Thread Support**: Create threads for focused tasks with separate context
- **Multi-PC Support**: Run on multiple computers, each with unique identity
- **Background Tasks**: Run long-running commands with completion notifications

## Quick Start (Using Claude Code CLI)

If you already have Claude Code CLI, just run this prompt:

```
Clone https://github.com/superness/claudemypc.git and help me set it up. Install dependencies, guide me through creating a Discord bot and getting the token, then configure .env with my settings.
```

Claude will walk you through:
1. Cloning the repo and installing dependencies
2. Creating a Discord bot (with links to the Developer Portal)
3. Getting your Discord IDs
4. Configuring `.env`
5. Starting the bot

## Manual Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/superness/claudemypc.git
cd claudemypc

# 2. Install dependencies
npm install
cd mcp-server && npm install && cd ..

# 3. Copy and edit config
cp .env.example .env
# Edit .env with your Discord token and settings (see below)

# 4. Run the bot
npm start
```

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** → give it a name (e.g., "ClaudeMyPC")
3. Go to **"Bot"** in the left sidebar
4. Click **"Reset Token"** and copy the token (you'll need this for `.env`)
5. Scroll down to **"Privileged Gateway Intents"** and enable:
   - ✅ **MESSAGE CONTENT INTENT** (required - lets bot read messages)
   - ✅ **SERVER MEMBERS INTENT** (optional)

### 2. Invite Bot to Your Server

1. In Discord Developer Portal, go to **"OAuth2" → "URL Generator"**
2. Under **Scopes**, check:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Under **Bot Permissions**, check:
   - ✅ Send Messages
   - ✅ Manage Channels
   - ✅ Manage Threads
   - ✅ Read Message History
   - ✅ Embed Links
   - ✅ Attach Files
4. Copy the generated URL at the bottom and open it in your browser
5. Select your server and authorize

### 3. Get Your IDs

You'll need your Discord User ID and Server ID:

1. In Discord, go to **Settings → Advanced → Enable Developer Mode**
2. Right-click your server name → **"Copy Server ID"** (this is `GUILD_ID`)
3. Right-click your username → **"Copy User ID"** (this is `OWNER_ID`)

### 4. Configure the Bot

Edit `.env` with your values:

```bash
# Required
DISCORD_TOKEN=your_bot_token_here
GUILD_ID=your_server_id_here
WORK_DIR=/path/to/your/projects

# Optional (for multi-PC setups)
INSTANCE_NAME=MyPC
INSTANCE_EMOJI=🖥️
```

| Variable | Description | Example |
|----------|-------------|---------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal | `MTQ0NzMyMjY4...` |
| `GUILD_ID` | Your Discord server ID | `1447321563350437890` |
| `WORK_DIR` | Base directory for projects | `/mnt/c/github` or `C:\github` |
| `INSTANCE_NAME` | Name shown in Discord responses | `Desktop`, `Laptop` |
| `INSTANCE_EMOJI` | Emoji prefix for responses | `🖥️`, `💻` |

### 5. Run

```bash
npm start
```

You should see:
```
[INFO] [bot] Logged in as ClaudeMyPC#1234
[INFO] [bot] Bot is ready!
```

Now just talk to the bot in any channel!

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

## How It Works

The bot runs Claude Code CLI with an MCP server that provides tools for:
- **File/Shell**: `run_command`, `read_file`, `write_file`, `list_directory`, `search_files`, `search_content`
- **Git**: `git_status`, `git_diff`
- **Discord**: `create_channel`, `create_thread`, `list_channels`
- **Context**: `update_context`, `get_context` (persistent knowledge per channel)

Claude uses `--dangerously-skip-permissions` so it can execute tools without prompts. The MCP server communicates with the Discord bot via file-based IPC to create channels/threads.

## Notes

- Claude Code CLI must be installed and accessible (`claude --version`)
- Uses `claude --print --verbose --output-format stream-json --include-partial-messages` for streaming
- Sessions timeout after 10 minutes of processing (configurable)
- Persistent context is stored in `context/` directory as JSON files
- Logs are stored in daily files under `logs/`

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
