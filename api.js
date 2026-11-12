/**
 * The Bears Catan - Server API Client
 * Shared between User Panel (index.html) and 3D Game (game.html)
 */

(function (window) {
    'use strict';

    const CatanServerAPI = {
        getBaseUrl() {
            if (typeof window !== 'undefined' && window.location && window.location.protocol && window.location.protocol.startsWith('http')) {
                const pathname = window.location.pathname || '';
                if (pathname.startsWith('/catan')) {
                    return window.location.origin + '/catan';
                }
                return window.location.origin;
            }
            return 'http://localhost:8080';
        },

        async checkHealth() {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 2500);
                const res = await fetch(`${this.getBaseUrl()}/api/health`, { signal: controller.signal, cache: 'no-store' });
                clearTimeout(timer);
                return res.ok;
            } catch (e) {
                return false;
            }
        },

        async registerUser(email, password, username, avatar) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 8000);
                const res = await fetch(`${this.getBaseUrl()}/api/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, username, avatar }),
                    signal: controller.signal
                });
                clearTimeout(timer);
                const data = await res.json().catch(() => ({}));
                return { ok: res.ok, status: res.status, data };
            } catch (e) {
                return { ok: false, status: 0, error: e.message || 'خطا در ارتباط با سرور دیتابیس' };
            }
        },

        async loginUser(email, password) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 8000);
                const res = await fetch(`${this.getBaseUrl()}/api/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
                    signal: controller.signal
                });
                clearTimeout(timer);
                const data = await res.json().catch(() => ({}));
                return { ok: res.ok, status: res.status, data };
            } catch (e) {
                return { ok: false, status: 0, error: e.message || 'خطا در ارتباط با سرور دیتابیس' };
            }
        },

        async syncUser(profile) {
            if (!profile || !profile.friendId) return null;
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 4000);
                const res = await fetch(`${this.getBaseUrl()}/api/user/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        friendId: profile.friendId,
                        username: profile.username || 'مهمان کاتان',
                        pin: profile.pin || '',
                        avatar: profile.avatar || 'images/thebearcatan.png',
                        frame: profile.frame || 'frame-wood',
                        title: profile.title || 'مهاجر کاتان',
                        equippedColorIdx: profile.equippedColorIdx !== undefined ? profile.equippedColorIdx : 0,
                        isGuest: !!profile.isGuest
                    }),
                    signal: controller.signal
                });
                clearTimeout(timer);
                if (res.ok) {
                    const data = await res.json();
                    return data.user || null;
                }
            } catch (e) {
                console.warn('[CatanServerAPI] syncUser fallback to local cache:', e.message);
            }
            return null;
        },

        async getLeaderboard() {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 4000);
                const res = await fetch(`${this.getBaseUrl()}/api/leaderboard`, { signal: controller.signal, cache: 'no-store' });
                clearTimeout(timer);
                if (res.ok) {
                    const data = await res.json();
                    return data.leaderboard || [];
                }
            } catch (e) {
                console.warn('[CatanServerAPI] getLeaderboard fallback to local cache:', e.message);
            }
            return null;
        },

        async getFriends(userId) {
            if (!userId) return null;
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 4000);
                const res = await fetch(`${this.getBaseUrl()}/api/friends?userId=${encodeURIComponent(userId)}`, { signal: controller.signal, cache: 'no-store' });
                clearTimeout(timer);
                if (res.ok) {
                    const data = await res.json();
                    return data.friends || [];
                }
            } catch (e) {
                console.warn('[CatanServerAPI] getFriends fallback to local cache:', e.message);
            }
            return null;
        },

        async addFriend(userId, targetFriendId) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);
                const res = await fetch(`${this.getBaseUrl()}/api/friends/add`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, targetFriendId }),
                    signal: controller.signal
                });
                clearTimeout(timer);
                const data = await res.json().catch(() => ({}));
                return { ok: res.ok, status: res.status, data };
            } catch (e) {
                return { ok: false, status: 0, error: e.message };
            }
        },

        async recordGame(gameData) {
            try {
                const res = await fetch(`${this.getBaseUrl()}/api/game/record`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(gameData)
                });
                return res.ok;
            } catch (e) {
                console.warn('[CatanServerAPI] recordGame fallback to local cache:', e.message);
                return false;
            }
        },

        async createPartyRoom(payload) {
            try {
                const res = await fetch(`${this.getBaseUrl()}/api/party/create`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                return await res.json();
            } catch (e) {
                return { ok: false, error: e.message };
            }
        },

        async joinPartyRoom(payload) {
            try {
                const res = await fetch(`${this.getBaseUrl()}/api/party/join`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                return await res.json();
            } catch (e) {
                return { ok: false, error: e.message };
            }
        },

        async sendPartyMessage(payload) {
            try {
                const res = await fetch(`${this.getBaseUrl()}/api/party/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                return await res.json();
            } catch (e) {
                return { ok: false, error: e.message };
            }
        },

        async pollPartyMessages(code, playerId, since = 0) {
            try {
                const url = `${this.getBaseUrl()}/api/party/poll?code=${encodeURIComponent(code)}&playerId=${encodeURIComponent(playerId || '')}&since=${encodeURIComponent(since)}&_t=${Date.now()}`;
                const res = await fetch(url, { cache: 'no-store' });
                return await res.json();
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }
    };

    window.CatanServerAPI = CatanServerAPI;
})(typeof window !== 'undefined' ? window : this);
