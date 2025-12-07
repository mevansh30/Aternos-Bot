// index.js — Human-Like Nomad Bot v5.1 (Survivor + 1.21 Fix + Nomad Control)
require('dotenv').config();
const express = require('express');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const mcdataPkg = require('minecraft-data');

// --- 1. Global Stability & Stats ---
const START_TIME = Date.now();

process.on('uncaughtException', (err) => {
    console.log('[INTERNAL ERROR] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.log('[INTERNAL ERROR] Unhandled Rejection:', reason);
});

// --- 2. Web Server ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - START_TIME) / 1000);
    res.send(`Nomad Bot v5.1 is Running.<br>Uptime: ${uptime}s.<br>Status: ${bot ? 'Connected' : 'Disconnected'}`);
});

app.get('/rejoin', (req, res) => {
    res.send("Forcing bot to rejoin server...");
    console.log('[WEB] Force rejoin triggered.');
    if (bot) bot.end();
    else startBot();
});

app.listen(PORT, () => console.log(`[WEB] Listening on port ${PORT}.`));

// --- 3. Configuration ---
const config = {
    host: process.env.SERVER_HOST || 'REALV4NSH.aternos.me',
    port: parseInt(process.env.SERVER_PORT || '53024', 10),
    username: process.env.BOT_USERNAME || 'NomadBot',
    auth: process.env.BOT_AUTH || 'offline',
    version: '1.21.1',
    master: process.env.BOT_MASTER || null 
};

// --- 4. Global Bot State ---
let bot = null;
let isStarting = false;
let brainInterval = null;
let lookInterval = null;
let lastBedPosition = null; 
let mcData = null;

// SETTINGS & MODES
let botMode = 'normal'; // 'normal' (Farm/Fight) or 'afk' (Passive)
let sleepMode = 'auto'; // 'auto', 'force', 'deny'
let nomadMode = false;  // Default: FALSE (Won't place/break beds unless told to)

// --- 5. The Brain (AI Logic) ---
function startBrain() {
    stopBrain();
    
    // Feature: Human-like Head Looking
    lookInterval = setInterval(() => {
        if(!bot || !bot.entity) return;
        if(bot.pathfinder.isMoving()) return;
        const yaw = (Math.random() * Math.PI) - (0.5 * Math.PI);
        const pitch = (Math.random() * Math.PI / 2) - (Math.PI / 4);
        bot.look(bot.entity.yaw + yaw, pitch);
    }, 4000);

    brainInterval = setInterval(async () => {
        if (!bot || !bot.entity || isStarting) return;
        if (bot.pathfinder.isMoving()) return; 

        // --- PRIORITY 1: SURVIVAL ---
        await handleAutoEat(); 

        // Sleep Logic
        if (sleepMode === 'force' || (sleepMode === 'auto' && !bot.time.isDay)) {
            await handleSleep();
            if (bot.isSleeping) return;
        }

        // --- PRIORITY 2: COMBAT ---
        const nearbyMob = getHostileMob();
        if (nearbyMob && botMode !== 'afk') {
            await handleAdvancedCombat(nearbyMob);
            return;
        }

        // --- PRIORITY 3: FARMING & CRAFTING (Normal Mode Only) ---
        if (botMode === 'normal') {
            // Craft Bread
            const wheatCount = bot.inventory.count(mcData.itemsByName.wheat.id);
            if (wheatCount >= 3) {
                const crafted = await craftBread();
                if (crafted) return; 
            }

            // Farm Wheat
            const farmAction = await performFarming();
            if (farmAction) return; 
        }

        // --- PRIORITY 4: IDLE / WANDER ---
        if (botMode === 'afk') {
            wander();
            return;
        }

        // Random idle behavior
        const chance = Math.random();
        if (chance < 0.05) { await randomInventoryShuffle(); return; }
        if (chance < 0.15) { return; } // Stand still
        
        wander();
    }, 3000); 
}

function stopBrain() {
    if (brainInterval) clearInterval(brainInterval);
    if (lookInterval) clearInterval(lookInterval);
    brainInterval = null;
    lookInterval = null;
}

// --- 6. New & Upgraded Capabilities ---

// UPGRADE: Advanced Combat (Crit + Shield)
async function handleAdvancedCombat(target) {
    if (!target) return;

    // Equip Sword or Axe
    const weapon = bot.inventory.items().find(item => item.name.includes('sword') || item.name.includes('axe'));
    if (weapon) await bot.equip(weapon, 'hand');

    // Equip Shield
    const shield = bot.inventory.items().find(item => item.name.includes('shield'));
    if (shield) await bot.equip(shield, 'off-hand');

    const dist = bot.entity.position.distanceTo(target.position);

    // If close enough to hit
    if (dist < 3.5) {
        // Critical Hit Logic: Jump before attacking
        if (bot.entity.onGround) {
            bot.setControlState('jump', true);
            bot.setControlState('jump', false); // Tap jump
        }
        await bot.pvp.attack(target);
    } else {
        // Chase target
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
        
        // Shield Block Logic
        if (shield && dist < 5) {
            bot.activateItem(true); // Raise shield
        } else {
            bot.deactivateItem(); // Lower shield
        }
    }
}

// UPGRADE: Farming (Fixed for 1.21)
async function performFarming() {
    // 1. Find Mature Wheat (Age 7) using Properties
    const wheatBlock = bot.findBlock({
        matching: (block) => {
            if (block.name !== 'wheat') return false;
            // In 1.21, we must check properties, not metadata!
            const props = block.getProperties();
            return props && props.age === 7;
        },
        maxDistance: 20
    });

    if (wheatBlock) {
        try {
            // Move NEAR the block (easier to break)
            await bot.pathfinder.goto(new goals.GoalNear(wheatBlock.position.x, wheatBlock.position.y, wheatBlock.position.z, 1));
            
            // Break it
            await bot.dig(wheatBlock);
            
            // Wait for drops to exist
            await bot.waitForTicks(10); 

            // Replant Logic
            const seeds = bot.inventory.items().find(item => item.name.includes('seeds'));
            if (seeds) {
                await bot.equip(seeds, 'hand');
                const farmland = bot.blockAt(wheatBlock.position.offset(0, -1, 0));
                
                if (farmland && farmland.name === 'farmland') {
                    await bot.placeBlock(farmland, { x: 0, y: 1, z: 0 });
                }
            }
            return true; 
        } catch (e) {
            console.log("Farming error:", e.message);
        }
    }
    return false;
}

// UPGRADE: Crafting (Bread)
async function craftBread() {
    const table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 });
    if (!table) return false;

    const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, table)[0];
    if (!recipe) return false;

    try {
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 1));
        await bot.craft(recipe, 1, table);
        bot.chat("I baked some bread!");
        return true;
    } catch (e) { return false; }
}

// UPGRADE: Auto Eat
async function handleAutoEat() {
    if (bot.food < 16) { 
        const food = bot.inventory.items().find(item => item.foodPoints > 0);
        if (food) {
            try {
                await bot.equip(food, 'hand');
                await bot.consume();
            } catch (e) {}
        }
    }
}

// --- 7. Standard Actions ---

async function handleSleep() {
    if (sleepMode === 'deny') return;

    let bedBlock = bot.findBlock({ matching: bl => bot.isABed(bl), maxDistance: 32 });
    
    // Only place bed if Normal Mode AND Nomad Mode are ON
    if (!bedBlock && botMode === 'normal' && nomadMode === true) {
        const bedItem = bot.inventory.items().find(item => item.name.includes('bed'));
        if (bedItem) bedBlock = await placeBed(bedItem);
    }

    if (bedBlock) {
        try {
            await bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1));
            if ((!bot.time.isDay && !bot.isRaining) || sleepMode === 'force') {
                await bot.sleep(bedBlock);
                bot.chat("Goodnight!");
            }
        } catch (e) {}
    }
}

async function placeBed(bedItem) {
    const center = bot.entity.position;
    for (let x = -5; x <= 5; x++) {
        for (let y = -2; y <= 2; y++) {
            for (let z = -5; z <= 5; z++) {
                const footPos = center.offset(x, y, z).floored();
                const footBlock = bot.blockAt(footPos);
                if (footBlock.boundingBox !== 'block') continue;
                
                const headPos = footPos.offset(0, 0, 1);
                if (bot.blockAt(headPos).boundingBox !== 'block') { 
                     try {
                        await bot.equip(bedItem, 'hand');
                        await bot.placeBlock(footBlock, { x: 0, y: 1, z: 0 });
                        lastBedPosition = footPos.offset(0, 1, 0); 
                        return bot.blockAt(lastBedPosition);
                    } catch (e) {}
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

function wander() {
    const r = 10; 
    const pos = bot.entity.position.offset((Math.random() - 0.5) * r, 0, (Math.random() - 0.5) * r);
    if (Math.random() < 0.3) bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 500);
    try { bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1)); } catch(e) {}
}

// --- 8. Command Handler ---
function handleCommand(username, message) {
    if (config.master && username !== config.master) return;
    const msg = message.toLowerCase();

    // STATUS
    if (msg.includes('status')) {
        bot.chat(`Mode: ${botMode} | Sleep: ${sleepMode} | Nomad(Beds): ${nomadMode ? 'ON' : 'OFF'}`);
    }

    // BEHAVIOR MODES
    if (msg === 'afk on') { 
        botMode = 'afk'; 
        bot.chat("AFK Mode: I will just chill."); 
    }
    if (msg === 'afk off') { 
        botMode = 'normal'; 
        bot.chat("Normal Mode: Farming and Fighting enabled."); 
    }

    // NOMAD (Building) MODES
    if (msg === 'nomad on') {
        nomadMode = true;
        bot.chat("Nomad Mode ON: I will place and break beds.");
    }
    if (msg === 'nomad off') {
        nomadMode = false;
        bot.chat("Nomad Mode OFF: I will only sleep in existing beds.");
    }

    // SLEEP CONTROLS
    if (msg === 'sleep') { sleepMode = 'force'; handleSleep(); }
    if (msg === 'wakeup') { sleepMode = 'deny'; if(bot.isSleeping) bot.wake(); }
    if (msg === 'autosleep') { sleepMode = 'auto'; bot.chat("Sleep set to Auto."); }

    // UTILITY
    if (msg === 'drop inv') { 
        bot.inventory.items().forEach(item => bot.tossStack(item)); 
        bot.chat("I dropped everything.");
    }
}

// --- 9. Bot Lifecycle ---

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
            version: config.version
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
        mcData = mcdataPkg(bot.version);
        
        bot.waitForChunksToLoad().then(() => {
            console.log('[WORLD] Chunks loaded. Brain active.');
            const moves = new Movements(bot, mcData);
            moves.canDig = true;
            moves.canOpenDoors = true; 
            bot.pathfinder.setMovements(moves);
            startBrain();
        });
    });

    bot.on('chat', (username, message) => { if (username !== bot.username) handleCommand(username, message); });
    bot.on('whisper', (username, message) => { if (username !== bot.username) handleCommand(username, message); });
    
    // Wake up event: Only break bed if Nomad Mode is ON
    bot.on('wake', async () => {
        if (lastBedPosition && bot.time.isDay && botMode === 'normal' && nomadMode === true) {
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

    bot.on('kicked', (reason) => { console.log(`[KICKED] ${JSON.stringify(reason)}`); reconnect('kicked'); });
    bot.on('error', (err) => { if(!err.message.includes('PartialReadError')) console.log(`[ERROR] ${err.message}`); reconnect('error'); });
    bot.on('end', () => { console.log('[END] Disconnected.'); reconnect('end'); });
}

function reconnect(reason) {
    stopBrain();
    isStarting = false;
    if (bot) { bot.removeAllListeners(); bot = null; }
    const delay = reason === 'duplicate' ? 60000 : 10000;
    console.log(`[RETRY] Reconnecting in ${delay/1000}s...`);
    setTimeout(startBot, delay);
}

startBot();
