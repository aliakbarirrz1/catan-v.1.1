/**
 * The Bears Catan - Server-Side Multiplayer Room & Message Relay Engine
 * Guarantees 100% cross-IP, NAT-proof lobby & gameplay synchronization
 * even when WebRTC P2P / TURN is blocked by mobile CGNAT or ISP firewalls.
 */

const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const MAX_MESSAGES_PER_ROOM = 300;

function createRoomRelayManager() {
    const rooms = new Map();

    function normalizeCode(raw) {
        if (!raw && raw !== 0) return '';
        let str = String(raw).trim();
        str = str.replace(/[\u06F0-\u06F9]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x06F0 + 48));
        str = str.replace(/[\u0660-\u0669]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x0660 + 48));
        return str.replace(/[^a-zA-Z0-9_-]/g, '');
    }

    function cleanupExpiredRooms(now = Date.now()) {
        for (const [code, room] of rooms.entries()) {
            if (now - room.updatedAt > ROOM_TTL_MS) {
                rooms.delete(code);
            }
        }
    }

    function appendMessage(room, fromId, target, payload) {
        room.lastSeq += 1;
        const msg = {
            seq: room.lastSeq,
            fromId: String(fromId || ''),
            target: String(target || 'ALL'),
            payload,
            timestamp: Date.now()
        };
        room.messages.push(msg);
        if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
            room.messages.shift();
        }
        room.updatedAt = Date.now();
        return msg;
    }

    function createOrUpdateRoom({ code, hostId, hostName, hostColorIdx = 0, players = null, seed = null }) {
        cleanupExpiredRooms();
        const cleanCode = normalizeCode(code);
        if (!cleanCode) {
            return { ok: false, error: 'کد پارتی نامعتبر است.' };
        }

        let room = rooms.get(cleanCode);
        const now = Date.now();

        const defaultHostPlayer = {
            id: hostId || 'host_1',
            name: hostName || 'میزبان',
            colorIdx: Number.isInteger(hostColorIdx) ? hostColorIdx : 0,
            vp: 0,
            hiddenVP: 0,
            isBot: false,
            freeSettlements: 2,
            freeRoads: 2,
            settlementsLeft: 5,
            citiesLeft: 4,
            roadsLeft: 15,
            knights: 0,
            resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }
        };

        if (!room) {
            room = {
                code: cleanCode,
                hostId: hostId || defaultHostPlayer.id,
                players: Array.isArray(players) && players.length > 0 ? players : [defaultHostPlayer],
                seed: seed || null,
                launched: null,
                gameStarted: false,
                startGamePayload: null,
                gameStateSnapshot: null,
                lastSeq: 0,
                messages: [],
                createdAt: now,
                updatedAt: now
            };
            rooms.set(cleanCode, room);
        } else {
            if (hostId) room.hostId = hostId;
            if (Array.isArray(players) && players.length > 0) {
                // Preserve existing human guests if host re-registers on page transition with only 1 player
                if (players.length === 1 && room.players.length > 1) {
                    const hostEntry = players[0];
                    const existingIdx = room.players.findIndex(p => p.id === hostEntry.id || (!p.isBot && room.players.indexOf(p) === 0));
                    if (existingIdx >= 0) {
                        room.players[existingIdx] = { ...room.players[existingIdx], ...hostEntry };
                    }
                } else {
                    room.players = players;
                }
            }
            if (seed) room.seed = seed;
            room.updatedAt = now;
        }

        return {
            ok: true,
            room: getPublicRoomState(room),
            lastSeq: room.lastSeq
        };
    }

    function getNextFreeColorIdx(players) {
        const used = new Set((players || []).map(p => p.colorIdx));
        for (let i = 0; i < 4; i++) {
            if (!used.has(i)) return i;
        }
        return (players || []).length % 4;
    }

    function joinRoom({ code, playerId, playerName, colorIdx }) {
        cleanupExpiredRooms();
        const cleanCode = normalizeCode(code);
        if (!cleanCode) {
            return { ok: false, status: 400, error: 'کد پارتی الزامی است.' };
        }

        const room = rooms.get(cleanCode);
        if (!room) {
            return { ok: false, status: 404, error: `اتاقی با کد #${cleanCode} یافت نشد.` };
        }

        const pId = String(playerId || `guest_${Date.now()}`);
        const pName = String(playerName || 'مهمان').trim() || 'مهمان';

        let existing = room.players.find(
            p => p.id === pId || (!p.isBot && p.id !== room.hostId && p.name && p.name.trim().toLowerCase() === pName.toLowerCase())
        );

        if (!existing) {
            if (room.players.length < 4) {
                const chosenColor = (colorIdx !== undefined && !room.players.some(p => p.colorIdx === Number(colorIdx)))
                    ? Number(colorIdx)
                    : getNextFreeColorIdx(room.players);

                existing = {
                    id: pId,
                    name: pName,
                    colorIdx: chosenColor,
                    vp: 0,
                    hiddenVP: 0,
                    isBot: false,
                    freeSettlements: 2,
                    freeRoads: 2,
                    settlementsLeft: 5,
                    citiesLeft: 4,
                    roadsLeft: 15,
                    knights: 0,
                    resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }
                };
                room.players.push(existing);
            } else {
                // Check if there is a bot we can replace
                const botCandidate = room.players.find(p => p.isBot);
                if (botCandidate) {
                    botCandidate.isBot = false;
                    botCandidate.id = pId;
                    botCandidate.name = pName;
                    existing = botCandidate;
                } else {
                    return { ok: false, status: 409, error: 'ظرفیت این پارتی (۴ بازیکن) تکمیل است.' };
                }
            }
        } else {
            existing.id = pId;
            existing.name = pName;
        }

        const joinSeqBefore = room.lastSeq;

        // Queue JOIN_REQ for the Host and LOBBY_UPDATE for all players
        appendMessage(room, pId, 'HOST', {
            type: 'JOIN_REQ',
            id: existing.id,
            name: existing.name,
            colorIdx: existing.colorIdx,
            _msgId: `srv_join_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        });

        appendMessage(room, room.hostId, 'ALL', {
            type: 'LOBBY_UPDATE',
            players: room.players,
            _msgId: `srv_lobby_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        });

        return {
            ok: true,
            player: existing,
            room: getPublicRoomState(room),
            lastSeq: joinSeqBefore
        };
    }

    function sendMessage({ code, fromId, target = 'ALL', payload }) {
        cleanupExpiredRooms();
        const cleanCode = normalizeCode(code);
        if (!cleanCode || !payload || typeof payload !== 'object') {
            return { ok: false, status: 400, error: 'اطلاعات پیام نامعتبر است.' };
        }

        let room = rooms.get(cleanCode);
        if (!room) {
            // Auto-create room if host sends message first
            createOrUpdateRoom({ code: cleanCode, hostId: fromId });
            room = rooms.get(cleanCode);
        }

        if (!payload._msgId) {
            payload._msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }

        if (payload.type === 'LOBBY_UPDATE' && Array.isArray(payload.players)) {
            room.players = payload.players;
        } else if (payload.type === 'LAUNCH_GAME') {
            room.launched = {
                room: cleanCode,
                color: payload.color,
                seed: payload.seed,
                players: payload.players || room.players,
                timestamp: Date.now()
            };
            if (payload.seed) room.seed = payload.seed;
            if (Array.isArray(payload.players)) room.players = payload.players;
        } else if (payload.type === 'START_GAME') {
            room.gameStarted = true;
            room.startGamePayload = payload;
            if (Array.isArray(payload.players)) room.players = payload.players;
            if (payload.seed) room.seed = payload.seed;
        } else if (payload.type === 'GAME_STATE_SYNC') {
            room.gameStarted = true;
            room.gameStateSnapshot = payload;
            if (Array.isArray(payload.players)) room.players = payload.players;
            if (payload.seed) room.seed = payload.seed;
        }

        const msg = appendMessage(room, fromId, target, payload);
        return {
            ok: true,
            seq: msg.seq,
            room: getPublicRoomState(room)
        };
    }

    function pollMessages({ code, playerId, since = 0 }) {
        cleanupExpiredRooms();
        const cleanCode = normalizeCode(code);
        if (!cleanCode) {
            return { ok: false, status: 400, error: 'کد پارتی الزامی است.' };
        }

        const room = rooms.get(cleanCode);
        if (!room) {
            return { ok: false, status: 404, error: 'اتاق یافت نشد.' };
        }

        const sinceSeq = Number(since) || 0;
        const pId = String(playerId || '');
        const isHost = Boolean(pId && pId === room.hostId);

        const messages = room.messages.filter(m => {
            if (m.seq <= sinceSeq) return false;
            if (pId && m.fromId === pId) return false;
            if (m.target === 'ALL') return true;
            if (m.target === 'HOST' && isHost) return true;
            if (pId && m.target === pId) return true;
            return false;
        });

        room.updatedAt = Date.now();

        return {
            ok: true,
            code: room.code,
            lastSeq: room.lastSeq,
            messages: messages.map(m => m.payload),
            room: getPublicRoomState(room)
        };
    }

    function getPublicRoomState(room) {
        return {
            code: room.code,
            hostId: room.hostId,
            players: room.players,
            seed: room.seed,
            launched: room.launched,
            gameStarted: room.gameStarted,
            startGamePayload: room.startGamePayload,
            gameStateSnapshot: room.gameStateSnapshot,
            lastSeq: room.lastSeq,
            createdAt: room.createdAt,
            updatedAt: room.updatedAt
        };
    }

    function listAllRooms() {
        cleanupExpiredRooms();
        const result = [];
        for (const room of rooms.values()) {
            const players = Array.isArray(room.players) ? room.players : [];
            const humanPlayers = players.filter(p => !p.isBot);
            const botPlayers = players.filter(p => p.isBot);
            const hostPlayer = players.find(p => p.id === room.hostId) || players[0] || null;
            let status = 'waiting';
            if (room.gameStarted) status = 'in_game';
            else if (room.launched) status = 'launched';

            result.push({
                code: room.code,
                hostId: room.hostId,
                hostName: hostPlayer ? hostPlayer.name : 'میزبان',
                players,
                humanCount: humanPlayers.length,
                botCount: botPlayers.length,
                totalPlayers: players.length,
                seed: room.seed,
                status,
                gameStarted: Boolean(room.gameStarted),
                launched: Boolean(room.launched),
                lastSeq: room.lastSeq,
                messageCount: room.messages.length,
                recentMessages: room.messages.slice(-40).reverse(),
                createdAt: room.createdAt,
                updatedAt: room.updatedAt
            });
        }
        return result.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    function deleteRoom(code) {
        const cleanCode = normalizeCode(code);
        if (!cleanCode) return { ok: false, error: 'کد اتاق نامعتبر است.' };
        const existed = rooms.delete(cleanCode);
        return { ok: existed, deletedCode: cleanCode };
    }

    function broadcastSystemMessage({ code = 'ALL', text, senderName = 'سیستم مدیریت' }) {
        cleanupExpiredRooms();
        const msgText = String(text || '').trim();
        if (!msgText) return { ok: false, error: 'متن پیام خالی است.' };

        const targetRooms = [];
        if (code === 'ALL' || !code) {
            for (const r of rooms.values()) targetRooms.push(r);
        } else {
            const cleanCode = normalizeCode(code);
            const r = rooms.get(cleanCode);
            if (r) targetRooms.push(r);
        }

        if (targetRooms.length === 0) {
            return { ok: false, error: 'اتاق فعالی برای ارسال پیام یافت نشد.' };
        }

        for (const r of targetRooms) {
            appendMessage(r, 'ADMIN_SYSTEM', 'ALL', {
                type: 'CHAT_MSG',
                sender: senderName,
                text: msgText,
                colorIdx: 0,
                isSystem: true,
                _msgId: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
            });
        }

        return { ok: true, sentToRooms: targetRooms.map(r => r.code) };
    }

    return {
        normalizeCode,
        createOrUpdateRoom,
        joinRoom,
        sendMessage,
        pollMessages,
        listAllRooms,
        deleteRoom,
        broadcastSystemMessage,
        _rooms: rooms
    };
}

module.exports = { createRoomRelayManager };
