// index.js — Creative Roaming Bot with Uptime Logs
require('dotenv').config();

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const mcdataPkg = require('minecraft-data');

// --- Configuration ---
const config = {
    host: process.env.SERVER_HOST || 'REALV4NSH.aternos.me',
    port: parseInt(process.env.SERVER_PORT || '53024', 10),
    username: process.env.BOT_USERNAME || 'AFKBot123',
    auth: process.env.BOT_AUTH || 'offline',
    
    // Settings
    announceInterval: 30 * 60 * 1000, // Chat uptime every 30 minutes
    moveInterval: 10000 // Try to move every 10 seconds if idle
};

// --- Global State ---
let bot = null;
let logicLoop = null;
let uptimeInterval = null;
let reconnectDelay = 5000;
let isStarting = false;
const maxBackoff = 300000; // Cap wait time at 5 minutes
const startTime = Date.now(); // Track when the script actually started

// --- Utility Functions ---
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const jitter = (ms) => ms + randInt(-Math.floor(ms * 0.2), Math.floor(ms * 0.2));

function formatUptime(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)));
    return `${hours}h ${minutes}m ${seconds}s`;
}

// --- The Brain ---
function startLogicLoop() {
    stopLogicLoop();
    
    // 1. Movement Logic Loop
    logicLoop = setInterval(() => {
        if (!bot || !bot.entity) return;

        // If currently moving, don't interrupt
        if (bot.pathfinder.isMoving()) return;

        // 50% chance to move, 50% chance to stay put and look around
        if (Math.random() > 0.5) {
            wander();
        } else {
            lookAround();
        }
    }, config.moveInterval);

    // 2. Chat Announcement Loop
    uptimeInterval = setInterval(() => {
        if (bot && bot.entity) {
            const up = formatUptime(Date.now() - startTime);
            safeChat(`I am still here! Uptime: ${up}`);
        }
    }, config.announceInterval);
}

function stopLogicLoop() {
    if (logicLoop) clearInterval(logicLoop);
    if (uptimeInterval) clearInterval(uptimeInterval);
    logicLoop = null;
    uptimeInterval = null;
}

// --- Actions ---

function safeChat(msg) {
    if (!bot) return;
    // Anti-spam: small delay or check could go here
    bot.chat(msg);
    console.log(`[BOT-CHAT] ${msg}`);
}

function lookAround() {
    if (!bot || !bot.entity) return;
    const yaw = (Math.random() * Math.PI * 2) - Math.PI; 
    const pitch = (Math.random() * Math.PI / 2) - (Math.PI / 4);
    bot.look(yaw, pitch).catch(() => {});
}

function wander() {
    if (!bot || !bot.entity) return;
    
    const Distance = 20;
    const origin = bot.entity.position;

    // Pick a random spot
    const x = origin.x + randInt(-Distance, Distance);
    const z = origin.z + randInt(-Distance, Distance);
    
    // In creative, we don't care much about falling, but we want to land on blocks
    // to look "normal".
    const goal = new goals.GoalNear(x, origin.y, z, 1);
    
    try {
        bot.pathfinder.setGoal(goal);
    } catch (e) {
        // Ignore pathfinder errors, just wait for next loop
    }
}

// --- Bot Lifecycle ---

function startBot() {
    if (isStarting) return;
    isStarting = true;

    console.log(`[INIT] Connecting to ${config.host}:${config.port}...`);

    try {
        bot = mineflayer.createBot({
            host: config.host,
            port: config.port,
            username: config.username,
            auth: config.auth
        });
    } catch (e) {
        console.error('[ERROR] CreateBot failed:', e);
        handleDisconnect('create_error');
        return;
    }

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
        console.log('[SPAWN] Bot connected.');
        reconnectDelay = 5000; // Reset backoff
        isStarting = false;

        // Setup Pathfinder for Creative/Walking
        const mcData = mcdataPkg(bot.version);
        const defaultMovements = new Movements(bot, mcData);
        
        defaultMovements.canDig = false; 
        defaultMovements.allow1by1towers = false; 
        
        bot.pathfinder.setMovements(defaultMovements);

        startLogicLoop();
        safeChat(`Bot connected. Type "status" to see uptime.`);
    });

    // --- Chat Listener (Commands) ---
    bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        
        // Log chat to console
        console.log(`[CHAT] <${username}> ${message}`);

        // Respond to commands
        const msg = message.toLowerCase();
        if (msg.includes('status') || msg.includes('uptime')) {
            const up = formatUptime(Date.now() - startTime);
            const pos = bot.entity.position;
            safeChat(`Running for: ${up} | Pos: ${Math.round(pos.x)}, ${Math.round(pos.z)}`);
        }
        if (msg.includes('come here') || msg.includes('follow')) {
            const player = bot.players[username];
            if (player && player.entity) {
                safeChat(`Coming to ${username}...`);
                bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 1), true);
            }
        }
    });

    bot.on('kicked', (reason) => {
        const r = JSON.stringify(reason);
        console.log(`[KICKED] ${r}`);
        handleDisconnect(r.includes('throttle') ? 'throttle' : 'kicked');
    });

    bot.on('error', (err) => console.log(`[ERROR] ${err.message}`));
    
    bot.on('end', () => {
        console.log('[END] Disconnected.');
        handleDisconnect('end');
    });
}

function handleDisconnect(reason) {
    stopLogicLoop();
    isStarting = false;
    if (bot) {
        bot.removeAllListeners();
        bot = null;
    }

    // Exponential Backoff
    if (reason === 'throttle') reconnectDelay = Math.max(reconnectDelay * 2, 60000); // Wait at least 60s if throttled
    else reconnectDelay = Math.min(Math.floor(reconnectDelay * 1.5), maxBackoff);

    const wait = jitter(reconnectDelay);
    console.log(`[RETRY] Reconnecting in ${Math.round(wait / 1000)}s...`);
    setTimeout(startBot, wait);
}

// Graceful Shutdown
process.on('SIGINT', () => {
    stopLogicLoop();
    if (bot) bot.quit();
    console.log('\n[STOP] Bot shut down manually.');
    process.exit();
});

// Simple HTTP server so Render keeps the service alive
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Mineflayer bot is running.'));
app.listen(process.env.PORT || 3000, () => {
  console.log('HTTP server running on port', process.env.PORT || 3000);
});


startBot();