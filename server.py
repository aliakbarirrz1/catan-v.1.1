#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
The Bears Catan - Production SQL Backend Server
Built using Python 3 standard library (zero external dependencies required).
Runs an embedded SQLite database, serves static game files, and exposes REST API endpoints.
"""

import os
import sys
import json
import sqlite3
import mimetypes
import io
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn

# Ensure UTF-8 safe output across all consoles/terminals (Windows/Linux/Mac)
if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

PORT = int(os.environ.get("PORT", 8080))
DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "catan.db")
SCHEMA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

def get_db():
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn

def init_database():
    print(f"[*] Initializing SQL database: {DB_FILE}...")
    with get_db() as conn:
        with open(SCHEMA_FILE, "r", encoding="utf-8") as f:
            conn.executescript(f.read())
        conn.commit()
    print("[+] SQL Database is ready.")

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class CatanServerHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS for cross-origin or local network players
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_json(self, status_code, data):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def parse_body(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                raw = self.rfile.read(content_length).decode("utf-8")
                return json.loads(raw)
        except Exception as e:
            print("Error parsing JSON body:", e)
        return {}

    def do_GET(self):
        if self.path.startswith("/catan/"):
            self.path = self.path[6:] or "/"
        elif self.path == "/catan":
            self.send_response(301)
            self.send_header("Location", "/catan/")
            self.end_headers()
            return

        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # Health Check
        if path == "/api/health":
            return self.send_json(200, {"status": "ok", "message": "Catan SQL Server Online"})

        # Get User Profile
        elif path == "/api/user/profile":
            friend_id = query.get("friendId", [""])[0]
            if not friend_id:
                return self.send_json(400, {"error": "friendId is required"})

            with get_db() as conn:
                cur = conn.cursor()
                cur.execute("SELECT * FROM users WHERE friend_id = ?", (friend_id,))
                row = cur.fetchone()
                if row:
                    user = dict(row)
                    user.pop("pin", None) # Do not leak pin
                    return self.send_json(200, {"success": True, "user": user})
                else:
                    return self.send_json(404, {"error": "User not found"})

        # Get Leaderboard
        elif path == "/api/leaderboard":
            with get_db() as conn:
                cur = conn.cursor()
                cur.execute("""
                    SELECT friend_id, username, avatar, frame, title, games_played, games_won, total_xp, level
                    FROM users
                    WHERE games_played > 0
                    ORDER BY total_xp DESC, games_won DESC
                    LIMIT 100
                """)
                rows = [dict(r) for r in cur.fetchall()]
                return self.send_json(200, {"success": True, "leaderboard": rows})

        # Get Friends
        elif path == "/api/friends":
            user_id = query.get("userId", [""])[0]
            if not user_id:
                return self.send_json(400, {"error": "userId is required"})

            with get_db() as conn:
                cur = conn.cursor()
                cur.execute("""
                    SELECT u.friend_id AS id, u.username AS name, u.avatar, u.frame, u.title, u.games_won AS wins, u.last_seen
                    FROM friends f
                    JOIN users u ON f.friend_id = u.friend_id
                    WHERE f.user_id = ?
                    ORDER BY u.last_seen DESC
                """, (user_id,))
                friends = [dict(r) for r in cur.fetchall()]
                for f in friends:
                    f["status"] = "online" # Marked online if connected
                return self.send_json(200, {"success": True, "friends": friends})

        # Static files serving
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/catan/"):
            self.path = self.path[6:] or "/"

        parsed = urlparse(self.path)
        path = parsed.path
        body = self.parse_body()

        # 1. Sync or Create User Profile in SQL
        if path == "/api/user/sync":
            friend_id = body.get("friendId")
            username = body.get("username", "مهمان کاتان").strip()
            pin = body.get("pin", "")
            avatar = body.get("avatar", "images/thebearcatan.png")
            frame = body.get("frame", "frame-wood")
            title = body.get("title", "مهاجر کاتان")
            color_idx = int(body.get("equippedColorIdx", 0))
            is_guest = 1 if body.get("isGuest", True) else 0

            if not friend_id:
                return self.send_json(400, {"error": "friendId is required"})

            with get_db() as conn:
                cur = conn.cursor()
                cur.execute("""
                    INSERT INTO users (friend_id, username, pin, avatar, frame, title, equipped_color_idx, is_guest, last_seen)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(friend_id) DO UPDATE SET
                        username = excluded.username,
                        pin = CASE WHEN excluded.pin != '' THEN excluded.pin ELSE users.pin END,
                        avatar = excluded.avatar,
                        frame = excluded.frame,
                        title = excluded.title,
                        equipped_color_idx = excluded.equipped_color_idx,
                        is_guest = CASE WHEN excluded.pin != '' THEN 0 ELSE users.is_guest END,
                        last_seen = CURRENT_TIMESTAMP
                """, (friend_id, username, pin, avatar, frame, title, color_idx, is_guest))
                conn.commit()

                cur.execute("SELECT * FROM users WHERE friend_id = ?", (friend_id,))
                user = dict(cur.fetchone())
                user.pop("pin", None)
                return self.send_json(200, {"success": True, "user": user})

        # 2. Add Real Friend by Friend ID
        elif path == "/api/friends/add":
            user_id = body.get("userId")
            target_friend_id = (body.get("targetFriendId") or "").strip().upper()
            if target_friend_id and not target_friend_id.startswith("#"):
                target_friend_id = "#" + target_friend_id

            if not user_id or not target_friend_id:
                return self.send_json(400, {"error": "userId and targetFriendId are required"})

            if user_id == target_friend_id:
                return self.send_json(400, {"error": "شما نمی‌توانید کد کاربری خود را اضافه کنید."})

            with get_db() as conn:
                cur = conn.cursor()
                # Check if target friend exists in SQL database
                cur.execute("SELECT friend_id, username, avatar, frame, title, games_won FROM users WHERE friend_id = ?", (target_friend_id,))
                target_user = cur.fetchone()
                if not target_user:
                    return self.send_json(404, {"error": f"❌ بازیکنی با شناسه {target_friend_id} در دیتابیس سرور ثبت نشده است."})

                # Insert friendship
                try:
                    cur.execute("INSERT INTO friends (user_id, friend_id) VALUES (?, ?)", (user_id, target_friend_id))
                    conn.commit()
                except sqlite3.IntegrityError:
                    return self.send_json(400, {"error": "این کاربر قبلاً در لیست دوستان شما اضافه شده است."})

                friend_data = {
                    "id": target_user["friend_id"],
                    "name": target_user["username"],
                    "avatar": target_user["avatar"],
                    "frame": target_user["frame"],
                    "title": target_user["title"],
                    "wins": target_user["games_won"],
                    "status": "online"
                }
                return self.send_json(200, {"success": True, "friend": friend_data})

        # 3. Record Game Result & Update Real Statistics
        elif path == "/api/game/record":
            session_code = body.get("sessionCode", "SOLO")
            winner_friend_id = body.get("winnerFriendId", "")
            winner_name = body.get("winnerName", "نامشخص")
            players_list = body.get("players", [])

            with get_db() as conn:
                cur = conn.cursor()
                # Insert Match History
                cur.execute("""
                    INSERT INTO match_history (session_code, winner_friend_id, winner_name, players_count)
                    VALUES (?, ?, ?, ?)
                """, (session_code, winner_friend_id, winner_name, len(players_list)))
                match_id = cur.lastrowid

                for p in players_list:
                    p_id = p.get("friendId") or p.get("id") or ""
                    p_name = p.get("name", "بازیکن")
                    p_color = int(p.get("colorIdx", 0))
                    p_vp = int(p.get("vp", 0))
                    is_winner = 1 if (p_id == winner_friend_id or p.get("isWinner")) else 0
                    is_bot = 1 if p.get("isBot") else 0

                    cur.execute("""
                        INSERT INTO match_participants (match_id, player_friend_id, player_name, color_idx, victory_points, is_winner, is_bot)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, (match_id, p_id, p_name, p_color, p_vp, is_winner, is_bot))

                    # Update human player in SQL users table
                    if not is_bot and p_id.startswith("#"):
                        earned_xp = (150 + p_vp * 10) if is_winner else (40 + p_vp * 5)
                        cur.execute("""
                            UPDATE users SET
                                games_played = games_played + 1,
                                games_won = games_won + ?,
                                total_xp = total_xp + ?,
                                level = CAST(1 + SQRT((total_xp + ?) / 100) AS INTEGER),
                                last_seen = CURRENT_TIMESTAMP
                            WHERE friend_id = ?
                        """, (1 if is_winner else 0, earned_xp, earned_xp, p_id))

                conn.commit()
                return self.send_json(200, {"success": True, "matchId": match_id})

        return self.send_json(404, {"error": "API route not found"})

def run():
    init_database()
    web_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(web_dir)

    server_address = ("", PORT)
    httpd = ThreadedHTTPServer(server_address, CatanServerHandler)
    print("=" * 60)
    print(f"[+] The Bears Catan SQL Server running at: http://localhost:{PORT}")
    print(f"[+] Serving static files from: {web_dir}")
    print(f"[+] SQLite Database connected: {DB_FILE}")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[!] Server stopped.")
        httpd.server_close()

if __name__ == "__main__":
    run()
