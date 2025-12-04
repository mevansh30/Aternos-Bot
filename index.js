// index.js — Crash-Proof Nomad Bot
require('dotenv').config();
const express = require('express');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const mcdataPkg = require('minecraft-data');

// --- 1. Web Server (Render Keep-Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Nomad Bot Online'));
app.listen(PORT, () => console.log(`[WEB] Listening on port ${PORT}`));

// --- 2. Configuration ---
const config = {
    host: process.env.SERVER_HOST || 'REALV4NSH.aternos.me',
    port: parseInt(process.env.SERVER_PORT || '53024', 10),
    username: process.env.BOT_USERNAME || 'NomadBot',
    auth: process.env.BOT_AUTH || 'offline',
    version: false // Let it auto-detect, or set '1.21.1' if issues persist
};

// --- 3. Global State ---
let bot = null;
let isStarting = false;
let brainInterval = null;
let lastBedPosition = null; 

// --- 4. The Brain ---
function startBrain() {
    stopBrain();
    brainInterval = setInterval(async () => {
        if (!bot || !bot.entity || isStarting) return;
        
        // Critical States
        if (bot.isSleeping) return; 
        if (bot.pvp.target) return; 
        if (bot.pathfinder.isMoving() && Math.random() > 0.2) return; 

        // Night Time -> Sleep
        if (!bot.time.isDay && !bot.isSleeping) {
            await handleSleep();
            return;
        }

        // Random Actions
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
            bot.pathfinder.setGoal(new goals.GoalBlock(nearbyLoot.position.x, nearbyLoot.position.y, nearbyLoot.position.z));
            return;
        }

        // Inventory
        if (chance < 0.05) {
            await randomInventoryShuffle();
            return;
        }

        // Build/Dig
        if (chance < 0.15) {
            if (Math.random() > 0.5) await randomBuild();
            else await randomDig();
            return;
        }

        // Wander
        wander();
    }, 3000); 
}

function stopBrain() {
    if (brainInterval) clearInterval(brainInterval);
    brainInterval = null;
}

// --- 5. Actions (Sleep, Build, etc) ---
async function handleSleep() {
    let bedBlock = bot.findBlock({ matching: bl => bot.isABed(bl), maxDistance: 32 });
    if (!bedBlock) {
        const bedItem = bot.inventory.items().find(item => item.name.includes('bed'));
        if (bedItem) bedBlock = await placeBed(bedItem);
    }

    if (bedBlock) {
        try {
            await bot.pathfinder.goto(new goals.GoalBlock(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z));
            await bot.sleep(bedBlock);
            bot.chat("Goodnight!");
        } catch (e) {}
    }
}

async function placeBed(bedItem) {
    const location = bot.findBlock({
        matching: bl => bl.type !== 0, 
        useExtraInfo: (bl) => {
            const above = bot.blockAt(bl.position.offset(0, 1, 0));
            const side = bot.blockAt(bl.position.offset(1, 0, 0)); 
            const sideAbove = bot.blockAt(bl.position.offset(1, 1, 0));
            return above && above.name === 'air' && side && side.type !== 0 && sideAbove && sideAbove.name === 'air';
        },
        maxDistance: 5
    });

    if (location) {
        try {
            await bot.equip(bedItem, 'hand');
            await bot.placeBlock(location, { x: 0, y: 1, z: 0 });
            lastBedPosition = location.position.offset(0, 1, 0); 
            return bot.blockAt(lastBedPosition);
        } catch (e) {}
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

async function randomBuild() {
    const buildingBlock = bot.inventory.items().find(item => ['dirt', 'cobblestone', 'planks'].some(name => item.name.includes(name)));
    const referenceBlock = bot.findBlock({ matching: bl => bl.name !== 'air', maxDistance: 3 });
    if (buildingBlock && referenceBlock) {
        try {
            await bot.equip(buildingBlock, 'hand');
            await bot.placeBlock(referenceBlock, { x: 0, y: 1, z: 0 });
        } catch (e) {}
    }
}

async function randomDig() {
    const block = bot.findBlock({ matching: bl => bl.name !== 'air' && bl.name !== 'bedrock', maxDistance: 3 });
    if (block) {
        try {
            await bot.tool.equipForBlock(block); 
            await bot.dig(block);
        } catch (e) {}
    }
}

function getHostileMob() {
    return bot.nearestEntity(e => e.type === 'mob' && ['zombie', 'skeleton', 'spider', 'creeper'].includes(e.name));
}

function getNearbyLoot() {
    return bot.nearestEntity(e => e.type === 'object');
}

function wander() {
    const r = 10 + Math.floor(Math.random() * 20);
    const pos = bot.entity.position.offset((Math.random() - 0.5) * r, 0, (Math.random() - 0.5) * r);
    bot.settings.sprint = Math.random() < 0.6;
    if (Math.random() < 0.3) bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 500);
    const goal = new goals.GoalNear(pos.x, pos.y, pos.z, 1);
    try { bot.pathfinder.setGoal(goal); } catch(e) {}
}

// --- 6. Bot Lifecycle (Fixes Here) ---

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
        const mcData = mcdataPkg(bot.version);
        const moves = new Movements(bot, mcData);
        moves.canDig = true;
        moves.canOpenDoors = true;
        bot.pathfinder.setMovements(moves);
        startBrain();
    });

    bot.on('wake', async () => {
        bot.chat('Morning!');
        if (lastBedPosition) {
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

    // --- ERROR HANDLING FIXES ---
    
    bot.on('kicked', (reason) => {
        const r = JSON.stringify(reason);
        console.log(`[KICKED] Reason: ${r}`);
        if (r.includes('duplicate_login')) {
             console.log('[WARN] Duplicate login detected. Waiting longer before reconnect...');
             reconnect('duplicate');
        } else {
             reconnect('kicked');
        }
    });

    bot.on('error', (err) => {
        // Suppress the PartialReadError that happens during kicks
        if (err.message.includes('PartialReadError')) {
            console.log('[WARN] PartialReadError detected (likely due to disconnect). Ignoring.');
            return;
        }
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

    // "Zombie Killer" Logic
    if (bot) {
        bot.removeAllListeners(); 
        // Add a dummy listener to catch late errors so Node doesn't crash
        bot.on('error', () => {}); 
        bot = null;
    }

    let delay = 10000;
    if (reason === 'duplicate') delay = 60000; // Wait 60s if we logged in twice
    
    console.log(`[RETRY] Reconnecting in ${delay/1000}s...`);
    setTimeout(startBot, delay);
}

startBot();
