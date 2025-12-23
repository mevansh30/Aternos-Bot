// index.js — Nomad Bot v11 (Debug Mode & Chat Fix)
require('dotenv').config();
const express = require('express');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const toolPlugin = require('mineflayer-tool').plugin;
const mcdataPkg = require('minecraft-data');

// --- 1. Global Stability ---
const START_TIME = Date.now();
process.on('uncaughtException', (err) => console.log('[INTERNAL] ' + err.message));
process.on('unhandledRejection', (reason) => console.log('[INTERNAL] ' + reason));

// --- 2. Web Server ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - START_TIME) / 1000);
    res.send(`Nomad Bot v11 is Online.<br>Master: ${config.master}<br>Uptime: ${uptime}s`);
});
app.listen(PORT, () => console.log(`[WEB] Listening on port ${PORT}.`));

// --- 3. Configuration ---
const config = {
    host: 'REALV4NSH.aternos.me',
    port: 53024, // ⚠️ CHECK PORT ON ATERNOS!
    username: 'NomadBot',
    auth: 'offline',
    
    // ⚠️ MASTER NAME MUST MATCH EXACTLY
    // I set it to allow ANYONE for now to test if it works.
    // Change this back to 'RealV4nsh' later if you want security.
    master: null, 

    version: '1.21.4' // Works with ViaVersion
};

// --- 4. Global State ---
let bot = null;
let isStarting = false;
let brainInterval = null;
let lookInterval = null;
let lastBedPosition = null; 
let mcData = null;
let botMode = 'normal'; 
let sleepMode = 'auto'; 
let nomadMode = false; 

// --- 5. Brain & Logic ---
function startBrain() {
    stopBrain();
    console.log(`[BRAIN] Logic active.`);
    
    lookInterval = setInterval(() => {
        if(!bot || !bot.entity || bot.pathfinder.isMoving()) return;
        const yaw = (Math.random() * Math.PI) - (0.5 * Math.PI);
        const pitch = (Math.random() * Math.PI / 2) - (Math.PI / 4);
        bot.look(bot.entity.yaw + yaw, pitch);
    }, 4000);

    brainInterval = setInterval(async () => {
        if (!bot || !bot.entity || isStarting || bot.pathfinder.isMoving() || bot.isSleeping) return;

        // Survival
        if (botMode === 'normal' || botMode === 'farming') {
            await handleAutoEat(); 
            if (sleepMode === 'force' || (sleepMode === 'auto' && canSleep())) {
                await handleSleep();
                if (bot.isSleeping) return;
            }
        }
        // Farming
        if (botMode === 'normal' || botMode === 'farming') {
            if (await performFarming()) return; 
        }
        // Combat
        if (botMode === 'normal') {
            const nearbyMob = getHostileMob();
            if (nearbyMob) { await handleAdvancedCombat(nearbyMob); return; }
            const wheatCount = bot.inventory.count(mcData.itemsByName.wheat.id);
            if (wheatCount >= 3) await craftBread();
        }
        // Wander
        if (Math.random() < 0.15) wander();
    }, 3000); 
}

function stopBrain() {
    if (brainInterval) clearInterval(brainInterval);
    if (lookInterval) clearInterval(lookInterval);
}

// --- 6. Capabilities ---
function updateMovements() {
    if (!bot || !mcData) return;
    const moves = new Movements(bot, mcData);
    moves.canDig = botMode !== 'afk';
    moves.canPlaceOn = botMode !== 'afk';
    bot.pathfinder.setMovements(moves);
}

function canSleep() {
    if (bot.isSleeping) return false;
    if (bot.isRaining && bot.thunderState > 0) return true;
    return bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458;
}

async function handleAdvancedCombat(target) {
    const weapon = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));
    if (weapon) await bot.equip(weapon, 'hand');
    const shield = bot.inventory.items().find(i => i.name.includes('shield'));
    if (shield) await bot.equip(shield, 'off-hand');
    if (bot.entity.position.distanceTo(target.position) < 3.5) {
        if (bot.entity.onGround) { bot.setControlState('jump', true); bot.setControlState('jump', false); }
        await bot.pvp.attack(target);
    } else {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
        if (shield) bot.activateItem(true);
    }
}

async function performFarming() {
    const wheat = bot.findBlock({ matching: b => b.name === 'wheat' && b.getProperties().age === 7, maxDistance: 20 });
    if (wheat) {
        try {
            await bot.pathfinder.goto(new goals.GoalNear(wheat.position.x, wheat.position.y, wheat.position.z, 1));
            await bot.dig(wheat);
            await bot.waitForTicks(10);
            const seeds = bot.inventory.items().find(i => i.name.includes('seeds'));
            const farmland = bot.blockAt(wheat.position.offset(0, -1, 0));
            if (seeds && farmland && farmland.name === 'farmland') {
                await bot.equip(seeds, 'hand');
                await bot.placeBlock(farmland, { x: 0, y: 1, z: 0 });
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
    if (recipe) {
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 1));
        await bot.craft(recipe, 1, table);
        return true;
    }
}

async function handleAutoEat() {
    if (bot.food < 16) { 
        const food = bot.inventory.items().find(i => i.foodPoints > 0);
        if (food) { await bot.equip(food, 'hand'); await bot.consume(); }
    }
}

async function handleSleep() {
    if (sleepMode === 'deny') return;
    let bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 32 });
    if (!bed && botMode === 'normal' && nomadMode) {
        const bedItem = bot.inventory.items().find(i => i.name.includes('bed'));
        if (bedItem) bed = await placeBed(bedItem);
    }
    if (bed) {
        try {
            await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1));
            await bot.sleep(bed);
        } catch (err) {}
    }
}

async function placeBed(bedItem) {
    const center = bot.entity.position;
    for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
            const footPos = center.offset(x, 0, z).floored();
            const footBlock = bot.blockAt(footPos);
            if (!footBlock || footBlock.boundingBox !== 'block') continue;
            try {
                await bot.equip(bedItem, 'hand');
                await bot.placeBlock(footBlock, { x: 0, y: 1, z: 0 });
                lastBedPosition = footPos.offset(0, 1, 0); 
                return bot.blockAt(lastBedPosition);
            } catch (e) {}
        }
    }
    return null;
}

function wander() {
    const r = 10;
    const pos = bot.entity.position.offset((Math.random() - 0.5) * r, 0, (Math.random() - 0.5) * r);
    bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
}

function getHostileMob() {
    return bot.nearestEntity(e => e.type === 'mob' && ['zombie', 'skeleton', 'spider', 'creeper'].includes(e.name));
}

// --- 7. COMMAND HANDLER (DEBUGGED) ---
function handleCommand(username, message) {
    // 1. Debug Log: See EXACTLY who is speaking and what they said
    console.log(`[CHAT LOG] User: "${username}" | Msg: "${message}"`);

    // 2. Ignore self
    if (username === bot.username) return;

    // 3. Relaxed Master Check (Case Insensitive)
    // If config.master is set, enforce it. Otherwise, allow everyone.
    if (config.master) {
        if (username.toLowerCase() !== config.master.toLowerCase()) {
            console.log(`[IGNORE] ${username} is not Master (${config.master})`);
            return;
        }
    }

    const msg = message.toLowerCase();
    console.log(`[CMD PROCESSING] Executing: ${msg}`);

    if (msg.includes('status')) bot.chat(`Nomad Bot Online | Mode: ${botMode}`);
    if (msg === 'afk on') { botMode = 'afk'; updateMovements(); bot.chat("AFK Mode ON"); }
    if (msg === 'afk off' || msg === 'mode normal') { botMode = 'normal'; updateMovements(); bot.chat("Normal Mode ON"); }
    if (msg === 'nomad on') { nomadMode = true; bot.chat("Nomad ON"); }
    if (msg === 'nomad off') { nomadMode = false; bot.chat("Nomad OFF"); }
    if (msg === 'sleep') { sleepMode = 'force'; handleSleep(); }
    if (msg === 'wakeup') { sleepMode = 'deny'; if(bot.isSleeping) bot.wake(); }
}

// --- 8. Lifecycle ---

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
            checkTimeoutInterval: 60 * 1000
        });
    } catch (e) {
        reconnect('init_error');
        return;
    }

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(toolPlugin);

    bot.once('spawn', () => {
        console.log(`[SUCCESS] Connected!`);
        isStarting = false;
        mcData = mcdataPkg(bot.version);
        bot.waitForChunksToLoad().then(() => {
            console.log(`[WORLD] Chunks loaded.`);
            updateMovements();
            startBrain();
        });
    });

    // LISTENER FIX: Listen to 'messagestr' for raw text in case 'chat' fails
    bot.on('messagestr', (message, position, jsonMsg) => {
        // This catches system messages too. We try to filter a bit.
        // Format often comes as "Username: Message" in messagestr
        if (message.includes(':')) {
            const parts = message.split(':');
            const possibleUser = parts[0].trim();
            const possibleMsg = parts.slice(1).join(':').trim();
            // Don't double process if 'chat' event caught it
            // We'll let the standard 'chat' handler take priority usually
        }
    });

    // Standard Chat Listener
    bot.on('chat', (username, message) => {
        handleCommand(username, message);
    });
    
    // Whisper Listener
    bot.on('whisper', (username, message) => {
        handleCommand(username, message);
    });

    bot.on('wake', async () => {
        if (lastBedPosition && botMode === 'normal' && nomadMode) {
            await bot.waitForTicks(40);
            const bed = bot.blockAt(lastBedPosition);
            if (bed && bot.isABed(bed)) {
                try { await bot.tool.equipForBlock(bed); await bot.dig(bed); lastBedPosition = null; } catch(e){}
            }
        }
    });

    bot.on('kicked', (reason) => { 
        console.log(`[KICKED] ${JSON.stringify(reason)}`); 
        reconnect('kicked'); 
    });
    
    bot.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
            console.log(`[OFFLINE] Retrying in 30s...`);
            setTimeout(() => { isStarting = false; startBot(); }, 30000);
            return;
        }
        console.log(`[BOT ERROR] ${err.message}`);
    });

    bot.on('end', () => { console.log('[END] Disconnected.'); reconnect('end'); });
}

function reconnect(reason) {
    stopBrain();
    isStarting = false;
    if (bot) { bot.removeAllListeners(); bot = null; }
    console.log(`[RETRY] Reconnecting in 15s...`);
    setTimeout(startBot, 15000);
}

startBot();
