const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { ExpressPeerServer } = require('peer');
const { createRoomRelayManager } = require('./room_relay');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const partyRelay = createRoomRelayManager();
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'catan2026';
const LOG_FILE = path.join(__dirname, 'server.log');
const MAX_LOG_BUFFER = 500;
const logBuffer = [];

// ============================================================================
// 0. سیستم پیشرفته ثبت و مدیریت لاگ‌های سرور (Server Logging Engine)
// ============================================================================
function writeLog(level, message, details = null) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = {
        timestamp,
        level: (level || 'INFO').toUpperCase(),
        message: String(message || ''),
        details: details ? (typeof details === 'object' ? details : String(details)) : null
    };

    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_BUFFER) {
        logBuffer.shift();
    }

    let line = `[${timestamp}] [${entry.level}] ${entry.message}`;
    if (details) {
        try {
            line += ` | Data: ${typeof details === 'object' ? JSON.stringify(details) : details}`;
        } catch (_) {
            line += ` | Data: [Unstringifiable Object]`;
        }
    }
    line += '\n';

    if (entry.level === 'ERROR' || entry.level === 'CRITICAL') {
        console.error(line.trim());
    } else {
        console.log(line.trim());
    }

    fs.appendFile(LOG_FILE, line, 'utf8', () => {});
}

// ثبت لاگ شروع پروسه سرور
writeLog('SYSTEM', `Server process initialized on port ${PORT}. Environment: ${process.env.NODE_ENV || 'production'}`);

// مدیریت خطاهای پیش‌بینی نشده بدون توقف کامل سرور
process.on('uncaughtException', (err) => {
    writeLog('CRITICAL', `Uncaught Exception: ${err.message}`, { stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
    writeLog('CRITICAL', `Unhandled Rejection: ${reason && (reason.stack || reason.message || reason)}`);
});

app.use(cors());
app.use(express.json());

const SETTINGS_FILE = path.join(__dirname, 'site_settings.json');
const DEFAULT_SITE_SETTINGS = {
    siteTitle: 'The Bears Catan - پنل کاربری و هاب آنلاین',
    announcementText: '',
    announcementActive: false,
    maintenanceMode: false,
    allowRegistration: true,
    allowGuestLogin: true,
    victoryPointsTarget: 10,
    turnTimerSec: 90,
    maxActiveRooms: 100,
    winBonusXp: 150,
    participationXp: 40,
    welcomeBonusXp: 100,
    customStunUrl: 'stun:stun.l.google.com:19302',
    customTurnUrl: 'turn:openrelay.metered.ca:80'
};

let siteSettings = { ...DEFAULT_SITE_SETTINGS };
try {
    if (fs.existsSync(SETTINGS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        siteSettings = { ...DEFAULT_SITE_SETTINGS, ...parsed };
    }
} catch (_) {
    // Use defaults if file cannot be parsed
}

function saveSiteSettingsToDisk(newSettings) {
    siteSettings = { ...siteSettings, ...newSettings };
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(siteSettings, null, 2), 'utf8');
    } catch (e) {
        writeLog('ERROR', `Failed to write site_settings.json: ${e.message}`);
    }
    return siteSettings;
}

// لاگ خودکار تمام ریکوئست‌های ارسالی به API بازی (مستثنی کردن پنل ادمین و پولینگ برای جلوگیری از شلوغی لاگ)
app.use((req, res, next) => {
    const isSilentReq = req.url.includes('/admin/') || req.url.includes('/api/party/poll');
    if (req.url.includes('/api/') && !isSilentReq) {
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || 'unknown';
        writeLog('REQ', `${req.method} ${req.originalUrl || req.url}`, { clientIp });
    }
    next();
});

// ============================================================================
// پشتیبانی هوشمند از Reverse Proxy و ساب‌پث /catan
// ============================================================================
app.use((req, res, next) => {
    // در صورت باز شدن /catan بدون اسلش، به /catan/ ریدایرکت می‌کنیم تا فایل‌های استاتیک نشکنند
    if (req.path === '/catan') {
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        return res.redirect(301, `/catan/${query}`);
    }
    // جلوگیری از دسترسی مستقیم به فایل قالب ادمین با پسوند html
    if (req.path.endsWith('admin_console.html')) {
        return res.status(404).send('Not Found');
    }
    // اگر ریورس‌پراکسی پیشوند /catan را حذف نکرده باشد، آن را بازنویسی می‌کنیم تا روت‌های اکسپرس کار کنند
    if (req.url.startsWith('/catan/')) {
        req.url = req.url.substring(6) || '/';
    }
    next();
});

// مسیر اختصاصی پنل ادمین جامع (فقط از طریق /catan/admin قابل دسترس است)
app.get(['/admin', '/admin/', '/catan/admin', '/catan/admin/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'admin_console.html'));
});

// سرویس‌دهی فایل‌های استاتیک
app.use(express.static(path.join(__dirname)));
app.use('/catan', express.static(path.join(__dirname)));

// روت‌های صریح برای صفحه لابی و صفحه بازی ۳D
app.get(['/', '/index.html', '/catan', '/catan/index.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/game.html', '/game', '/catan/game.html', '/catan/game'], (req, res) => {
    res.sendFile(path.join(__dirname, 'game.html'));
});

// ============================================================================
// 1. Database Abstraction Layer (Supports MySQL / MariaDB and SQLite)
// ============================================================================
const DB_TYPE = (process.env.DB_TYPE || (process.env.DB_HOST ? 'mysql' : 'sqlite')).toLowerCase();
writeLog('SYSTEM', `Selected Database Driver: ${DB_TYPE.toUpperCase()}`);

let pool = null;
let sqliteDb = null;

if (DB_TYPE === 'mysql') {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'catan_db',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        charset: 'utf8mb4'
    });
} else {
    const sqlite3 = require('sqlite3').verbose();
    const DB_PATH = path.join(__dirname, 'catan.db');
    sqliteDb = new sqlite3.Database(DB_PATH);
}

async function dbGet(sql, params = []) {
    if (DB_TYPE === 'mysql') {
        const [rows] = await pool.execute(sql, params);
        return rows[0] || null;
    } else {
        return new Promise((resolve, reject) => {
            sqliteDb.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });
    }
}

async function dbAll(sql, params = []) {
    if (DB_TYPE === 'mysql') {
        const [rows] = await pool.execute(sql, params);
        return rows || [];
    } else {
        return new Promise((resolve, reject) => {
            sqliteDb.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }
}

async function dbRun(sql, params = []) {
    if (DB_TYPE === 'mysql') {
        const [result] = await pool.execute(sql, params);
        return { lastID: result.insertId, changes: result.affectedRows };
    } else {
        return new Promise((resolve, reject) => {
            sqliteDb.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }
}

// راه‌اندازی و بروزرسانی خودکار دیتابیس (Migrations)
async function initDatabase() {
    try {
        if (DB_TYPE === 'mysql') {
            writeLog('DB', `Attempting MySQL connection to: ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 3306} [DB: ${process.env.DB_NAME || 'catan_db'}]`);
            
            // تست اولیه ارتباط با دیتابیس
            await pool.query('SELECT 1');
            writeLog('DB', 'MySQL connection established successfully.');

            await pool.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    friend_id VARCHAR(16) UNIQUE NOT NULL,
                    username VARCHAR(64) NOT NULL,
                    email VARCHAR(191) UNIQUE DEFAULT NULL,
                    password_hash VARCHAR(255) DEFAULT NULL,
                    pin VARCHAR(64) DEFAULT NULL,
                    avatar VARCHAR(255) DEFAULT 'images/thebearcatan.png',
                    frame VARCHAR(64) DEFAULT 'frame-wood',
                    title VARCHAR(128) DEFAULT 'مهاجر کاتان',
                    equipped_color_idx INT DEFAULT 0,
                    games_played INT DEFAULT 0,
                    games_won INT DEFAULT 0,
                    total_xp INT DEFAULT 0,
                    level INT DEFAULT 1,
                    is_guest TINYINT(1) DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_users_xp (total_xp DESC, games_won DESC),
                    INDEX idx_users_friend_id (friend_id),
                    INDEX idx_users_email (email)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            `);

            // بررسی و ایجاد ستون‌های email و password_hash در صورتی که جدول قبلاً با اسکیمای قدیمی ساخته شده بود
            try {
                const [cols] = await pool.query("SHOW COLUMNS FROM users");
                const colNames = cols.map(c => c.Field.toLowerCase());
                if (!colNames.includes('email')) {
                    await pool.query("ALTER TABLE users ADD COLUMN email VARCHAR(191) UNIQUE DEFAULT NULL AFTER username");
                    writeLog('DB', "MySQL Migration: Added 'email' column to users table.");
                }
                if (!colNames.includes('password_hash')) {
                    await pool.query("ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) DEFAULT NULL AFTER email");
                    writeLog('DB', "MySQL Migration: Added 'password_hash' column to users table.");
                }
                if (!colNames.includes('pin')) {
                    await pool.query("ALTER TABLE users ADD COLUMN pin VARCHAR(64) DEFAULT NULL AFTER password_hash");
                    writeLog('DB', "MySQL Migration: Added 'pin' column to users table.");
                }
            } catch (colErr) {
                writeLog('WARN', `MySQL Columns check notice: ${colErr.message}`);
            }

            await pool.query(`
                CREATE TABLE IF NOT EXISTS friends (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(16) NOT NULL,
                    friend_id VARCHAR(16) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_friend (user_id, friend_id),
                    INDEX idx_friends_user (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS match_history (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    session_code VARCHAR(16) NOT NULL,
                    winner_friend_id VARCHAR(16) NOT NULL,
                    winner_name VARCHAR(64) NOT NULL,
                    players_count INT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_matches_session (session_code)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS match_participants (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    match_id INT NOT NULL,
                    player_friend_id VARCHAR(16) NOT NULL,
                    player_name VARCHAR(64) NOT NULL,
                    color_idx INT NOT NULL,
                    victory_points INT NOT NULL,
                    is_winner TINYINT(1) NOT NULL DEFAULT 0,
                    is_bot TINYINT(1) NOT NULL DEFAULT 0,
                    INDEX idx_participant_match (match_id),
                    FOREIGN KEY (match_id) REFERENCES match_history(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            `);
            writeLog('DB', 'All MySQL database tables verified and ready.');
        } else {
            const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
            if (fs.existsSync(SCHEMA_PATH)) {
                const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
                sqliteDb.exec(schema, (err) => {
                    if (err) writeLog('ERROR', `SQLite Schema Init Error: ${err.message}`);
                    else writeLog('DB', 'SQLite Schema initialized successfully.');
                });
            }

            // Migration for existing catan.db without email or password_hash
            sqliteDb.all("PRAGMA table_info(users)", [], (err, columns) => {
                if (!err && columns && columns.length > 0) {
                    const colNames = columns.map(c => c.name);
                    if (!colNames.includes('email')) {
                        sqliteDb.run("ALTER TABLE users ADD COLUMN email VARCHAR(191) DEFAULT NULL");
                        writeLog('DB', '[SQLite Migration] Added email column to users table.');
                    }
                    if (!colNames.includes('password_hash')) {
                        sqliteDb.run("ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) DEFAULT NULL");
                        writeLog('DB', '[SQLite Migration] Added password_hash column to users table.');
                    }
                }
            });
        }
    } catch (e) {
        writeLog('ERROR', `Database Initialization Failed: ${e.message}`, {
            code: e.code,
            errno: e.errno,
            sqlState: e.sqlState,
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            database: process.env.DB_NAME
        });
    }
}
initDatabase();

// ============================================================================
// 2. Built-in PeerJS Signaling Server (for WebRTC Multiplayer)
// ============================================================================
// بازنویسی خودکار درخواست‌های ارتقای وب‌سوکت برای حالت ساب‌پث ریورس‌پراکسی (/catan/peerjs -> /peerjs)
// این لیسنر باید قبل از ExpressPeerServer ثبت شود تا مسیر وب‌سوکت به درستی با mountpath='/peerjs' تطبیق یابد.
server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/catan/')) {
        req.url = req.url.substring(6) || '/';
    }
});

const peerServer = ExpressPeerServer(server, {
    debug: false,
    path: '/',
    allow_discovery: true,
    proxied: true
});

peerServer.on('connection', (client) => {
    writeLog('PEER', `WebRTC Peer connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
    writeLog('PEER', `WebRTC Peer disconnected: ${client.getId()}`);
});

peerServer.on('error', (err) => {
    writeLog('ERROR', `PeerServer internal error: ${err.message}`);
});

// فقط یک بار روی /peerjs مانت می‌شود (درخواست‌های /catan/peerjs توسط میدل‌ور خط ۸۸ و لیسنر upgrade بالا به /peerjs تبدیل می‌شوند)
app.use('/peerjs', peerServer);

// ============================================================================
// 2.5. Server-Side Room & Message Relay (100% Cross-IP / NAT-Proof Fallback)
// ============================================================================
app.post('/api/party/create', (req, res) => {
    try {
        const activeRooms = partyRelay.listAllRooms();
        const cleanReqCode = partyRelay.normalizeCode((req.body || {}).code);
        const alreadyExists = activeRooms.some(r => r.code === cleanReqCode);
        if (!alreadyExists && activeRooms.length >= (siteSettings.maxActiveRooms || 100)) {
            return res.status(429).json({ ok: false, error: 'ظرفیت ساخت روم جدید روی سرور تکمیل است.' });
        }

        const result = partyRelay.createOrUpdateRoom(req.body || {});
        if (!result.ok) return res.status(400).json(result);
        writeLog('GAME', `Room #${result.room.code} active (Host: ${result.room.hostId}, Players: ${result.room.players.length})`);
        res.json(result);
    } catch (err) {
        writeLog('ERROR', `Party create error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/party/join', (req, res) => {
    try {
        const result = partyRelay.joinRoom(req.body || {});
        if (!result.ok) return res.status(result.status || 400).json(result);
        writeLog('GAME', `Player '${result.player.name}' (${result.player.id}) joined Room #${result.room.code}`);
        res.json(result);
    } catch (err) {
        writeLog('ERROR', `Party join error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/party/send', (req, res) => {
    try {
        const body = req.body || {};
        const result = partyRelay.sendMessage(body);
        if (!result.ok) return res.status(result.status || 400).json(result);

        // ثبت لاگ کامل رویدادهای داخل بازی برای پنل مدیریت
        const pType = body.payload && body.payload.type ? String(body.payload.type) : '';
        if (pType && pType !== 'LOBBY_UPDATE' && pType !== 'GAME_STATE_SYNC') {
            writeLog('GAME', `[Room #${result.room.code}] Event: ${pType} (from: ${body.fromId || 'host'})`, body.payload);
        } else if (pType === 'LAUNCH_GAME' || pType === 'START_GAME') {
            writeLog('GAME', `[Room #${result.room.code}] Match Launched (${pType}) with ${result.room.players.length} players, seed: ${result.room.seed}`);
        }

        res.json(result);
    } catch (err) {
        writeLog('ERROR', `Party send error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.get('/api/party/poll', (req, res) => {
    try {
        const result = partyRelay.pollMessages({
            code: req.query.code,
            playerId: req.query.playerId,
            since: req.query.since
        });
        if (!result.ok) return res.status(result.status || 404).json(result);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// تنظیمات عمومی قابل دریافت توسط لابی و بازی (بدون اطلاعات حساس)
app.get('/api/settings/public', (req, res) => {
    res.json({
        success: true,
        settings: {
            siteTitle: siteSettings.siteTitle,
            announcementText: siteSettings.announcementText,
            announcementActive: Boolean(siteSettings.announcementActive),
            maintenanceMode: Boolean(siteSettings.maintenanceMode),
            allowRegistration: siteSettings.allowRegistration !== false,
            allowGuestLogin: siteSettings.allowGuestLogin !== false,
            victoryPointsTarget: Number(siteSettings.victoryPointsTarget) || 10,
            turnTimerSec: Number(siteSettings.turnTimerSec) || 90,
            customStunUrl: siteSettings.customStunUrl,
            customTurnUrl: siteSettings.customTurnUrl
        }
    });
});

// Helper to generate a unique #BC-XXXX friend ID
async function generateUniqueFriendId() {
    for (let i = 0; i < 20; i++) {
        const rand = Math.floor(1000 + Math.random() * 9000);
        const code = `#BC-${rand}`;
        const existing = await dbGet('SELECT id FROM users WHERE friend_id = ?', [code]);
        if (!existing) return code;
    }
    return `#BC-${Date.now().toString().slice(-4)}`;
}

// Clean user object before returning to client (strip sensitive hashes)
function sanitizeUser(user) {
    if (!user) return null;
    const sanitized = { ...user };
    delete sanitized.password_hash;
    delete sanitized.pin;
    return sanitized;
}

// ============================================================================
// 3. پنل اختصاصی مدیریت جامع بازی، کاربران، روم‌ها، امتیازات و لاگ‌ها (Admin Console API)
// ============================================================================

function checkAdminAuth(req) {
    const key = req.query.key || req.headers['x-admin-key'];
    return key === ADMIN_SECRET;
}

// ۳.۱. خلاصه وضعیت کلی سیستم برای داشبورد ادمین
app.get(['/api/admin/overview', '/catan/api/admin/overview'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const allUsers = await dbAll('SELECT * FROM users ORDER BY last_seen DESC, id DESC');
        const sanitizedUsers = (allUsers || []).map(sanitizeUser);
        const registeredCount = sanitizedUsers.filter(u => !u.is_guest).length;
        const guestCount = sanitizedUsers.filter(u => u.is_guest).length;
        const totalXp = sanitizedUsers.reduce((sum, u) => sum + (Number(u.total_xp) || 0), 0);

        const matchCountRow = await dbGet('SELECT COUNT(*) AS cnt FROM match_history');
        const totalMatches = matchCountRow ? (matchCountRow.cnt || 0) : 0;

        const rooms = partyRelay.listAllRooms();
        const activePlayersInRooms = rooms.reduce((sum, r) => sum + (r.humanCount || 0), 0);
        const errorLogs = logBuffer.filter(l => l.level === 'ERROR' || l.level === 'CRITICAL' || l.level === 'WARN').length;
        const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

        res.json({
            success: true,
            kpi: {
                totalUsers: sanitizedUsers.length,
                registeredUsers: registeredCount,
                guestUsers: guestCount,
                totalMatches,
                totalXp,
                activeRooms: rooms.length,
                activePlayersInRooms,
                totalLogs: logBuffer.length,
                errorLogs,
                uptimeSec: Math.round(process.uptime()),
                memoryMb: memMb,
                dbType: DB_TYPE
            },
            rooms,
            recentUsers: sanitizedUsers.slice(0, 15),
            recentLogs: logBuffer.slice(-60).reverse(),
            settings: siteSettings
        });
    } catch (err) {
        writeLog('ERROR', `Admin overview error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ۳.۲. دریافت لاگ‌های سرور و بازی
app.get(['/api/admin/logs', '/catan/api/admin/logs'], (req, res) => {
    if (!checkAdminAuth(req)) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const format = req.query.format;
    if (format === 'text') {
        res.type('text/plain; charset=utf-8');
        return res.send(logBuffer.map(l => `[${l.timestamp}] [${l.level}] ${l.message} ${l.details ? JSON.stringify(l.details) : ''}`).reverse().join('\n'));
    }

    if (format === 'json' || req.headers['accept']?.includes('application/json')) {
        return res.json({
            success: true,
            count: logBuffer.length,
            dbType: DB_TYPE,
            uptime: Math.round(process.uptime()),
            logs: logBuffer.slice().reverse()
        });
    }

    // در صورت باز شدن مستقیم در مرورگر، کنسول جامع مدیریت را نمایش می‌دهیم
    res.sendFile(path.join(__dirname, 'admin_console.html'));
});

// پاک‌سازی لاگ‌ها
app.all(['/api/admin/logs/clear', '/catan/api/admin/logs/clear'], (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    logBuffer.length = 0;
    fs.writeFile(LOG_FILE, '', () => {});
    writeLog('SYSTEM', 'Log files and memory buffer cleared by administrator.');
    res.json({ success: true, message: 'Logs cleared successfully' });
});

// ۳.۳. مدیریت کاربران و ثبت‌نامی‌ها
app.get(['/api/admin/users', '/catan/api/admin/users'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const rows = await dbAll('SELECT * FROM users ORDER BY is_guest ASC, total_xp DESC, id DESC');
        res.json({
            success: true,
            users: (rows || []).map(sanitizeUser)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post(['/api/admin/users/create', '/catan/api/admin/users/create'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { username, email, password, title, frame, level, totalXp, gamesPlayed, gamesWon, isGuest } = req.body || {};
        if (!username) return res.status(400).json({ error: 'نام کاربری الزامی است.' });

        const friendId = await generateUniqueFriendId();
        let passwordHash = null;
        if (password && String(password).trim().length > 0) {
            const salt = await bcrypt.genSalt(10);
            passwordHash = await bcrypt.hash(String(password), salt);
        }

        const cleanEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
        await dbRun(`
            INSERT INTO users (
                friend_id, username, email, password_hash, pin, avatar, frame, title,
                equipped_color_idx, games_played, games_won, total_xp, level, is_guest, created_at, last_seen
            ) VALUES (?, ?, ?, ?, '', 'images/thebearcatan.png', ?, ?, 0, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            friendId,
            String(username).trim(),
            cleanEmail,
            passwordHash,
            frame || 'frame-wood',
            title || 'مهاجر کاتان',
            Number(gamesPlayed) || 0,
            Number(gamesWon) || 0,
            Number(totalXp) || 0,
            Number(level) || 1,
            isGuest ? 1 : 0
        ]);

        writeLog('AUTH', `Admin created user account: ${username} (${friendId})`);
        const created = await dbGet('SELECT * FROM users WHERE friend_id = ?', [friendId]);
        res.json({ success: true, user: sanitizeUser(created) });
    } catch (err) {
        writeLog('ERROR', `Admin user create error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post(['/api/admin/users/update', '/catan/api/admin/users/update'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { friendId, username, email, password, title, frame, level, totalXp, gamesPlayed, gamesWon, isGuest } = req.body || {};
        if (!friendId) return res.status(400).json({ error: 'شناسه کاربر الزامی است.' });

        const existing = await dbGet('SELECT * FROM users WHERE friend_id = ?', [friendId]);
        if (!existing) return res.status(404).json({ error: 'کاربر یافت نشد.' });

        let passwordHash = existing.password_hash;
        if (password && String(password).trim().length > 0) {
            const salt = await bcrypt.genSalt(10);
            passwordHash = await bcrypt.hash(String(password), salt);
        }

        const cleanEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
        await dbRun(`
            UPDATE users SET
                username = ?,
                email = ?,
                password_hash = ?,
                title = ?,
                frame = ?,
                level = ?,
                total_xp = ?,
                games_played = ?,
                games_won = ?,
                is_guest = ?
            WHERE friend_id = ?
        `, [
            username || existing.username,
            cleanEmail,
            passwordHash,
            title || existing.title,
            frame || existing.frame,
            Number(level) || 1,
            Number(totalXp) || 0,
            Number(gamesPlayed) || 0,
            Number(gamesWon) || 0,
            isGuest ? 1 : 0,
            friendId
        ]);

        writeLog('AUTH', `Admin updated user ${friendId} (${username}): XP=${totalXp}, Wins=${gamesWon}, Lv=${level}`);
        const updated = await dbGet('SELECT * FROM users WHERE friend_id = ?', [friendId]);
        res.json({ success: true, user: sanitizeUser(updated) });
    } catch (err) {
        writeLog('ERROR', `Admin user update error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post(['/api/admin/users/delete', '/catan/api/admin/users/delete'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { friendId } = req.body || {};
        if (!friendId) return res.status(400).json({ error: 'friendId الزامی است.' });

        await dbRun('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', [friendId, friendId]);
        await dbRun('DELETE FROM users WHERE friend_id = ?', [friendId]);
        writeLog('AUTH', `Admin deleted user account: ${friendId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ۳.۴. مدیریت روم‌ها و لابی‌های فعال
app.get(['/api/admin/rooms', '/catan/api/admin/rooms'], (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    res.json({
        success: true,
        rooms: partyRelay.listAllRooms()
    });
});

app.post(['/api/admin/rooms/create', '/catan/api/admin/rooms/create'], (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    const { code, hostName } = req.body || {};
    const result = partyRelay.createOrUpdateRoom({
        code: code || String(Math.floor(1000 + Math.random() * 9000)),
        hostId: `admin_host_${Date.now().toString().slice(-4)}`,
        hostName: hostName || 'میزبان تورنمنت',
        hostColorIdx: 0
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    writeLog('GAME', `Admin created room #${result.room.code}`);
    res.json({ success: true, room: result.room });
});

app.post(['/api/admin/rooms/delete', '/catan/api/admin/rooms/delete'], (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    const { code } = req.body || {};
    const result = partyRelay.deleteRoom(code);
    writeLog('GAME', `Admin closed and deleted room #${result.deletedCode}`);
    res.json({ success: true, ...result });
});

app.post(['/api/admin/rooms/broadcast', '/catan/api/admin/rooms/broadcast'], (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    const { code, text } = req.body || {};
    const result = partyRelay.broadcastSystemMessage({ code, text });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    writeLog('GAME', `Admin broadcast message to [${result.sentToRooms.join(', ')}]: ${text}`);
    res.json({ success: true, ...result });
});

// ۳.۵. مدیریت امتیازها، لیدربرد و تاریخچه مسابقات
app.get(['/api/admin/matches', '/catan/api/admin/matches'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const leaderboard = await dbAll(`
            SELECT friend_id, username, email, avatar, frame, title, games_played, games_won, total_xp, level, is_guest
            FROM users
            ORDER BY total_xp DESC, games_won DESC, id ASC
            LIMIT 200
        `);

        const matches = await dbAll('SELECT * FROM match_history ORDER BY id DESC LIMIT 100');
        const participants = await dbAll('SELECT * FROM match_participants ORDER BY id ASC');

        const partsByMatch = {};
        for (const p of (participants || [])) {
            if (!partsByMatch[p.match_id]) partsByMatch[p.match_id] = [];
            partsByMatch[p.match_id].push(p);
        }

        const enrichedMatches = (matches || []).map(m => ({
            ...m,
            participants: partsByMatch[m.id] || []
        }));

        res.json({
            success: true,
            leaderboard: leaderboard || [],
            matches: enrichedMatches
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post(['/api/admin/matches/record', '/catan/api/admin/matches/record'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { sessionCode, winnerFriendId, winnerName, players } = req.body || {};
        const result = await dbRun(
            'INSERT INTO match_history (session_code, winner_friend_id, winner_name, players_count) VALUES (?, ?, ?, ?)',
            [sessionCode || 'ADMIN', winnerFriendId || '', winnerName || '', (players || []).length || 1]
        );
        const matchId = result.lastID;

        for (const p of (players || [])) {
            const pId = p.friendId || p.id || winnerFriendId || '';
            const isWinner = (pId === winnerFriendId || p.isWinner) ? 1 : 0;
            const isBot = p.isBot ? 1 : 0;
            await dbRun(
                'INSERT INTO match_participants (match_id, player_friend_id, player_name, color_idx, victory_points, is_winner, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [matchId, pId, p.name || winnerName || 'بازیکن', p.colorIdx || 0, p.vp || 10, isWinner, isBot]
            );
            if (!isBot && pId) {
                const winBase = Number(siteSettings.winBonusXp) || 150;
                const partBase = Number(siteSettings.participationXp) || 40;
                const earnedXp = isWinner ? (winBase + (p.vp || 10) * 10) : (partBase + (p.vp || 0) * 5);
                await dbRun(`
                    UPDATE users SET
                        games_played = games_played + 1,
                        games_won = games_won + ?,
                        total_xp = total_xp + ?,
                        level = CAST(1 + SQRT((total_xp + ?) / 100) AS SIGNED),
                        last_seen = CURRENT_TIMESTAMP
                    WHERE friend_id = ?
                `, [isWinner, earnedXp, earnedXp, pId]);
            }
        }

        writeLog('GAME', `Admin recorded match #${matchId} (Winner: ${winnerName} ${winnerFriendId})`);
        res.json({ success: true, matchId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post(['/api/admin/matches/delete', '/catan/api/admin/matches/delete'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { matchId } = req.body || {};
        if (!matchId) return res.status(400).json({ error: 'matchId الزامی است.' });
        await dbRun('DELETE FROM match_participants WHERE match_id = ?', [matchId]);
        await dbRun('DELETE FROM match_history WHERE id = ?', [matchId]);
        writeLog('DB', `Admin deleted match record #${matchId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ۳.۶. مدیریت تنظیمات سایت و بازی
app.get(['/api/admin/settings', '/catan/api/admin/settings'], (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    res.json({ success: true, settings: siteSettings });
});

app.post(['/api/admin/settings', '/catan/api/admin/settings'], (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    const updated = saveSiteSettingsToDisk(req.body || {});
    writeLog('SYSTEM', 'Site and game settings updated by administrator.', updated);
    res.json({ success: true, settings: updated });
});

// مسیر تست زنده اتصال دیتابیس (DB Diagnostics)
app.get(['/api/admin/test-db', '/catan/api/admin/test-db'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    const startTime = Date.now();
    try {
        let pingResult = null;
        let usersCount = 0;
        let columnsList = [];

        if (DB_TYPE === 'mysql') {
            const [ping] = await pool.query('SELECT 1 + 1 AS solution');
            pingResult = ping[0]?.solution === 2 ? 'OK' : 'FAIL';
            const [users] = await pool.query('SELECT COUNT(*) as count FROM users');
            usersCount = users[0]?.count || 0;
            const [cols] = await pool.query('SHOW COLUMNS FROM users');
            columnsList = cols.map(c => c.Field);
        } else {
            const ping = await dbGet('SELECT 1 + 1 AS solution');
            pingResult = ping?.solution === 2 ? 'OK' : 'FAIL';
            const users = await dbGet('SELECT COUNT(*) as count FROM users');
            usersCount = users?.count || 0;
            const cols = await dbAll('PRAGMA table_info(users)');
            columnsList = cols.map(c => c.name);
        }

        const durationMs = Date.now() - startTime;
        const resultData = {
            status: 'CONNECTED',
            driver: DB_TYPE,
            ping: pingResult,
            latencyMs: durationMs,
            usersRegistered: usersCount,
            userTableColumns: columnsList,
            hasEmailColumn: columnsList.includes('email'),
            hasPasswordHashColumn: columnsList.includes('password_hash'),
            timestamp: new Date().toISOString()
        };

        writeLog('DB', 'Diagnostic database test completed successfully', resultData);
        res.json({ success: true, diagnostics: resultData });
    } catch (err) {
        const errorData = {
            status: 'FAILED',
            driver: DB_TYPE,
            message: err.message,
            code: err.code,
            errno: err.errno,
            sqlState: err.sqlState,
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            database: process.env.DB_NAME
        };
        writeLog('ERROR', `Diagnostic database test failed: ${err.message}`, errorData);
        res.status(500).json({ success: false, diagnostics: errorData });
    }
});

// مسیر پاک‌سازی و صفر کردن کامل دیتابیس (Reset Database)
app.post(['/api/admin/reset-db', '/catan/api/admin/reset-db'], async (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        await dbRun('DELETE FROM match_participants');
        await dbRun('DELETE FROM match_history');
        await dbRun('DELETE FROM friends');
        await dbRun('DELETE FROM users');
        if (DB_TYPE !== 'mysql') {
            try {
                await dbRun("DELETE FROM sqlite_sequence WHERE name IN ('users', 'friends', 'match_history', 'match_participants')");
            } catch (_) {}
        }
        partyRelay._rooms.clear();
        logBuffer.length = 0;
        fs.writeFile(LOG_FILE, '', () => {});
        res.json({ success: true, message: 'دیتابیس، روم‌ها و لاگ‌ها به طور کامل پاک‌سازی شدند.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 4. Authentication & User API Endpoints
// ============================================================================

// 0. Health Check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        database: DB_TYPE,
        time: new Date().toISOString()
    });
});

// 1. ثبت نام کاربر جدید با ایمیل و پسورد رمزنگاری شده (Register)
app.post('/api/auth/register', async (req, res) => {
    let { email, password, username, avatar } = req.body || {};
    writeLog('AUTH', `Registration attempt initiated for: ${email || 'NONE'}, username: ${username || 'NONE'}`);

    try {
        if (!email || typeof email !== 'string' || !email.includes('@')) {
            writeLog('WARN', `Registration rejected: Invalid email format (${email})`);
            return res.status(400).json({ error: 'لطفاً یک آدرس ایمیل معتبر وارد کنید.' });
        }
        if (!password || typeof password !== 'string' || password.length < 6) {
            writeLog('WARN', `Registration rejected: Password length less than 6 chars for ${email}`);
            return res.status(400).json({ error: 'رمز عبور باید حداقل ۶ کاراکتر باشد.' });
        }

        email = email.trim().toLowerCase();
        username = (username || '').trim() || email.split('@')[0];
        if (username.length > 50) username = username.substring(0, 50);

        // بررسی یکتایی ایمیل
        const existing = await dbGet('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
        if (existing) {
            writeLog('WARN', `Registration conflict: Email ${email} is already registered.`);
            return res.status(409).json({ error: 'این ایمیل قبلاً ثبت شده است. لطفاً وارد شوید.' });
        }

        // رمزنگاری قوی رمز عبور با Bcrypt
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const friendId = await generateUniqueFriendId();
        const chosenAvatar = avatar || 'images/thebearcatan.png';

        const sql = `
            INSERT INTO users (
                friend_id, username, email, password_hash, pin, avatar, frame, title,
                equipped_color_idx, games_played, games_won, total_xp, level, is_guest, created_at, last_seen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        await dbRun(sql, [friendId, username, email, passwordHash, '', chosenAvatar, 'frame-wood', 'مهاجر کاتان']);

        const createdUser = await dbGet('SELECT * FROM users WHERE friend_id = ?', [friendId]);
        const sessionToken = crypto.randomBytes(32).toString('hex');

        writeLog('AUTH', `User registered successfully: ${username} (${friendId}) - ${email}`);

        res.status(201).json({
            success: true,
            message: 'ثبت‌نام با موفقیت انجام شد.',
            token: sessionToken,
            user: sanitizeUser(createdUser)
        });
    } catch (err) {
        writeLog('ERROR', `Registration failed for ${email}: ${err.message}`, {
            code: err.code,
            errno: err.errno,
            sqlState: err.sqlState,
            sqlMessage: err.sqlMessage
        });
        res.status(500).json({
            error: 'خطا در ثبت‌نام. لطفاً دوباره تلاش کنید.',
            details: err.sqlMessage || err.message,
            code: err.code || 'DB_ERROR'
        });
    }
});

// 2. ورود کاربر با ایمیل و پسورد (Login)
app.post('/api/auth/login', async (req, res) => {
    let { email, password } = req.body || {};
    writeLog('AUTH', `Login attempt for: ${email || 'NONE'}`);

    try {
        if (!email || !password) {
            writeLog('WARN', 'Login rejected: Missing email or password');
            return res.status(400).json({ error: 'ایمیل و رمز عبور الزامی است.' });
        }

        email = email.trim().toLowerCase();

        // جستجو با ایمیل یا نام کاربری یا شناسه کاربری
        const user = await dbGet(
            'SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ? OR friend_id = ?',
            [email, email, email.toUpperCase()]
        );

        if (!user) {
            writeLog('WARN', `Login failed: User not found for '${email}'`);
            return res.status(401).json({ error: 'کاربری با این مشخصات یافت نشد.' });
        }

        if (!user.password_hash) {
            writeLog('WARN', `Login failed: Account ${user.friend_id} has no password set`);
            return res.status(400).json({
                error: 'این حساب هنوز رمز عبور ثبت نکرده است. لطفاً یک بار ثبت‌نام کنید.'
            });
        }

        // تایید هش رمز عبور
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            writeLog('WARN', `Login failed: Incorrect password for user ${user.friend_id} (${email})`);
            return res.status(401).json({ error: 'رمز عبور وارد شده نادرست است.' });
        }

        // بروزرسانی آخرین بازدید
        await dbRun('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

        const sessionToken = crypto.randomBytes(32).toString('hex');

        writeLog('AUTH', `User logged in successfully: ${user.username} (${user.friend_id})`);

        res.json({
            success: true,
            message: 'با موفقیت وارد شدید.',
            token: sessionToken,
            user: sanitizeUser(user)
        });
    } catch (err) {
        writeLog('ERROR', `Login system error for ${email}: ${err.message}`, {
            code: err.code,
            sqlMessage: err.sqlMessage
        });
        res.status(500).json({
            error: 'خطای سرور در بررسی اطلاعات ورود.',
            details: err.sqlMessage || err.message
        });
    }
});

// 3. دریافت اطلاعات پروفایل
app.get('/api/user/profile', async (req, res) => {
    try {
        const friendId = req.query.friendId;
        if (!friendId) return res.status(400).json({ error: 'friendId الزامی است.' });

        const user = await dbGet('SELECT * FROM users WHERE friend_id = ?', [friendId]);
        if (!user) return res.status(404).json({ error: 'کاربر پیدا نشد.' });

        res.json({ success: true, user: sanitizeUser(user) });
    } catch (err) {
        writeLog('ERROR', `Profile fetch error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 4. همگام‌سازی اطلاعات پروفایل (Sync Profile)
app.post('/api/user/sync', async (req, res) => {
    try {
        const { friendId, username, pin, avatar, frame, title, equippedColorIdx, isGuest } = req.body;
        if (!friendId) return res.status(400).json({ error: 'friendId الزامی است.' });

        const existing = await dbGet('SELECT * FROM users WHERE friend_id = ?', [friendId]);

        if (existing) {
            await dbRun(`
                UPDATE users SET
                    username = ?,
                    pin = CASE WHEN ? != '' THEN ? ELSE pin END,
                    avatar = ?,
                    frame = ?,
                    title = ?,
                    equipped_color_idx = ?,
                    is_guest = CASE WHEN ? != '' THEN 0 ELSE is_guest END,
                    last_seen = CURRENT_TIMESTAMP
                WHERE friend_id = ?
            `, [
                username || existing.username,
                pin || '',
                pin || '',
                avatar || existing.avatar,
                frame || existing.frame,
                title || existing.title,
                equippedColorIdx !== undefined ? equippedColorIdx : existing.equipped_color_idx,
                pin || '',
                friendId
            ]);
            const updated = await dbGet('SELECT * FROM users WHERE friend_id = ?', [friendId]);
            return res.json({ success: true, user: sanitizeUser(updated) });
        }

        // عدم ذخیره خودکار بازدیدکنندگان مهمان (بدون ثبت‌نام) در دیتابیس اصلی
        return res.json({
            success: true,
            user: {
                friend_id: friendId,
                username: username || 'مهمان کاتان',
                avatar: avatar || 'images/thebearcatan.png',
                frame: frame || 'frame-wood',
                title: title || 'مهاجر کاتان',
                equipped_color_idx: equippedColorIdx || 0,
                is_guest: 1
            }
        });
    } catch (err) {
        writeLog('ERROR', `User sync error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 5. لیدربرد بازیکنان برتر
app.get('/api/leaderboard', async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT friend_id, username, avatar, frame, title, games_played, games_won, total_xp, level
            FROM users
            WHERE games_played > 0
            ORDER BY total_xp DESC, games_won DESC
            LIMIT 100
        `);
        res.json({ success: true, leaderboard: rows || [] });
    } catch (err) {
        writeLog('ERROR', `Leaderboard fetch error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 6. لیست دوستان بازیکن
app.get('/api/friends', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) return res.status(400).json({ error: 'userId الزامی است.' });

        const friends = await dbAll(`
            SELECT u.friend_id AS id, u.username AS name, u.avatar, u.frame, u.title, u.games_won AS wins, u.last_seen
            FROM friends f
            JOIN users u ON f.friend_id = u.friend_id
            WHERE f.user_id = ?
            ORDER BY u.last_seen DESC
        `, [userId]);

        const list = (friends || []).map(f => ({ ...f, status: 'online' }));
        res.json({ success: true, friends: list });
    } catch (err) {
        writeLog('ERROR', `Friends fetch error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 7. افزودن دوست با شناسه واقعی
app.post('/api/friends/add', async (req, res) => {
    try {
        let { userId, targetFriendId } = req.body;
        if (!targetFriendId) return res.status(400).json({ error: 'targetFriendId الزامی است.' });

        targetFriendId = targetFriendId.trim().toUpperCase();
        if (!targetFriendId.startsWith('#')) targetFriendId = '#' + targetFriendId;

        if (userId === targetFriendId) {
            return res.status(400).json({ error: 'شما نمی‌توانید شناسه خود را اضافه کنید.' });
        }

        const user = await dbGet('SELECT friend_id, username, avatar, frame, title, games_won FROM users WHERE friend_id = ?', [targetFriendId]);
        if (!user) {
            return res.status(404).json({ error: `❌ بازیکنی با شناسه ${targetFriendId} در دیتابیس سرور ثبت نشده است.` });
        }

        const alreadyAdded = await dbGet('SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', [userId, targetFriendId]);
        if (alreadyAdded) {
            return res.status(400).json({ error: 'این بازیکن قبلاً به لیست دوستان شما اضافه شده است.' });
        }

        await dbRun('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)', [userId, targetFriendId]);
        writeLog('AUTH', `Friend added: ${userId} added ${targetFriendId}`);

        res.json({
            success: true,
            friend: {
                id: user.friend_id,
                name: user.username,
                avatar: user.avatar,
                frame: user.frame,
                title: user.title,
                wins: user.games_won,
                status: 'online'
            }
        });
    } catch (err) {
        writeLog('ERROR', `Friend add error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// 8. ثبت نتایج مسابقه و امتیازات
app.post('/api/game/record', async (req, res) => {
    try {
        const { sessionCode, winnerFriendId, winnerName, players } = req.body;

        const result = await dbRun(
            'INSERT INTO match_history (session_code, winner_friend_id, winner_name, players_count) VALUES (?, ?, ?, ?)',
            [sessionCode || 'SOLO', winnerFriendId || '', winnerName || '', (players || []).length]
        );
        const matchId = result.lastID;

        for (const p of (players || [])) {
            const pId = p.friendId || p.id || '';
            const isWinner = (pId === winnerFriendId || p.isWinner) ? 1 : 0;
            const isBot = p.isBot ? 1 : 0;

            await dbRun(
                'INSERT INTO match_participants (match_id, player_friend_id, player_name, color_idx, victory_points, is_winner, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [matchId, pId, p.name || 'بازیکن', p.colorIdx || 0, p.vp || 0, isWinner, isBot]
            );

            if (!isBot && pId.startsWith('#')) {
                const earnedXp = isWinner ? (150 + (p.vp || 10) * 10) : (40 + (p.vp || 0) * 5);
                await dbRun(`
                    UPDATE users SET
                        games_played = games_played + 1,
                        games_won = games_won + ?,
                        total_xp = total_xp + ?,
                        level = CAST(1 + SQRT((total_xp + ?) / 100) AS SIGNED),
                        last_seen = CURRENT_TIMESTAMP
                    WHERE friend_id = ?
                `, [isWinner, earnedXp, earnedXp, pId]);
            }
        }

        writeLog('DB', `Match recorded successfully: ${sessionCode} [Winner: ${winnerName} (${winnerFriendId})]`);
        res.json({ success: true, matchId });
    } catch (err) {
        writeLog('ERROR', `Game record error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

server.listen(PORT, () => {
    writeLog('SYSTEM', `The Bears Catan Server running at: http://localhost:${PORT}`);
    writeLog('SYSTEM', `PeerJS Signaling Server active on: /peerjs & /catan/peerjs`);
    writeLog('SYSTEM', `Admin Log Monitor URL: /catan/api/admin/logs?key=${ADMIN_SECRET}`);
});
