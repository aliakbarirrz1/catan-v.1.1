-- ============================================================================
-- The Bears Catan - MySQL Production Database Schema (For aaPanel / Docker)
-- Charset: utf8mb4, Collation: utf8mb4_unicode_ci
-- ============================================================================

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

CREATE TABLE IF NOT EXISTS friends (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(16) NOT NULL,
    friend_id VARCHAR(16) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_friend (user_id, friend_id),
    INDEX idx_friends_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS match_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_code VARCHAR(16) NOT NULL,
    winner_friend_id VARCHAR(16) NOT NULL,
    winner_name VARCHAR(64) NOT NULL,
    players_count INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_matches_session (session_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
    INDEX idx_participant_player (player_friend_id),
    FOREIGN KEY (match_id) REFERENCES match_history(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
