import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomRelayManager } from './room_relay.js';

test('normalizes Persian and Arabic digits in party codes', () => {
    const relay = createRoomRelayManager();
    assert.equal(relay.normalizeCode(' ۴۸۲۱ '), '4821');
    assert.equal(relay.normalizeCode('٤٨٢١'), '4821');
});

test('host creates room and guest from different IP joins and receives lobby updates', () => {
    const relay = createRoomRelayManager();

    const hostRes = relay.createOrUpdateRoom({
        code: '4821',
        hostId: 'p_host',
        hostName: 'آرش (میزبان)',
        hostColorIdx: 0
    });
    assert.equal(hostRes.ok, true);
    assert.equal(hostRes.room?.players.length, 1);

    const guestRes = relay.joinRoom({
        code: '۴۸۲۱',
        playerId: 'p_guest_1',
        playerName: 'سهراب (مهمان)',
        colorIdx: 2
    });
    assert.equal(guestRes.ok, true);
    assert.equal(guestRes.room?.players.length, 2);
    assert.equal(guestRes.room?.players[1].name, 'سهراب (مهمان)');
    assert.equal(guestRes.room?.players[1].colorIdx, 2);

    // Host polls and receives JOIN_REQ + LOBBY_UPDATE
    const hostPoll = relay.pollMessages({ code: '4821', playerId: 'p_host', since: 0 });
    assert.equal(hostPoll.ok, true);
    assert.equal(hostPoll.messages?.some((m: { type: string }) => m.type === 'JOIN_REQ'), true);

    // Guest polls from joinSeqBefore and receives LOBBY_UPDATE
    const guestPoll = relay.pollMessages({ code: '4821', playerId: 'p_guest_1', since: guestRes.lastSeq });
    assert.equal(guestPoll.ok, true);
    assert.equal(guestPoll.messages?.some((m: { type: string }) => m.type === 'LOBBY_UPDATE'), true);
});

test('preserves guest players when host transitions from index.html to game.html', () => {
    const relay = createRoomRelayManager();
    relay.createOrUpdateRoom({
        code: '7755',
        hostId: 'p_host',
        hostName: 'میزبان',
        hostColorIdx: 0
    });
    relay.joinRoom({
        code: '7755',
        playerId: 'p_guest',
        playerName: 'مهمان',
        colorIdx: 1
    });

    // Host launches game in index.html
    relay.sendMessage({
        code: '7755',
        fromId: 'p_host',
        target: 'ALL',
        payload: {
            type: 'LAUNCH_GAME',
            room: '7755',
            color: 0,
            seed: 123456
        }
    });

    // Host opens game.html and calls createOrUpdateRoom again with initial single player array
    const reHost = relay.createOrUpdateRoom({
        code: '7755',
        hostId: 'p_host',
        hostName: 'میزبان',
        hostColorIdx: 0,
        players: [{ id: 'p_host', name: 'میزبان', colorIdx: 0, isBot: false }]
    });

    assert.equal(reHost.ok, true);
    assert.equal(reHost.room?.players.length, 2);
    assert.equal(reHost.room?.seed, 123456);
    assert.equal(reHost.room?.launched?.seed, 123456);
});

test('admin listAllRooms, broadcastSystemMessage, and deleteRoom work accurately', () => {
    const relay = createRoomRelayManager();
    relay.createOrUpdateRoom({
        code: '9012',
        hostId: 'host_90',
        hostName: 'کاوه',
        hostColorIdx: 0
    });
    relay.joinRoom({
        code: '9012',
        playerId: 'guest_90',
        playerName: 'رستم',
        colorIdx: 1
    });

    const listBefore = relay.listAllRooms();
    assert.equal(listBefore.length, 1);
    assert.equal(listBefore[0].code, '9012');
    assert.equal(listBefore[0].humanCount, 2);
    assert.equal(listBefore[0].status, 'waiting');

    const bcast = relay.broadcastSystemMessage({ code: '9012', text: 'مسابقه تا ۵ دقیقه دیگر آغاز می‌شود' });
    assert.equal(bcast.ok, true);

    const poll = relay.pollMessages({ code: '9012', playerId: 'guest_90', since: 0 });
    assert.equal(poll.messages?.some((m: { type: string; text?: string }) => m.type === 'CHAT_MSG' && m.text?.includes('مسابقه')), true);

    const delRes = relay.deleteRoom('۹۰۱۲');
    assert.equal(delRes.ok, true);
    assert.equal(relay.listAllRooms().length, 0);
});
