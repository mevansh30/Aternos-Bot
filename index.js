// index.js — Human-Like Nomad Bot v3 (Stable & Chatty)
require('dotenv').config();
const express = require('express');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const mcdataPkg = require('minecraft-data');

// --- 1. Global Stability & Stats ---
const START_TIME = Date.now();

// Prevent the process from crashing on unexpected errors
process.on('uncaughtException', (err) => {
    console.log('[INTERNAL ERROR] Uncaught Exception:', err.message);
    // Do not exit. The reconnect logic in startBot will handle the restart.
});

process.on('unhandledRejection', (reason, promise) => {
    console.log('[INTERNAL ERROR] Unhandled Rejection:', reason);
});

// --- 2. Web Server (Render Keep-Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - START_TIME) / 1000);
    res.send(`Nomad Bot is Running.<br>Uptime: ${uptime} seconds.<br>Bot Status: ${bot ? 'Connected' : 'Disconnected'}`);
});

app.listen(PORT, () => console.log(`[WEB] Listening on port ${PORT}. PING THIS URL TO KEEP BOT ALIVE.`));

// --- 3. Configuration ---
const config = {
    host: process.env.SERVER_HOST || 'REALV4NSH.aternos.me',
    port: parseInt(process.env.SERVER_PORT || '53024', 10),
    username: process.env.BOT_USERNAME || 'NomadBot',
    auth: process.env.BOT_AUTH || 'offline',
    version: '1.21.1' // Hardcoded to prevent protocol errors
};

// --- 4. Global Bot State ---
let bot = null;
let isStarting = false;
let brainInterval = null;
let lookInterval = null;
let lastBedPosition = null; 

// --- 5. The Brain (AI Logic) ---
function startBrain() {
    stopBrain();
    
    // Feature: Human-like Head Looking
    lookInterval = setInterval(() => {
        if(!bot || !bot.entity) return;
        if(bot.pathfinder.isMoving()) return;
        
        // Randomly look around
        const yaw = (Math.random() * Math.PI) - (0.5 * Math.PI);
        const pitch = (Math.random() * Math.PI / 2) - (Math.PI / 4);
        bot.look(bot.entity.yaw + yaw, pitch);
    }, 4000);

    brainInterval = setInterval(async () => {
        if (!bot || !bot.entity || isStarting) return;
        
        // Priority Checks
        if (bot.isSleeping) return; 
        if (bot.pvp.target) return; 
        if (bot.pathfinder.isMoving()) return; 

        // 1. Sleep Logic
        if (!bot.time.isDay && !bot.isSleeping) {
            await handleSleep();
            return;
        }

        // 2. Random Decisions
        const nearbyMob = getHostileMob();
        const nearbyLoot = getNearbyLoot();
        const chance = Math.random();

        // Combat
        if (nearbyMob && chance < 0.6) {
            bot.pvp.attack(nearbyMob);
            return;
        }

        // Looting
        if (nearbyLoot && chance < 0.8) {
            if (nearbyLoot.position) {
                bot.pathfinder.setGoal(new goals.GoalBlock(nearbyLoot.position.x, nearbyLoot.position.y, nearbyLoot.position.z));
            }
            return;
        }

        // Idle / Inventory / Wander
        if (chance < 0.05) { await randomInventoryShuffle(); return; }
        if (chance < 0.15) { return; } // Just stand still (human-like)
        
        wander();
    }, 3000); 
}

function stopBrain() {
    if (brainInterval) clearInterval(brainInterval);
    if (lookInterval) clearInterval(lookInterval);
    brainInterval = null;
    lookInterval = null;
}

// --- 6. Actions ---

async function handleSleep() {
    let bedBlock = bot.findBlock({ matching: bl => bot.isABed(bl), maxDistance: 32 });
    
    if (!bedBlock) {
        const bedItem = bot.inventory.items().find(item => item.name.includes('bed'));
        if (bedItem) bedBlock = await placeBed(bedItem);
    }

    if (bedBlock) {
        try {
            await bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1));
            if (bot.time.isDay && !bot.isRaining) return; // Verify night again
            await bot.sleep(bedBlock);
            bot.chat("Goodnight!");
        } catch (e) {
            console.log(`[SLEEP] Failed: ${e.message}`);
        }
    }
}

async function placeBed(bedItem) {
    const center = bot.entity.position;
    // Scan for 2x1 flat area
    for (let x = -5; x <= 5; x++) {
        for (let y = -2; y <= 2; y++) {
            for (let z = -5; z <= 5; z++) {
                const footPos = center.offset(x, y, z).floored();
                const footBlock = bot.blockAt(footPos);
                const footAir = bot.blockAt(footPos.offset(0, 1, 0));

                if (!footBlock || footBlock.boundingBox !== 'block') continue;
                if (!footAir || footAir.boundingBox !== 'empty') continue;

                const offsets = [[1,0], [-1,0], [0,1], [0,-1]];
                for (let dir of offsets) {
                    const headPos = footPos.offset(dir[0], 0, dir[1]);
                    const headBlock = bot.blockAt(headPos);
                    const headAir = bot.blockAt(headPos.offset(0, 1, 0));

                    if (headBlock && headBlock.boundingBox === 'block' && headAir && headAir.boundingBox === 'empty') {
                        try {
                            await bot.equip(bedItem, 'hand');
                            await bot.lookAt(headPos.offset(0.5, 1, 0.5));
                            await bot.placeBlock(footBlock, { x: 0, y: 1, z: 0 });
                            lastBedPosition = footPos.offset(0, 1, 0); 
                            return bot.blockAt(lastBedPosition);
                        } catch (e) {}
                    }
                }
            }
        }
    }
    return null;
}

async function randomInventoryShuffle() {
    bot.look(bot.entity.yaw, -1.5);
    const items = bot.inventory.items();
    if (items.length > 1) {
        const slotA = items[Math.floor(Math.random() * items.length)].slot;
        const slotB = Math.floor(Math.random() * 36); 
        try { await bot.moveSlotItem(slotA, slotB); } catch(e) {}
    }
    setTimeout(() => bot.look(bot.entity.yaw, 0), 1500);
}

function getHostileMob() {
    return bot.nearestEntity(e => e.type === 'mob' && ['zombie', 'skeleton', 'spider', 'creeper'].includes(e.name));
}

function getNearbyLoot() {
    return bot.nearestEntity(e => e.type === 'object');
}

function wander() {
    const r = 15; 
    const pos = bot.entity.position.offset((Math.random() - 0.5) * r, 0, (Math.random() - 0.5) * r);
    bot.settings.sprint = Math.random() < 0.4; 
    if (Math.random() < 0.1) bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 500);

    try { bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1)); } catch(e) {}
}

// --- 7. Formatting Stats ---
function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ${s % 60}s`;
}

// --- 8. Bot Lifecycle ---

function startBot() {
    if (isStarting) return;
    isStarting = true;
    console.log(`[INIT] Connecting to ${config.host}:${config.port}...`);

    try {
        bot = mineflayer.createBot({
            host: config.host,
            port: config.port,
            username: config.username,
            auth: config.auth,
            version: config.version,
            hideErrors: false
        });
    } catch (e) {
        reconnect('create_error');
        return;
    }

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(toolPlugin);

    bot.once('spawn', () => {
        console.log('[SPAWN] Bot online.');
        isStarting = false;
        
        bot.waitForChunksToLoad().then(() => {
            console.log('[WORLD] Chunks loaded. Brain active.');
            const mcData = mcdataPkg(bot.version);
            const moves = new Movements(bot, mcData);
            moves.canDig = true;
            moves.canOpenDoors = true;
            moves.allow1by1towers = false; 
            bot.pathfinder.setMovements(moves);
            startBrain();
        });
    });

    // --- NEW: CHAT REPLY LOGIC ---
    bot.on('chat', (username, message) => {
        if (username === bot.username) return; // Ignore self

        const msg = message.toLowerCase();
        if (msg.includes('status') || msg.includes('uptime') || msg.includes('ping') || msg.includes('hello')) {
            
            const currentPing = bot.player ? bot.player.ping : 0;
            const uptimeStr = formatUptime(Date.now() - START_TIME);
            
            bot.chat(`I am online! | Uptime: ${uptimeStr} | Ping: ${currentPing}ms`);
        }
    });

    bot.on('wake', async () => {
        if (lastBedPosition && bot.time.isDay) {
            const bedBlock = bot.blockAt(lastBedPosition);
            if (bedBlock && bot.isABed(bedBlock)) {
                try {
                    await bot.tool.equipForBlock(bedBlock);
                    await bot.dig(bedBlock);
                    lastBedPosition = null; 
                } catch (e) {}
            }
        }
    });

    bot.on('kicked', (reason) => {
        console.log(`[KICKED] ${JSON.stringify(reason)}`);
        reconnect('kicked');
    });

    bot.on('error', (err) => {
        if (err.message.includes('PartialReadError')) return;
        console.log(`[ERROR] ${err.message}`);
        reconnect('error');
    });

    bot.on('end', () => {
        console.log('[END] Disconnected.');
        reconnect('end');
    });
}

function reconnect(reason) {
    stopBrain();
    isStarting = false;
    if (bot) {
        bot.removeAllListeners(); 
        bot.on('error', () => {}); 
        bot = null;
    }
    
    // Randomize reconnect time slightly to avoid anti-bot detection or server spam
    const delay = reason === 'duplicate' ? 60000 : 10000;
    console.log(`[RETRY] Reconnecting in ${delay/1000}s...`);
    setTimeout(startBot, delay);
}

startBot();
