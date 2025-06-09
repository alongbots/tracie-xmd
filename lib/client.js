const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    makeWASocket,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion 
} = require('baileys');
const patchLidSupport = require('./lidpatch'); 
const chalk = require('chalk');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const crypto = require('crypto');
const NodeCache = require("node-cache");
const { HttpsProxyAgent } = require('https-proxy-agent');
const { lightningCache, cacheHelpers } = require('./cache');
const { File } = require("megajs");

// Initialize modules
const { serializeMessage } = require('./serialize');
const { loadCommands } = require('./cmd');
const handleMessage = require('./handlemessage');
const { setupAd } = require('./antidelete');
const conn = require('./mongodb');
const { initializeStore } = require('./database/sql_init');
const config = require('../config');
const { user } = require("./economy");

// Global variables
const cache = lightningCache.mediaCache;
global.sock = null;

// Connection state management
let connectionState = {
    isConnected: false,
    lastConnected: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5
};

// Logging utility
const logger = {
    info: (msg, data = '') => console.log(chalk.blue('ℹ️ '), chalk.white(msg), data),
    success: (msg, data = '') => console.log(chalk.green('✅'), chalk.white(msg), data),
    warning: (msg, data = '') => console.log(chalk.yellow('⚠️ '), chalk.white(msg), data),
    error: (msg, error = '') => console.log(chalk.red('❌'), chalk.white(msg), error?.message || error),
    cache: (msg, data = '') => console.log(chalk.cyan('⚡'), chalk.white(msg), data)
};

// Session management
async function handleSessionSetup() {
    const sessionPath = "./lib/session/";
    const credsPath = sessionPath + "creds.json";
    const sessionPrefix = "TRACIE-X";

    try {
        // Skip if QR mode is enabled or creds already exist
        if (config.PRINT_QR || fs.existsSync(credsPath)) {
            return logger.info("Session setup skipped - QR mode or existing session");
        }

        // Validate session ID
        if (!config.SESSION_ID?.startsWith(sessionPrefix)) {
            throw new Error("Invalid session ID format. Must start with " + sessionPrefix);
        }

        logger.info("Downloading session from MEGA...");
        
        // Extract MEGA URL and download
        const megaId = config.SESSION_ID.replace(sessionPrefix, "");
        const megaUrl = `https://mega.nz/file/${megaId}`;
        const file = File.fromURL(megaUrl);
        
        await file.loadAttributes();
        
        // Ensure directory exists
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }
        
        // Download and save session
        const sessionData = await file.downloadBuffer();
        fs.writeFileSync(credsPath, sessionData);
        
        logger.success("Session downloaded successfully");
        
    } catch (error) {
        logger.error("Session setup failed:", error);
        throw error;
    }
}

// Connection event handlers
function setupConnectionHandlers(sock, saveCreds) {
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Handle QR code display
        if (qr && config.PRINT_QR) {
            const QRCode = require('qrcode-terminal');
            QRCode.generate(qr, { small: true });
            logger.info("QR Code generated - scan to connect");
        }

        // Handle connection close
        if (connection === 'close') {
            await handleDisconnection(lastDisconnect);
        }

        // Handle successful connection
        if (connection === 'open') {
            await handleSuccessfulConnection(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function handleDisconnection(lastDisconnect) {
    connectionState.isConnected = false;
    connectionState.reconnectAttempts++;
    
    const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
    const reasonText = getDisconnectReason(reason);
    
    logger.warning(`Connection closed: ${reasonText}`);
    
    // Handle specific disconnect reasons
    switch (reason) {
        case DisconnectReason.badSession:
        case DisconnectReason.loggedOut:
            logger.warning("Clearing session due to bad session/logout");
            try {
                fs.rmSync('./lib/session', { recursive: true, force: true });
                cacheHelpers.clearCache('all');
            } catch (error) {
                logger.error("Error clearing session:", error);
            }
            break;
        default:
            break;
    }
    
    // Emergency cache clear on too many reconnections
    if (connectionState.reconnectAttempts > connectionState.maxReconnectAttempts) {
        logger.warning("Too many reconnection attempts - clearing cache");
        lightningCache.emergencyClear();
        connectionState.reconnectAttempts = 0;
    }
    
    // Reconnect with delay
    logger.info(`Reconnecting... (Attempt ${connectionState.reconnectAttempts})`);
    setTimeout(() => startTracie(), 5000);
}

async function handleSuccessfulConnection(sock) {
    connectionState.isConnected = true;
    connectionState.lastConnected = Date.now();
    connectionState.reconnectAttempts = 0;
    
    const jid = sock.user.id;
    const botName = sock.user.name || 'Tracie Bot';
    
    logger.success(`Connected as: ${botName} (${jid})`);
    
    // Cache bot info
    cacheHelpers.cacheUser(jid, {
        id: jid,
        name: botName,
        isBot: true,
        connectedAt: Date.now()
    });
    
    try {
        // Send connection notification
        await sock.sendMessage(jid, {
            image: { url: 'https://files.catbox.moe/z0k3fv.jpg' },
            caption: `Tracie MD Connected Successfully\n⚡ Lightning Cache: ENABLED\n🕒 ${new Date().toLocaleString()}`,
        });
        
        logger.success("Connection notification sent");
    } catch (error) {
        logger.error("Failed to send connection notification:", error);
    }
}

function getDisconnectReason(code) {
    const reasons = {
        [DisconnectReason.badSession]: 'Bad Session',
        [DisconnectReason.connectionClosed]: 'Connection Closed',
        [DisconnectReason.connectionLost]: 'Connection Lost',
        [DisconnectReason.connectionReplaced]: 'Connection Replaced',
        [DisconnectReason.loggedOut]: 'Logged Out',
        [DisconnectReason.restartRequired]: 'Restart Required',
        [DisconnectReason.timedOut]: 'Timed Out'
    };
    return reasons[code] || `Unknown (${code})`;
}

// Message handling
function setupMessageHandlers(sock) {
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (m.type !== 'notify' || !msg) return;

            const msgId = msg.key.id;
            if (cacheHelpers.isMessageDuplicate(msgId)) return;

            const serialized = serializeMessage(msg, sock);
            if (!serialized) return;

            // Update user cache
            await updateUserCache(msg, serialized);
            
            // Log message info
            logIncomingMessage(msg);

            // Handle the message
            await handleMessage(serialized);
            
        } catch (error) {
            logger.error('Message processing error:', error);
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        try {
            const relevantUpdates = updates.filter(
                update => update.update.message === null || update.update.messageStubType === 2
            );
            
            if (relevantUpdates.length === 0) return;

            const antideleteModule = await setupAd(sock, global.store);
            for (const update of relevantUpdates) {
                await antideleteModule.execute(sock, update, { store: global.store });
            }
        } catch (error) {
            logger.error('Message update handling error:', error);
        }
    });
}

async function updateUserCache(msg, serialized) {
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const pushname = msg.pushName || "Unknown";
    
    if (senderJid && !serialized.fromMe) {
        const existingUser = cacheHelpers.getUser(senderJid);
        const userData = {
            jid: senderJid,
            pushname,
            lastSeen: Date.now(),
            messageCount: (existingUser?.messageCount || 0) + 1
        };
        
        cacheHelpers.cacheUser(senderJid, userData);
    }
}

function logIncomingMessage(msg) {
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const jid = msg.key.remoteJid || "Unknown";
    const pushname = msg.pushName || "Unknown";
    const timestamp = new Date((msg.messageTimestamp || Date.now()) * 1000).toLocaleString();
    const messageType = Object.keys(msg.message || {})[0] || "Unknown";

    console.log(
        chalk.blue('💌 Message') + chalk.gray(' [Cached]') + '\n' +
        chalk.green('   From: ') + chalk.yellow(pushname) + '\n' +
        chalk.green('   Chat: ') + chalk.cyan(jid) + '\n' +
        chalk.green('   Type: ') + chalk.red(messageType) + '\n' +
        chalk.green('   Time: ') + chalk.magenta(timestamp) + '\n' +
        chalk.gray('─'.repeat(40))
    );
}

// Group handling
function setupGroupHandlers(sock) {
    sock.ev.on('groups.update', async (events) => {
        const batchUpdates = [];
        
        for (const event of events) {
            try {
                let metadata = cacheHelpers.getGroup(event.id);
                
                if (!metadata) {
                    metadata = await sock.groupMetadata(event.id);
                }
                
                batchUpdates.push({ id: event.id, metadata });
            } catch (error) {
                logger.error(`Group update error (${event.id}):`, error);
            }
        }
        
        batchUpdates.forEach(({ id, metadata }) => {
            cacheHelpers.cacheGroup(id, metadata);
        });
        
        if (batchUpdates.length > 0) {
            logger.cache(`Updated ${batchUpdates.length} groups`);
        }
    });

    sock.ev.on('group-participants.update', async (event) => {
        try {
            let metadata = cacheHelpers.getGroup(event.id);
            
            if (!metadata) {
                metadata = await sock.groupMetadata(event.id);
            }
            
            if (event.participants) {
                event.participants.forEach(participant => {
                    const existingUser = cacheHelpers.getUser(participant);
                    if (existingUser) {
                        existingUser.lastGroupActivity = Date.now();
                        existingUser.groupAction = event.action;
                        cacheHelpers.cacheUser(participant, existingUser);
                    }
                });
            }
            
            cacheHelpers.cacheGroup(event.id, metadata);
        } catch (error) {
            logger.error('Group participant update error:', error);
        }
    });
}

// Periodic tasks
function setupPeriodicTasks(sock) {
    // Group caching interval
    setInterval(async () => {
        try {
            if (!connectionState.isConnected) return;
            
            const groups = await sock.groupFetchAllParticipating();
            
            Object.keys(groups).forEach(groupId => {
                cacheHelpers.cacheGroup(groupId, groups[groupId]);
            });
            
            logger.cache(`Cached ${Object.keys(groups).length} groups`);
        } catch (error) {
            logger.error('Group caching error:', error);
        }
    }, 60000); // Every minute

    // Cache stats logging
    setInterval(() => {
        const stats = cacheHelpers.getStats();
        const totalKeys = stats.messages.keys + stats.users.keys + stats.groups.keys + stats.commands.keys;
        const hitRate = Math.round((stats.messages.hits / (stats.messages.hits + stats.messages.misses)) * 100) || 0;
        const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        
        logger.cache('Stats:', { totalKeys, hitRate: `${hitRate}%`, memory: `${memoryUsage}MB` });
    }, 300000); // Every 5 minutes

    // Memory monitoring
    setInterval(() => {
        const memUsage = process.memoryUsage();
        const memUsageMB = memUsage.heapUsed / 1024 / 1024;
        
        if (memUsageMB > 500) {
            logger.warning(`High memory usage (${Math.round(memUsageMB)}MB) - cleaning cache`);
            lightningCache.emergencyClear();
        }
    }, 120000); // Every 2 minutes
}

// Main function
async function startTracie() {
    try {
        logger.info("Starting Tracie Bot...");
        
        // Set event emitter limit
        require("events").EventEmitter.defaultMaxListeners = 50;
        
        // Initialize core components
        const { version } = await fetchLatestBaileysVersion();
        logger.info(`Using Baileys version: ${version.join('.')}`);
        
        // Initialize all required modules
        await Promise.all([
            initializeStore(),
            conn(),
            user.initEconomy(),
            loadCommands()
        ]);
        logger.success("Core modules initialized");
        
        // Handle session setup
        await handleSessionSetup();
        
        // Setup authentication
        const { state, saveCreds } = await useMultiFileAuthState('./lib/session');
        
        // Create socket
        sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys),
            },
            agent: config.PROXY ? new HttpsProxyAgent(config.PROXY) : undefined,
            version,
            printQRInTerminal: config.PRINT_QR || false,
            keepAliveIntervalMs: 30000,
            logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
            browser: Browsers.macOS("Safari"),
            syncFullHistory: false, // Changed to false for better performance
            emitOwnEvents: true,
            generateHighQualityLinkPreview: true,
            linkPreviewImageThumbnailWidth: 1920,
            msgRetryCounterCache: cache,
            markOnlineOnConnect: true,
            mediaCache: cache,
            userDevicesCache: cache,
            callOfferCache: cache,
        });
        
        // Apply patches and bind store
        patchLidSupport(sock);
        global.store.bind(sock.ev);
        
        // Setup all event handlers
        setupConnectionHandlers(sock, saveCreds);
        setupMessageHandlers(sock);
        setupGroupHandlers(sock);
        
        // Setup periodic tasks
        setupPeriodicTasks(sock);
        
        logger.success("Tracie Bot setup completed");
        return sock;
        
    } catch (error) {
        logger.error("Failed to start Tracie Bot:", error);
        
        // Retry after delay
        setTimeout(() => {
            logger.info("Retrying bot startup...");
            startTracie();
        }, 10000);
    }
}

// Export globals
global.lightningCache = lightningCache;
global.cacheHelpers = cacheHelpers;

module.exports = { startTracie };