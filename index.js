// index.js — The Nomad Pro Bot (Sleeps, Builds, Fights, Organizes)
require('dotenv').config();
const express = require('express');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const mcdataPkg = require('minecraft-data');

// --- 1. Render Keep-Alive Server ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('ProBot Nomad Mode: Online'));
app.listen(PORT, () => console.log(`[WEB] Listening on port ${PORT}`));

// --- 2. Config ---
const config = {
    host: process.env.SERVER_HOST || 'REALV4NSH.aternos.me',
    port: parseInt(process.env.SERVER_PORT || '53024', 10),
    username: process.env.BOT_USERNAME || 'NomadBot',
    auth: process.env.BOT_AUTH || 'offline',
};

// --- 3. Global State ---
let bot = null;
let isStarting = false;
let brainInterval = null;
let lastBedPosition = null; // Remembers where we placed the bed to break it later

// --- 4. The Brain ---
function startBrain() {
    stopBrain();
    brainInterval = setInterval(async () => {
        if (!bot || !bot.entity || isStarting) return;
        
        // A. Critical States
        if (bot.isSleeping) return; 
        if (bot.pvp.target) return; 
        if (bot.pathfinder.isMoving() && Math.random() > 0.2) return; 

        // B. Night Time Logic (The Nomad Logic)
        if (!bot.time.isDay && !bot.isSleeping) {
            console.log('[BRAIN] Night detected. Initiating sleep protocol...');
            await handleSleep();
            return;
        }

        // C. Random Actions
        const nearbyMobs = getHostileMobs();
        const nearbyLoot = getNearbyLoot();
        const chance = Math.random();

        // 1. Combat
        if (nearbyMobs.length > 0 && chance < 0.7) {
            bot.pvp.attack(nearbyMobs[0]);
            return;
        }

        // 2. Looting
        if (nearbyLoot && chance < 0.9) {
            bot.pathfinder.setGoal(new goals.GoalBlock(nearbyLoot.position.x, nearbyLoot.position.y, nearbyLoot.position.z));
            return;
        }

        // 3. Inventory Sort
        if (chance < 0.05) {
            await randomInventoryShuffle();
            return;
        }

        // 4. Random Building/Mining
        if (chance < 0.15) {
            if (Math.random() > 0.5) await randomBuild();
            else await randomDig();
            return;
        }

        // 5. Wander
        wander();

    }, 3000); 
}

function stopBrain() {
    if (brainInterval) clearInterval(brainInterval);
}

// --- 5. Sleep & Bed Logic (New Feature) ---

async function handleSleep() {
    // 1. Look for existing bed
    let bedBlock = bot.findBlock({ matching: bl => bot.isABed(bl), maxDistance: 32 });
    
    // 2. If no bed, try to place one from inventory
    if (!bedBlock) {
        const bedItem = bot.inventory.items().find(item => item.name.includes('bed'));
        if (bedItem) {
            console.log('[SLEEP] No bed found. Attempting to place one...');
            bedBlock = await placeBed(bedItem);
        } else {
            console.log('[SLEEP] No bed in world AND no bed in inventory. Staying awake.');
        }
    }

    // 3. Go to sleep
    if (bedBlock) {
        try {
            await bot.pathfinder.goto(new goals.GoalBlock(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z));
            await bot.sleep(bedBlock);
            bot.chat("Goodnight! (Sleeping in " + (lastBedPosition ? "my bed" : "found bed") + ")");
        } catch (e) {
            console.log(`[SLEEP] Failed: ${e.message}`);
        }
    }
}

async function placeBed(bedItem) {
    // Find a solid block to place the bed on
    // Bed needs 2 blocks of space. We look for a solid block that has air above it.
    const location = bot.findBlock({
        matching: bl => bl.type !== 0, // Not air
        useExtraInfo: (bl) => {
            const above = bot.blockAt(bl.position.offset(0, 1, 0));
            const side = bot.blockAt(bl.position.offset(1, 0, 0)); // Simply checking +X direction for space
            const sideAbove = bot.blockAt(bl.position.offset(1, 1, 0));
            
            // Needs air above current block, and air at the "foot" of the bed
            return above && above.name === 'air' && side && side.type !== 0 && sideAbove && sideAbove.name === 'air';
        },
        maxDistance: 5
    });

    if (!location) {
        console.log('[SLEEP] Could not find flat ground to place bed.');
        return null;
    }

    try {
        await bot.equip(bedItem, 'hand');
        await bot.lookAt(location.position); // Look at ground
        // Place bed on the block
        await bot.placeBlock(location, { x: 0, y: 1, z: 0 });
        
        // Return the new bed block (it's at location.y + 1)
        lastBedPosition = location.position.offset(0, 1, 0); // Remember to break it later
        return bot.blockAt(lastBedPosition);
    } catch (e) {
        console.log('[SLEEP] Failed to place bed:', e.message);
        return null;
    }
}

// --- 6. Other Actions ---

async function randomInventoryShuffle() {
    bot.look(bot.entity.yaw, -1.5); // Look down
    const items = bot.inventory.items();
    if (items.length < 2) return;
    const slotA = items[Math.floor(Math.random() * items.length)].slot;
    const slotB = Math.floor(Math.random() * 36); 
    try { await bot.moveSlotItem(slotA, slotB); } catch(e) {}
    setTimeout(() => bot.look(bot.entity.yaw, 0), 1500);
}

async function randomBuild() {
    const buildingBlock = bot.inventory.items().find(item => 
        ['dirt', 'cobblestone', 'planks', 'stone'].some(name => item.name.includes(name))
    );
    if (!buildingBlock) return; 

    const referenceBlock = bot.findBlock({ matching: bl => bl.name !== 'air', maxDistance: 3 });
    if (referenceBlock) {
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

function getHostileMobs() {
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

// --- 7. Lifecycle ---

function startBot() {
    if (isStarting) return;
    isStarting = true;
    console.log(`[INIT] Connecting to ${config.host}...`);

    try {
        bot = mineflayer.createBot({
            host: config.host,
            port: config.port,
            username: config.username,
            auth: config.auth
        });
    } catch (e) {
        reconnect();
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

    // WAKE UP EVENT: Pack up the bed!
    bot.on('wake', async () => {
        console.log('[EVENT] Woke up.');
        bot.chat('Morning!');

        // If we placed a bed, let's break it to take it with us
        if (lastBedPosition) {
            const bedBlock = bot.blockAt(lastBedPosition);
            if (bedBlock && bot.isABed(bedBlock)) {
                console.log('[ACTION] Packing up bed...');
                try {
                    await bot.tool.equipForBlock(bedBlock);
                    await bot.dig(bedBlock);
                    lastBedPosition = null; // Forget it
                } catch (e) {
                    console.log('[ERROR] Could not pack bed:', e.message);
                }
            }
        }
    });

    bot.on('kicked', console.log);
    bot.on('error', console.log);
    bot.on('end', () => {
        console.log('[END] Disconnected.');
        reconnect();
    });
}

function reconnect() {
    stopBrain();
    isStarting = false;
    setTimeout(startBot, 10000);
}

startBot();
