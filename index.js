// index.js — Human-Like Nomad Bot v7 (PaperMC 1.21.11 Support)
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

// --- 2. Web Server (Keep-Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - START_TIME) / 1000);
    const status = bot ? 'Online' : 'Offline/Reconnecting';
    res.send(`Nomad Bot v7 is ${status}.<br>Mode: ${botMode}<br>Uptime: ${uptime}s.`);
});

app.get('/rejoin', (req, res) => {
    res.send("Forcing bot to rejoin server...");
    if (bot) bot.end();
    else startBot();
});

app.listen(PORT, () => console.log(`[WEB] Listening on port ${PORT}.`));

// --- 3. Configuration ---
const config = {
    // UPDATED: Your specific Aternos address
    host: 'REALV4NSH.aternos.me',
    port: 53024, // WARNING: Check this port on Aternos every time you start the server!
    username: 'NomadBot',
    auth: 'offline', // Using offline mode (cracked) since it's Aternos
    
    // VERSION FIX: 'false' allows the bot to auto-match the server's 1.21.11 version
    version: false, 
    
    master: process.env.BOT_MASTER || 'RealV4nsh' // Set your in-game name here to be the only one who can command it
};

// --- 4. Global Bot State ---
let bot = null;
let isStarting = false;
let brainInterval = null;
let lookInterval = null;
let lastBedPosition = null; 
let mcData = null;

// SETTINGS & MODES
let botMode = 'normal'; // 'normal', 'farming', 'afk'
let sleepMode = 'auto'; // 'auto', 'force', 'deny'
let nomadMode = false;  // If true, bot places/breaks its own bed (Nomad style)

// --- 5. The Brain (AI Logic) ---
function startBrain() {
    stopBrain();
    
    // Feature: Human-like Head Looking (Anti-AFK detection)
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
        if (bot.isSleeping) return; // Don't think while sleeping

        // --- PRIORITY 1: SURVIVAL (Eat/Sleep) ---
        if (botMode === 'normal' || botMode === 'farming') {
            await handleAutoEat(); 

            // Improved Sleep Check (Fixes broken sleep logic)
            if (sleepMode === 'force' || (sleepMode === 'auto' && canSleep())) {
                await handleSleep();
                if (bot.isSleeping) return;
            }
        }

        // --- PRIORITY 2: FARMING ---
        if (botMode === 'normal' || botMode === 'farming') {
            const farmAction = await performFarming();
            if (farmAction) return; // Busy farming
        }

        // --- PRIORITY 3: COMBAT & CRAFTING ---
        if (botMode === 'normal') {
            const nearbyMob = getHostileMob();
            if (nearbyMob) {
                await handleAdvancedCombat(nearbyMob);
                return;
            }

            const wheatCount = bot.inventory.count(mcData.itemsByName.wheat.id);
            if (wheatCount >= 3) {
                const crafted = await craftBread();
                if (crafted) return; 
            }
        }

        // --- PRIORITY 4: WANDER ---
        // Prevents getting kicked for AFK
        const chance = Math.random();
        if (chance < 0.05) { await randomInventoryShuffle(); return; }
        if (chance < 0.15) { return; } 
        
        wander();
    }, 3000); 
}

function stopBrain() {
    if (brainInterval) clearInterval(brainInterval);
    if (lookInterval) clearInterval(lookInterval);
    brainInterval = null;
    lookInterval = null;
}

// --- 6. Capabilities ---

function updateMovements() {
    if (!bot || !mcData) return;
    const moves = new Movements(bot, mcData);
    
    if (botMode === 'afk') {
        moves.canDig = false;
        moves.canPlaceOn = false;
        moves.canOpenDoors = true; 
    } else {
        moves.canDig = true;
        moves.canPlaceOn = true;
        moves.canOpenDoors = true;
    }
    bot.pathfinder.setMovements(moves);
}

// FIXED: Better sleep condition check
function canSleep() {
    if (bot.isSleeping) return false;
    if (bot.isRaining && bot.thunderState > 0) return true; // Can sleep during thunderstorm
    const isNight = bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458;
    return isNight;
}

async function handleAdvancedCombat(target) {
    if (!target) return;
    const weapon = bot.inventory.items().find(item => item.name.includes('sword') || item.name.includes('axe'));
    if (weapon) await bot.equip(weapon, 'hand');
    const shield = bot.inventory.items().find(item => item.name.includes('shield'));
    if (shield) await bot.equip(shield, 'off-hand');

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist < 3.5) {
        if (bot.entity.onGround) {
            bot.setControlState('jump', true); // Critical hit
            bot.setControlState('jump', false); 
        }
        await bot.pvp.attack(target);
    } else {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
        if (shield && dist < 5) bot.activateItem(true);
        else bot.deactivateItem();
    }
}

async function performFarming() {
    const wheatBlock = bot.findBlock({
        matching: (block) => {
            if (block.name !== 'wheat') return false;
            const props = block.getProperties();
            return props && props.age === 7; // Max age
        },
        maxDistance: 20
    });

    if (wheatBlock) {
        try {
            await bot.pathfinder.goto(new goals.GoalNear(wheatBlock.position.x, wheatBlock.position.y, wheatBlock.position.z, 1));
            await bot.dig(wheatBlock);
            await bot.waitForTicks(10); 
            const seeds = bot.inventory.items().find(item => item.name.includes('seeds'));
            if (seeds) {
                await bot.equip(seeds, 'hand');
                const farmland = bot.blockAt(wheatBlock.position.offset(0, -1, 0));
                if (farmland && farmland.name === 'farmland') {
                    await bot.placeBlock(farmland, { x: 0, y: 1, z: 0 });
                }
            }
            return true; 
        } catch (e) {}
    }
    return false;
}

async function craftBread() {
    const table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 });
    if (!table) return false;
    const recipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, table)[0];
    if (!recipe) return false;
    try {
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 1));
        await bot.craft(recipe, 1, table);
        return true;
    } catch (e) { return false; }
}

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

async function handleSleep() {
    if (sleepMode === 'deny') return;
    
    // Find nearby bed
    let bedBlock = bot.findBlock({ matching: bl => bot.isABed(bl), maxDistance: 32 });
    
    // Nomad Mode: Place bed if none found
    if (!bedBlock && botMode === 'normal' && nomadMode === true) {
        const bedItem = bot.inventory.items().find(item => item.name.includes('bed'));
        if (bedItem) bedBlock = await placeBed(bedItem);
    }

    if (bedBlock) {
        try {
            // Move to bed first
            if (bot.entity.position.distanceTo(bedBlock.position) > 2) {
                 await bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1));
            }
            
            // Attempt Sleep
            await bot.sleep(bedBlock);
            bot.chat("Zzz...");
        } catch (err) {
            if (err.message.includes('monsters')) {
                bot.chat("Monsters nearby, cannot sleep.");
            } else if (!err.message.includes('not night')) {
                console.log(`[SLEEP ERROR] ${err.message}`);
            }
        }
    }
}

async function placeBed(bedItem) {
    const center = bot.entity.position;
    // Scan small area for flat ground
    for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
            const footPos = center.offset(x, 0, z).floored();
            const footBlock = bot.blockAt(footPos);
            // Check if block below is solid
            if (!footBlock || footBlock.boundingBox !== 'block') continue;

            // Check space for bed (2 blocks air)
            const headPos = footPos.offset(0, 0, 1);
            const air1 = bot.blockAt(footPos.offset(0, 1, 0));
            const air2 = bot.blockAt(headPos.offset(0, 1, 0));
            
            if (air1.boundingBox !== 'block' && air2.boundingBox !== 'block') {
                 try {
                    await bot.equip(bedItem, 'hand');
                    await bot.placeBlock(footBlock, { x: 0, y: 1, z: 0 });
                    lastBedPosition = footPos.offset(0, 1, 0); 
                    return bot.blockAt(lastBedPosition);
                } catch (e) {
                    console.log("[BED PLACE FAIL] " + e.message);
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

// --- 7. Command Handler ---
function handleCommand(username, message) {
    if (config.master && username !== config.master) return;
    const msg = message.toLowerCase();

    if (msg.includes('status')) {
        bot.chat(`Mode: ${botMode.toUpperCase()} | Nomad: ${nomadMode} | Sleep: ${sleepMode}`);
    }

    if (msg === 'afk on') { 
        botMode = 'afk'; 
        updateMovements();
        bot.chat("Mode: AFK (Passive)."); 
    }
    if (msg === 'mode farming') { 
        botMode = 'farming'; 
        updateMovements();
        bot.chat("Mode: Farming Only (Peaceful)."); 
    }
    if (msg === 'mode normal' || msg === 'afk off') { 
        botMode = 'normal'; 
        updateMovements();
        bot.chat("Mode: Normal (Full Features)."); 
    }

    if (msg === 'nomad on') { nomadMode = true; bot.chat("Nomad: ON"); }
    if (msg === 'nomad off') { nomadMode = false; bot.chat("Nomad: OFF"); }
    if (msg === 'sleep') { sleepMode = 'force'; handleSleep(); }
    if (msg === 'wakeup') { sleepMode = 'deny'; if(bot.isSleeping) bot.wake(); }
    if (msg === 'autosleep') { sleepMode = 'auto'; bot.chat("Sleep: Auto"); }
    if (msg === 'drop inv') { bot.inventory.items().forEach(i => bot.tossStack(i)); }
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
            version: config.version, // Auto-detect version
            checkTimeoutInterval: 60 * 1000 // Extended timeout for Aternos lag
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
        // Load data based on the DETECTED version, not the config
        mcData = mcdataPkg(bot.version); 
        
        bot.waitForChunksToLoad().then(() => {
            console.log(`[WORLD] Chunks loaded. Version: ${bot.version}`);
            updateMovements();
            startBrain();
        });
    });

    bot.on('chat', (username, message) => { if (username !== bot.username) handleCommand(username, message); });
    bot.on('whisper', (username, message) => { if (username !== bot.username) handleCommand(username, message); });
    
    // FIXED: Nomad Bed Logic (prevents breaking bed too early)
    bot.on('wake', async () => {
        if (lastBedPosition && botMode === 'normal' && nomadMode === true) {
            await bot.waitForTicks(40); // Wait 2s for wake animation to finish
            
            const bedBlock = bot.blockAt(lastBedPosition);
            if (bedBlock && bot.isABed(bedBlock)) {
                try {
                    await bot.tool.equipForBlock(bedBlock);
                    await bot.dig(bedBlock);
                    lastBedPosition = null; 
                    console.log("[NOMAD] Bed collected.");
                } catch (e) {
                    console.log("[NOMAD] Failed to collect bed: " + e.message);
                }
            }
        }
    });

    bot.on('kicked', (reason) => { console.log(`[KICKED] ${JSON.stringify(reason)}`); reconnect('kicked'); });
    bot.on('error', (err) => { 
        if(!err.message.includes('PartialReadError')) console.log(`[ERROR] ${err.message}`); 
    });
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
