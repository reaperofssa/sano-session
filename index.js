import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
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
    console.log(chalk.cyanBright(`[BOT | ${config.prefix}] → ${message}`));
};

const errorLog = (message) => {
    console.error(chalk.red(`[BOT | ${config.prefix}] → ❌ ${message}`));
};

// ---------------- Session Setup ----------------
const SESSION_DIR = join(__dirname, 'session');
if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

// ---------------- Express App ----------------
const app = express();
app.use(express.json());

// Store active sockets for multiple users
const userSockets = new Map();

// ---------------- Utility functions ----------------
const getRandomColor = () => `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")}`;

// ---------------- Socket Starter ----------------
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

    // Connection handler
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const reason = lastDisconnect?.error?.output?.statusCode;

        switch (connection) {
            case "open":
                console.log(chalk.green(`✅ Connected for ${phoneNumber}`));
                userSockets.set(phoneNumber, sock);

                // Read and encode creds.json
                try {
                    const credsPath = join(sessionDir, 'creds.json');
                    if (existsSync(credsPath)) {
                        const creds = readFileSync(credsPath, 'utf8');
                        const base64Creds = `Sano~${Buffer.from(creds).toString('base64')}`;
                        const userId = sock.user?.id || config.owner;
                        await sock.sendMessage(userId, { text: base64Creds });
                        await sock.sendMessage(userId, { text: 'ꜱᴀɴᴏ ᴍᴅ ꜱᴇꜱꜱɪᴏɴ ɢᴇɴᴇʀᴀᴛɪᴏɴ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟ' });
                        await sock.sendMessage(userId, { text: `ᴘᴀɪʀ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟ ᴘᴜᴛ ᴀʙᴏᴠᴇ ꜱᴇꜱꜱɪᴏɴ ɪᴅ ɪɴ ᴄᴏɴꜰɪɢ.ᴊꜱ ᴛᴏ ᴘᴀɪʀ ᴀɴᴅ ꜱᴛᴀʀᴛ ʙᴏᴛ` });
                        log(`Sent creds and welcome messages to ${userId}`);

                        // Close socket and remove session
                        sock.end();
                        userSockets.delete(phoneNumber);
                        rmSync(sessionDir, { recursive: true, force: true });
                        log(`Closed socket and removed session for ${phoneNumber}`);
                    }
                } catch (error) {
                    errorLog(`Error sending creds for ${phoneNumber}: ${error.message}`);
                }
                break;

            case "close":
                console.log(chalk.red(`⚠️ Lost connection for ${phoneNumber}. Reawakening...`));
                if (reason === DisconnectReason.loggedOut || reason === 401) {
                    console.log(chalk.red(`❌ Authentication failed for ${phoneNumber}. Purge session and restart.`));
                    userSockets.delete(phoneNumber);
                    rmSync(sessionDir, { recursive: true, force: true });
                } else if (reason === DisconnectReason.forbidden || reason === 403) {
                    console.log(chalk.red(`🚫 Banned for ${phoneNumber}.`));
                    userSockets.delete(phoneNumber);
                    rmSync(sessionDir, { recursive: true, force: true });
                } else {
                    console.log(chalk.yellow(`🔄 Unknown interference (${reason}) for ${phoneNumber}. Retrying...`));
                    setTimeout(() => startSocket(phoneNumber, res), 5000);
                }
                break;

            case "connecting":
                break;

            default:
                break;
        }
    });

    // Handle pairing if not registered
    if (!sock.authState.creds.registered) {
        try {
            let code = await sock.requestPairingCode(phoneNumber);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            res.json({ pairingCode: code });
            log(`Sent pairing code ${code} for ${phoneNumber}`);
        } catch (error) {
            errorLog(`Error generating pairing code for ${phoneNumber}: ${error.message}`);
            res.status(500).json({ error: 'Failed to generate pairing code' });
        }
    } else {
        res.status(400).json({ error: 'Already registered' });
    }

    return sock;
}
app.use(express.static(join(__dirname, 'public')));

// Optional: Explicit route for '/' (index.html)
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'public/index.html'));
});
// ---------------- API Endpoints ----------------
app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number || !/^\+?\d{10,15}$/.test(number)) {
        return res.status(400).json({ error: 'Invalid phone number. Use format: 1234567890 or +1234567890' });
    }

    number = number.replace(/^\+/, '');

    try {
        await startSocket(number, res);
    } catch (error) {
        errorLog(`Error starting socket for ${number}: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/creds/:number', (req, res) => {
    const { number } = req.params;
    if (!number || !/^\+\d{10,15}$/.test(number)) {
        return res.status(400).json({ error: 'Invalid phone number. Use format: +1234567890' });
    }

    const sessionDir = join(SESSION_DIR, number);
    const credsPath = join(sessionDir, 'creds.json');

    if (existsSync(credsPath)) {
        try {
            const creds = readFileSync(credsPath, 'utf8');
            const base64Creds = `Sano~${Buffer.from(creds).toString('base64')}`;
            res.json({ base64Creds });
            log(`Retrieved base64 creds for ${number}`);
        } catch (error) {
            errorLog(`Error reading creds for ${number}: ${error.message}`);
            res.status(500).json({ error: 'Failed to read credentials' });
        }
    } else {
        res.status(404).json({ error: 'Credentials not found for this number' });
        log(`No creds found for ${number}`);
    }
});

// ---------------- Start Server ----------------
app.listen(config.port, () => {
    console.log(chalk.blue(`🚀 API Server running on port ${config.port}`));
    console.log(chalk.blue(`Mode: ${config.mode.toUpperCase()}`));
});
