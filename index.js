import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} from '@whiskeysockets/baileys';
import { pino } from 'pino';
import chalk from 'chalk';

// Get __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------- Config ----------------
async function loadConfig() {
    const { config } = await import(`./config.js?update=${Date.now()}`);
    return config;
}

const config = await loadConfig();

// ---------------- Logger functions ----------------
const log = (message) => {
    console.log(chalk.cyanBright(`[PAIRING SERVER | ${config.prefix}] → ${message}`));
};

const errorLog = (message) => {
    console.error(chalk.red(`[PAIRING SERVER | ${config.prefix}] → ❌ ${message}`));
};

// ---------------- Session Setup ----------------
const SESSION_DIR = join(__dirname, 'session');
if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

// ---------------- Express App ----------------
const app = express();
app.use(express.json());

// Store active sockets and their states
const userSockets = new Map();
const pairingStates = new Map();

// ---------------- Utility functions ----------------
const getRandomColor = () => `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")}`;

// Clean up session after delay
const scheduleSessionCleanup = (phoneNumber, delay = 5 * 60 * 1000) => { // 5 minutes
    setTimeout(() => {
        const sessionDir = join(SESSION_DIR, phoneNumber);
        if (existsSync(sessionDir)) {
            rmSync(sessionDir, { recursive: true, force: true });
            log(`Auto-cleaned session for ${phoneNumber} after ${delay / 1000}s`);
        }
        userSockets.delete(phoneNumber);
        pairingStates.delete(phoneNumber);
    }, delay);
};

// ---------------- Socket Starter (Mimicking bot exactly) ----------------
async function startSocket(phoneNumber, res) {
    const sessionDir = join(SESSION_DIR, phoneNumber);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

    let authState;
    try {
        authState = await useMultiFileAuthState(sessionDir);
    } catch (e) {
        errorLog(`Session error for ${phoneNumber}. Starting fresh.`);
        rmSync(sessionDir, { recursive: true, force: true });
        mkdirSync(sessionDir, { recursive: true });
        authState = await useMultiFileAuthState(sessionDir);
    }

    const { version } = await fetchLatestBaileysVersion();
    log(`Using WhatsApp v${version.join('.')} for ${phoneNumber}`);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: authState.state,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        version: [2, 3000, 1023223821],
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: true,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true,
        browser: Browsers.ubuntu('Chrome'),
        getMessage: async () => ({}),
    });

    // Save credentials
    sock.ev.on('creds.update', authState.saveCreds);

    // Store socket
    userSockets.set(phoneNumber, sock);

    // Connection handler (exactly like bot)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const reason = lastDisconnect?.error?.output?.statusCode;

        switch (connection) {
            case "open":
                console.log(chalk.green(`✅ Connected for ${phoneNumber}`));
                
                // Wait a moment for creds to be fully written
                setTimeout(async () => {
                    try {
                        const credsPath = join(sessionDir, 'creds.json');
                        if (existsSync(credsPath)) {
                            const creds = readFileSync(credsPath, 'utf8');
                            const base64Creds = `Sano~${Buffer.from(creds).toString('base64')}`;
                            
                            // Send to bot user (owner)
                            const userId = sock.user?.id || config.owner;
                            await sock.sendMessage(userId, { text: base64Creds });
                            await sock.sendMessage(userId, { text: 'ꜱᴀɴᴏ ᴍᴅ ꜱᴇꜱꜱɪᴏɴ ɢᴇɴᴇʀᴀᴛɪᴏɴ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟ' });
                            await sock.sendMessage(userId, { text: `ᴘᴀɪʀ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟ ᴘᴜᴛ ᴀʙᴏᴠᴇ ꜱᴇꜱꜱɪᴏɴ ɪᴅ ɪɴ ᴄᴏɴꜰɪɢ.ᴊꜱ ᴛᴏ ᴘᴀɪʀ ᴀɴᴅ ꜱᴛᴀʀᴛ ʙᴏᴛ` });
                            
                            log(`Sent session credentials to ${userId}`);

                            // Update pairing state
                            pairingStates.set(phoneNumber, {
                                status: 'completed',
                                base64Creds,
                                timestamp: Date.now()
                            });

                            // Close socket immediately after sending
                            setTimeout(() => {
                                sock.end();
                                userSockets.delete(phoneNumber);
                                log(`Closed socket for ${phoneNumber} after sending session`);
                                
                                // Schedule cleanup
                                scheduleSessionCleanup(phoneNumber);
                            }, 2000);

                        } else {
                            errorLog(`No creds.json found for ${phoneNumber} after connection`);
                        }
                    } catch (error) {
                        errorLog(`Error processing connection for ${phoneNumber}: ${error.message}`);
                    }
                }, 1000);
                break;

            case "close":
                console.log(chalk.red(`⚠️ Lost connection for ${phoneNumber}. Reason: ${reason}`));
                if (reason === DisconnectReason.loggedOut || reason === 401) {
                    console.log(chalk.red(`❌ Authentication failed for ${phoneNumber}. Cleaning session.`));
                    userSockets.delete(phoneNumber);
                    pairingStates.delete(phoneNumber);
                    rmSync(sessionDir, { recursive: true, force: true });
                } else if (reason === DisconnectReason.forbidden || reason === 403) {
                    console.log(chalk.red(`🚫 Banned for ${phoneNumber}.`));
                    userSockets.delete(phoneNumber);
                    pairingStates.delete(phoneNumber);
                    rmSync(sessionDir, { recursive: true, force: true });
                } else {
                    // Don't retry automatically for pairing server
                    console.log(chalk.yellow(`🔄 Connection closed (${reason}) for ${phoneNumber}`));
                }
                break;

            case "connecting":
                console.log(chalk.yellow(`🔄 Connecting ${phoneNumber}...`));
                break;

            default:
                break;
        }
    });

    // Handle pairing (exactly like bot)
    if (!sock.authState.creds.registered) {
        try {
            // Request pairing code
            let code = await sock.requestPairingCode(phoneNumber);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            
            log(`Generated pairing code ${code} for ${phoneNumber}`);
            
            // Set initial pairing state
            pairingStates.set(phoneNumber, {
                status: 'pending',
                pairingCode: code,
                timestamp: Date.now()
            });

            // Return pairing code to client
            if (res && !res.headersSent) {
                res.json({ 
                    success: true,
                    pairingCode: code,
                    message: 'Enter this code in WhatsApp to complete pairing'
                });
            }

            // Set up connection monitoring (like in bot)
            const interval = setInterval(() => {
                if (sock.ws?.readyState === 1) {
                    sock.ws.ping?.();
                }
            }, 1500);

            // Monitor for completion
            const checkCompletion = () => {
                if (sock.authState.creds.registered) {
                    clearInterval(interval);
                    sock.ev.off('creds.update', checkCompletion);
                    log(`Pairing completed for ${phoneNumber}`);
                }
            };

            sock.ev.on('creds.update', checkCompletion);

        } catch (error) {
            errorLog(`Error generating pairing code for ${phoneNumber}: ${error.message}`);
            if (res && !res.headersSent) {
                res.status(500).json({ 
                    success: false,
                    error: 'Failed to generate pairing code' 
                });
            }
        }
    } else {
        if (res && !res.headersSent) {
            res.status(400).json({ 
                success: false,
                error: 'Phone number already registered' 
            });
        }
    }

    return sock;
}

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// Root route
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public/index.html'));
});

// ---------------- API Endpoints ----------------

// Pair endpoint
app.post('/pair', async (req, res) => {
    let { number } = req.body;
    
    if (!number || !/^\+?\d{10,15}$/.test(number)) {
        return res.status(400).json({ 
            success: false,
            error: 'Invalid phone number. Use format: 1234567890 or +1234567890' 
        });
    }

    // Clean number format
    number = number.replace(/^\+/, '');

    // Check if already pairing
    if (userSockets.has(number)) {
        return res.status(400).json({
            success: false,
            error: 'Pairing already in progress for this number'
        });
    }

    try {
        await startSocket(number, res);
    } catch (error) {
        errorLog(`Error starting socket for ${number}: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false,
                error: 'Internal server error' 
            });
        }
    }
});

// Check pairing status
app.get('/status/:number', (req, res) => {
    let { number } = req.params;
    number = number.replace(/^\+/, '');

    const state = pairingStates.get(number);
    if (!state) {
        return res.status(404).json({
            success: false,
            error: 'No pairing session found for this number'
        });
    }

    res.json({
        success: true,
        status: state.status,
        timestamp: state.timestamp,
        ...(state.status === 'pending' && { pairingCode: state.pairingCode }),
        ...(state.status === 'completed' && { message: 'Session sent to WhatsApp successfully' })
    });
});

// Get session (only works after pairing is complete)
app.get('/session/:number', (req, res) => {
    let { number } = req.params;
    number = number.replace(/^\+/, '');

    const state = pairingStates.get(number);
    if (!state) {
        return res.status(404).json({
            success: false,
            error: 'No session found for this number'
        });
    }

    if (state.status !== 'completed') {
        return res.status(400).json({
            success: false,
            error: 'Pairing not completed yet'
        });
    }

    res.json({
        success: true,
        sessionId: state.base64Creds,
        message: 'Session retrieved successfully'
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'Server running',
        activeSessions: pairingStates.size,
        timestamp: Date.now()
    });
});

// ---------------- Start Server ----------------
app.listen(config.port, () => {
    console.log(chalk.blue(`🚀 Pairing Server running on port ${config.port}`));
    console.log(chalk.blue(`Mode: ${config.mode.toUpperCase()}`));
    console.log(chalk.green('Available endpoints:'));
    console.log(chalk.cyan('  POST /pair - Start pairing process'));
    console.log(chalk.cyan('  GET /status/:number - Check pairing status'));
    console.log(chalk.cyan('  GET /session/:number - Get session after pairing'));
    console.log(chalk.cyan('  GET /health - Server health check'));
});
