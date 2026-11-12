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

// لاگ خودکار تمام ریکوئست‌های ارسالی به API بازی (مستثنی کردن پنل لاگ برای جلوگیری از لوپ)
app.use((req, res, next) => {
    const isLogReq = req.url.includes('/admin/logs') || req.url.includes('/admin/test-db');
    if (req.url.includes('/api/') && !isLogReq) {
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
    // اگر ریورس‌پراکسی پیشوند /catan را حذف نکرده باشد، آن را بازنویسی می‌کنیم تا روت‌های اکسپرس کار کنند
    if (req.url.startsWith('/catan/')) {
        req.url = req.url.substring(6) || '/';
    }
    next();
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
        const result = partyRelay.createOrUpdateRoom(req.body || {});
        if (!result.ok) return res.status(400).json(result);
        writeLog('PEER', `Party room active on server relay: #${result.room.code} (Host: ${result.room.hostId})`);
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
        writeLog('PEER', `Player joined party via server relay: #${result.room.code} (${result.player.name})`);
        res.json(result);
    } catch (err) {
        writeLog('ERROR', `Party join error: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/party/send', (req, res) => {
    try {
        const result = partyRelay.sendMessage(req.body || {});
        if (!result.ok) return res.status(result.status || 400).json(result);
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
// 3. پنل اختصاصی مانیتورینگ و مشاهده لاگ‌های سرور (Admin Behind-the-Scenes Logs)
// ============================================================================

function checkAdminAuth(req) {
    const key = req.query.key || req.headers['x-admin-key'];
    return key === ADMIN_SECRET;
}

// صفحه وب ادمین برای دیدن زنده لاگ‌ها بدون نیاز به SSH
app.get(['/api/admin/logs', '/catan/api/admin/logs'], (req, res) => {
    if (!checkAdminAuth(req)) {
        return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="fa" dir="rtl">
            <head><meta charset="utf-8"><title>دسترسی غیرمجاز</title>
            <style>body{background:#0f172a;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
            </head>
            <body>
                <div style="text-align:center;padding:30px;background:#1e293b;border-radius:12px;border:1px solid #ef4444;max-width:450px;">
                    <h2 style="margin:0 0 10px 0;">⛔ دسترسی غیرمجاز به لاگ‌ها</h2>
                    <p style="color:#cbd5e1;line-height:1.6;">جهت مشاهده لاگ‌های پشت‌صحنه سرور، کلید ادمین را در انتهای آدرس وارد کنید:</p>
                    <code style="background:#0f172a;color:#38bdf8;padding:6px 12px;border-radius:6px;display:inline-block;direction:ltr;">?key=${ADMIN_SECRET}</code>
                </div>
            </body>
            </html>
        `);
    }

    const format = req.query.format;
    if (format === 'json' || req.headers['accept']?.includes('application/json')) {
        return res.json({
            success: true,
            count: logBuffer.length,
            dbType: DB_TYPE,
            uptime: Math.round(process.uptime()),
            logs: logBuffer.slice().reverse()
        });
    }

    if (format === 'text') {
        res.type('text/plain; charset=utf-8');
        return res.send(logBuffer.map(l => `[${l.timestamp}] [${l.level}] ${l.message} ${l.details ? JSON.stringify(l.details) : ''}`).reverse().join('\n'));
    }

    // رندر داشبورد مدرن تحت وب
    const logsJson = JSON.stringify(logBuffer.slice().reverse());
    res.type('text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🐺 مانیتورینگ و لاگ‌های سرور The Bears Catan</title>
    <style>
        :root {
            --bg: #090d16;
            --panel: #111827;
            --panel-border: #1f2937;
            --text: #e2e8f0;
            --text-dim: #94a3b8;
            --error: #ef4444;
            --warn: #f59e0b;
            --auth: #a855f7;
            --req: #38bdf8;
            --db: #10b981;
            --system: #6366f1;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0; padding: 0;
            background: var(--bg);
            color: var(--text);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Vazirmatn", Tahoma, sans-serif;
            font-size: 14px;
        }
        header {
            background: rgba(17, 24, 39, 0.95);
            backdrop-filter: blur(8px);
            position: sticky; top: 0; z-index: 100;
            border-bottom: 1px solid var(--panel-border);
            padding: 12px 20px;
            display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;
        }
        .brand { display: flex; align-items: center; gap: 10px; }
        .brand h1 { margin: 0; font-size: 16px; font-weight: 700; color: #f8fafc; }
        .badge-live {
            background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);
            font-size: 11px; padding: 3px 8px; border-radius: 999px; font-weight: 600; display: flex; align-items: center; gap: 4px;
        }
        .dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; display: inline-block; animation: pulse 1.5s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
        
        .stats-bar {
            display: flex; gap: 15px; font-size: 12px; color: var(--text-dim); align-items: center;
        }
        .stat-item b { color: #f1f5f9; }

        .controls {
            display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
        }
        .btn {
            background: #1e293b; color: #cbd5e1; border: 1px solid #334155;
            padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
            transition: all 0.2s; font-family: inherit; display: inline-flex; align-items: center; gap: 5px;
        }
        .btn:hover { background: #334155; color: #fff; }
        .btn-danger { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: #f87171; }
        .btn-danger:hover { background: #ef4444; color: #fff; }
        .btn-primary { background: #2563eb; border-color: #3b82f6; color: #fff; }
        .btn-primary:hover { background: #1d4ed8; }

        .search-box {
            background: #0f172a; border: 1px solid #334155; color: #fff;
            padding: 6px 12px; border-radius: 6px; font-size: 12px; min-width: 180px; direction: ltr; text-align: left;
        }
        .search-box:focus { outline: none; border-color: #38bdf8; }

        .filters {
            padding: 10px 20px; background: #0c1220; border-bottom: 1px solid #1e293b;
            display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
        }
        .filter-chip {
            background: #1e293b; color: #94a3b8; border: 1px solid #334155;
            font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer; transition: all 0.15s;
        }
        .filter-chip.active {
            background: #38bdf8; color: #0f172a; font-weight: bold; border-color: #38bdf8;
        }

        .terminal {
            margin: 15px; background: #0c111d; border: 1px solid #1f2937; border-radius: 8px;
            overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
        }
        .log-table {
            width: 100%; border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px;
        }
        .log-row {
            border-bottom: 1px solid #161f30; transition: background 0.1s;
        }
        .log-row:hover { background: #151d2f; }
        .log-cell { padding: 8px 12px; vertical-align: top; }
        .col-time { width: 155px; color: #64748b; white-space: nowrap; direction: ltr; text-align: left; }
        .col-level { width: 90px; text-align: center; }
        .col-msg { color: #e2e8f0; word-break: break-word; line-height: 1.5; }
        
        .tag {
            display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase;
        }
        .tag-error, .tag-critical { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
        .tag-warn { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
        .tag-auth { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); }
        .tag-db { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
        .tag-req { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
        .tag-system { background: rgba(99, 102, 241, 0.2); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.4); }

        .details-pre {
            margin: 6px 0 0 0; background: #080c14; border: 1px solid #1e293b; padding: 8px; border-radius: 4px;
            color: #94a3b8; font-size: 11px; white-space: pre-wrap; word-break: break-all; direction: ltr; text-align: left;
        }
        .empty-state { padding: 40px; text-align: center; color: #64748b; }
        .db-modal {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8);
            display: none; align-items: center; justify-content: center; z-index: 200;
        }
        .db-modal-content {
            background: #111827; border: 1px solid #374151; border-radius: 10px; padding: 20px;
            max-width: 550px; width: 90%; color: #e5e7eb; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
        }
    </style>
</head>
<body>
    <header>
        <div class="brand">
            <span style="font-size: 22px;">🐺</span>
            <div>
                <h1>مانیتورینگ و لاگ‌های زنده سرور The Bears Catan</h1>
                <div style="font-size: 11px; color: var(--text-dim);">سیستم مانیتورینگ پشت‌صحنه - پایدار و ایزوله</div>
            </div>
            <div class="badge-live"><span class="dot"></span> زنده (Active)</div>
        </div>
        
        <div class="stats-bar">
            <div class="stat-item">دیتابیس: <b>${DB_TYPE.toUpperCase()}</b></div>
            <div class="stat-item">پورت: <b>${PORT}</b></div>
            <div class="stat-item">لاگ‌های حاضر: <b id="logCount">0</b></div>
        </div>

        <div class="controls">
            <input type="text" id="searchInput" class="search-box" placeholder="جستجو در لاگ‌ها (Search)..." oninput="applyFilters()">
            <button class="btn btn-primary" onclick="refreshLogs()">🔄 بروزرسانی</button>
            <button class="btn" id="autoToggleBtn" onclick="toggleAutoRefresh()">⏱️ خودکار (3s): روشن</button>
            <button class="btn" onclick="testDatabase()">🩺 تست زنده دیتابیس</button>
            <button class="btn btn-danger" onclick="clearLogs()">🧹 پاک‌سازی لاگ‌ها</button>
        </div>
    </header>

    <div class="filters">
        <span style="font-size: 11px; color: var(--text-dim); margin-left: 8px;">فیلتر دسته‌بندی:</span>
        <button class="filter-chip active" onclick="setFilter('ALL', this)">همه لاگ‌ها</button>
        <button class="filter-chip" onclick="setFilter('ERROR', this)">🔴 خطاها (ERROR)</button>
        <button class="filter-chip" onclick="setFilter('AUTH', this)">🔑 احراز هویت (AUTH)</button>
        <button class="filter-chip" onclick="setFilter('DB', this)">🗄️ دیتابیس (DB)</button>
        <button class="filter-chip" onclick="setFilter('REQ', this)">🌐 ریکوئست‌ها (REQ)</button>
        <button class="filter-chip" onclick="setFilter('SYSTEM', this)">⚙️ سیستم (SYSTEM)</button>
    </div>

    <div class="terminal">
        <table class="log-table">
            <thead>
                <tr style="background: #090e1a; color: #64748b; font-size: 11px; border-bottom: 1px solid #1f2937;">
                    <th class="log-cell" style="width: 155px; text-align: left; direction: ltr;">TIMESTAMP</th>
                    <th class="log-cell" style="width: 90px; text-align: center;">LEVEL</th>
                    <th class="log-cell" style="text-align: right;">MESSAGE / PAYLOAD</th>
                </tr>
            </thead>
            <tbody id="logBody">
                <!-- Log Rows injected dynamically -->
            </tbody>
        </table>
        <div id="emptyMsg" class="empty-state" style="display: none;">هیچ لاگی مطابق فیلتر جاری یافت نشد.</div>
    </div>

    <!-- DB Test Modal -->
    <div id="dbModal" class="db-modal" onclick="closeDbModal(event)">
        <div class="db-modal-content" onclick="event.stopPropagation()">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <h3 style="margin:0; font-size:16px;">🩺 تست لحظه‌ای اتصال دیتابیس</h3>
                <button onclick="closeDbModal()" style="background:none; border:none; color:#9ca3af; font-size:18px; cursor:pointer;">&times;</button>
            </div>
            <div id="dbModalResult" style="font-family: monospace; font-size: 12px; direction: ltr; text-align: left; background: #0a0f1d; padding: 12px; border-radius: 6px; border: 1px solid #1f2937; max-height: 350px; overflow-y: auto;">
                در حال ارسال درخواست تست به سرور...
            </div>
            <div style="text-align: right; margin-top: 15px;">
                <button class="btn btn-primary" onclick="closeDbModal()">بستن پنجره</button>
            </div>
        </div>
    </div>

    <script>
        const ADMIN_KEY = "${ADMIN_SECRET}";
        let allLogs = ${logsJson};
        let activeLevel = 'ALL';
        let autoRefreshInterval = null;
        let isAutoRefresh = true;

        function renderLogs(logs) {
            const tbody = document.getElementById('logBody');
            const empty = document.getElementById('emptyMsg');
            document.getElementById('logCount').innerText = logs.length;
            tbody.innerHTML = '';

            if (logs.length === 0) {
                empty.style.display = 'block';
                return;
            }
            empty.style.display = 'none';

            logs.forEach(log => {
                const tr = document.createElement('tr');
                tr.className = 'log-row';

                let tagClass = 'tag-system';
                const lvl = (log.level || '').toUpperCase();
                if (lvl === 'ERROR' || lvl === 'CRITICAL') tagClass = 'tag-error';
                else if (lvl === 'WARN') tagClass = 'tag-warn';
                else if (lvl === 'AUTH') tagClass = 'tag-auth';
                else if (lvl === 'DB') tagClass = 'tag-db';
                else if (lvl === 'REQ') tagClass = 'tag-req';

                let detailsHtml = '';
                if (log.details) {
                    const text = typeof log.details === 'object' ? JSON.stringify(log.details, null, 2) : String(log.details);
                    detailsHtml = '<pre class="details-pre">' + escapeHtml(text) + '</pre>';
                }

                tr.innerHTML = \`
                    <td class="log-cell col-time">\${log.timestamp}</td>
                    <td class="log-cell col-level"><span class="tag \${tagClass}">\${log.level}</span></td>
                    <td class="log-cell col-msg">
                        <div>\${escapeHtml(log.message)}</div>
                        \${detailsHtml}
                    </td>
                \`;
                tbody.appendChild(tr);
            });
        }

        function escapeHtml(str) {
            return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function applyFilters() {
            const query = document.getElementById('searchInput').value.trim().toLowerCase();
            const filtered = allLogs.filter(log => {
                const matchesLevel = activeLevel === 'ALL' || (log.level || '').toUpperCase() === activeLevel;
                if (!matchesLevel) return false;
                if (!query) return true;
                const msg = (log.message || '').toLowerCase();
                const details = log.details ? JSON.stringify(log.details).toLowerCase() : '';
                return msg.includes(query) || details.includes(query);
            });
            renderLogs(filtered);
        }

        function setFilter(level, btn) {
            activeLevel = level;
            document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyFilters();
        }

        async function refreshLogs() {
            try {
                const res = await fetch(\`?key=\${ADMIN_KEY}&format=json\`);
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.logs) {
                        allLogs = data.logs;
                        applyFilters();
                    }
                }
            } catch (err) {
                console.warn('Refresh logs failed:', err);
            }
        }

        async function clearLogs() {
            if (!confirm('آیا مطمئن هستید که می‌خواهید تمام لاگ‌های ثبت شده را پاک کنید؟')) return;
            try {
                await fetch(\`clear?key=\${ADMIN_KEY}\`);
                allLogs = [];
                applyFilters();
            } catch (e) {
                alert('خطا در پاک‌سازی لاگ‌ها');
            }
        }

        function toggleAutoRefresh() {
            isAutoRefresh = !isAutoRefresh;
            const btn = document.getElementById('autoToggleBtn');
            if (isAutoRefresh) {
                btn.innerText = '⏱️ خودکار (3s): روشن';
                btn.style.color = '#38bdf8';
                startAutoRefresh();
            } else {
                btn.innerText = '⏱️ خودکار: خاموش';
                btn.style.color = '#94a3b8';
                clearInterval(autoRefreshInterval);
            }
        }

        function startAutoRefresh() {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = setInterval(refreshLogs, 3000);
        }

        async function testDatabase() {
            const modal = document.getElementById('dbModal');
            const resultBox = document.getElementById('dbModalResult');
            modal.style.display = 'flex';
            resultBox.innerHTML = 'در حال ارتباط با سرور و اجرای تست دیتابیس...';
            try {
                const res = await fetch(\`test-db?key=\${ADMIN_KEY}\`);
                const data = await res.json();
                resultBox.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
                refreshLogs();
            } catch (err) {
                resultBox.innerHTML = '<span style="color:#f87171;">خطا در ارسال درخواست تست: ' + err.message + '</span>';
            }
        }

        function closeDbModal(e) {
            document.getElementById('dbModal').style.display = 'none';
        }

        // اجرای اولیه
        applyFilters();
        startAutoRefresh();
    </script>
</body>
</html>
    `);
});

// مسیر پاک‌سازی لاگ‌ها
app.all(['/api/admin/logs/clear', '/catan/api/admin/logs/clear'], (req, res) => {
    if (!checkAdminAuth(req)) return res.status(403).json({ error: 'Unauthorized' });
    logBuffer.length = 0;
    fs.writeFile(LOG_FILE, '', () => {});
    writeLog('SYSTEM', 'Log files and memory buffer cleared by administrator.');
    res.json({ success: true, message: 'Logs cleared successfully' });
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
        } else {
            await dbRun(`
                INSERT INTO users (
                    friend_id, username, pin, avatar, frame, title, equipped_color_idx, is_guest, last_seen
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                friendId,
                username || 'مهمان کاتان',
                pin || '',
                avatar || 'images/thebearcatan.png',
                frame || 'frame-wood',
                title || 'مهاجر کاتان',
                equippedColorIdx || 0,
                isGuest ? 1 : 0
            ]);
        }

        const updated = await dbGet('SELECT * FROM users WHERE friend_id = ?', [friendId]);
        res.json({ success: true, user: sanitizeUser(updated) });
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
