#!/bin/bash

# DiscordMyPC startup script

cd "$(dirname "$0")"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Check for .env file
if [ ! -f ".env" ]; then
    echo "Error: .env file not found!"
    echo "Please copy .env.example to .env and configure it."
    exit 1
fi

# Start the bot
echo "Starting DiscordMyPC bot..."
exec node src/index.js
