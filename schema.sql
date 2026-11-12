-- ============================================================================
-- The Bears Catan - Production SQL Database Schema
-- Compatible with SQLite, MySQL, and PostgreSQL
-- ============================================================================

-- ۱. جدول کاربران و بازیکنان واقعی (Users / Players)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    friend_id VARCHAR(16) UNIQUE NOT NULL,      -- کد اختصاصی بازیکن مثل #BC-4829
    username VARCHAR(64) NOT NULL,             -- نام کاربری
    email VARCHAR(191) UNIQUE DEFAULT NULL,     -- ایمیل بازیکن جهت ورود امن و بازیابی
    password_hash VARCHAR(255) DEFAULT NULL,    -- هش رمزنگاری‌شده رمز عبور (Bcrypt)
    pin VARCHAR(64) DEFAULT NULL,               -- پین ۴ رقمی جهت حفاظت (اختیاری)
    avatar VARCHAR(255) DEFAULT 'images/thebearcatan.png',
    frame VARCHAR(64) DEFAULT 'frame-wood',
    title VARCHAR(128) DEFAULT 'مهاجر کاتان',
    equipped_color_idx INTEGER DEFAULT 0,
    games_played INTEGER DEFAULT 0,
    games_won INTEGER DEFAULT 0,
    total_xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    is_guest BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ۲. جدول ارتباطات دوستی واقعی (Friends)
CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id VARCHAR(16) NOT NULL,              -- شناسه بازیکن اضافه کننده
    friend_id VARCHAR(16) NOT NULL,            -- شناسه بازیکن اضافه شده
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
);

-- ۳. جدول تاریخچه مسابقات و بازی‌های آنلاین (Match History)
CREATE TABLE IF NOT EXISTS match_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_code VARCHAR(16) NOT NULL,
    winner_friend_id VARCHAR(16) NOT NULL,
    winner_name VARCHAR(64) NOT NULL,
    players_count INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ۴. جدول بازیکنان حاضر در هر مسابقه (Match Participants)
CREATE TABLE IF NOT EXISTS match_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    player_friend_id VARCHAR(16) NOT NULL,
    player_name VARCHAR(64) NOT NULL,
    color_idx INTEGER NOT NULL,
    victory_points INTEGER NOT NULL,
    is_winner BOOLEAN NOT NULL DEFAULT 0,
    is_bot BOOLEAN NOT NULL DEFAULT 0,
    FOREIGN KEY(match_id) REFERENCES match_history(id) ON DELETE CASCADE
);

-- ایندکس‌ها جهت لود آنی لیدربرد و جستجوی پرسرعت دوستان
CREATE INDEX IF NOT EXISTS idx_users_xp ON users(total_xp DESC, games_won DESC);
CREATE INDEX IF NOT EXISTS idx_users_friend_id ON users(friend_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_matches_session ON match_history(session_code);
