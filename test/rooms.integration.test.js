import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';
import { createJamServer } from '../src/server.js';

const TRACK_A = 'https://soundcloud.com/matas/hobnotropic';
const TRACK_B = 'https://soundcloud.com/forss/flickermood';

class Peer {
  constructor(url, identity = {}) {
    this.identity = {
      clientId: randomUUID(), token: randomUUID(), name: 'Listener', ...identity,
    };
    this.socket = new WebSocket(url);
    this.inbox = [];
    this.waiters = new Set();
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.inbox.push(message);
      for (const waiter of this.waiters) waiter();
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate, description = 'message') {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); };
      const check = () => {
        const index = this.inbox.findIndex(predicate);
        if (index < 0) return;
        const [message] = this.inbox.splice(index, 1);
        cleanup();
        resolve(message);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${description}. Inbox: ${JSON.stringify(this.inbox)}`));
      }, 2500);
      this.waiters.add(check);
      check();
    });
  }

  state(predicate = () => true) {
    return this.waitFor((message) => message.type === 'state' && predicate(message.room, message), 'room state');
  }

  async join(roomId) {
    await this.opened;
    this.send({ type: 'join', roomId, ...this.identity });
    return this.state((room) => room.members.some((member) => member.id === this.identity.clientId));
  }

  close() { this.socket.terminate(); }
}

async function fixture(t, options = {}) {
  const app = createJamServer({ port: 0, host: '127.0.0.1', ...options });
  await app.listen();
  const address = app.server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const peers = [];
  t.after(async () => {
    peers.forEach((peer) => peer.close());
    await app.close();
  });
  const response = await fetch(`${origin}/api/rooms`, { method: 'POST' });
  assert.equal(response.status, 201);
  const { roomId } = await response.json();
  assert.equal(typeof roomId, 'string');
  const connect = (identity) => {
    const peer = new Peer(origin.replace('http:', 'ws:') + '/ws', identity);
    peers.push(peer);
    return peer;
  };
  const host = connect({ name: 'Host' });
  const initial = await host.join(roomId);
  assert.equal(initial.room.hostId, host.identity.clientId);
  return { app, origin, roomId, host, connect };
}

test('a friend can add a track and both clients receive the same queue revision', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const guest = connect({ name: 'Friend' });
  await guest.join(roomId);
  guest.send({ type: 'add', url: TRACK_A });
  const [hostState, guestState] = await Promise.all([
    host.state((room) => room.queue.length === 1),
    guest.state((room) => room.queue.length === 1),
  ]);
  assert.deepEqual(hostState.room.queue, guestState.room.queue);
  assert.equal(hostState.room.revision, guestState.room.revision);
  assert.equal(hostState.room.queue[0].addedBy, guest.identity.clientId);
  assert.equal(hostState.room.currentTrackId, hostState.room.queue[0].id);
  assert.equal(hostState.room.playback.playing, false);
  assert.ok(!JSON.stringify(hostState).includes(host.identity.token));
  assert.ok(!JSON.stringify(guestState).includes(guest.identity.token));
});

test('a playlist import is atomic when one of its tracks is invalid', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url: 'https://evil.example/artist/song' }] });
  const error = await host.waitFor((message) => message.type === 'error');
  assert.equal(error.code, 'invalid_url');
  const guest = connect();
  const joined = await guest.join(roomId);
  assert.deepEqual(joined.room.queue, []);
  assert.equal(joined.room.currentTrackId, null);
  host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url: TRACK_B, duration: -1 }] });
  assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'invalid_position');
  host.send({ type: 'add', url: TRACK_B });
  const added = await guest.state((room) => room.queue.length === 1);
  assert.equal(added.room.queue[0].url, TRACK_B);
});

test('a friend can import a playlist with duplicate links skipped and metadata sanitized', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  await host.state((room) => room.queue.length === 1);
  const guest = connect({ name: 'Playlist friend' });
  await guest.join(roomId);
  guest.send({ type: 'add_many', tracks: [
    { url: TRACK_A },
    { url: TRACK_B + '?utm_source=share', title: '\u0000  Second track  ', artist: 'A'.repeat(130), duration: 123456, artwork: 'https://evil.example/image.jpg' },
    { url: TRACK_B, title: 'Duplicated title' },
  ] });
  const [hostState, guestState] = await Promise.all([
    host.state((room) => room.queue.length === 2),
    guest.state((room) => room.queue.length === 2),
  ]);
  assert.deepEqual(hostState.room.queue, guestState.room.queue);
  const imported = hostState.room.queue[1];
  assert.equal(imported.url, TRACK_B);
  assert.equal(imported.title, 'Second track');
  assert.equal(imported.artist.length, 100);
  assert.equal(imported.duration, 123456);
  assert.equal(imported.artwork, null);
  assert.equal(imported.addedBy, guest.identity.clientId);
});

test('playlist imports enforce the queue cap without partially appending tracks', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const tracks = Array.from({ length: 99 }, (_, index) => ({ url: `https://soundcloud.com/artist/track-${index}` }));
  host.send({ type: 'add_many', tracks });
  await host.state((room) => room.queue.length === 99);
  host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url: TRACK_B }] });
  assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'queue_full');
  const guest = connect();
  const joined = await guest.join(roomId);
  assert.equal(joined.room.queue.length, 99);
  assert.ok(joined.room.queue.every((track) => track.url !== TRACK_A && track.url !== TRACK_B));
  host.send({ type: 'add_many', tracks: [...tracks.slice(0, 1), { url: TRACK_A }] });
  const full = await guest.state((room) => room.queue.length === 100);
  assert.equal(full.room.queue.at(-1).url, TRACK_A);
});

test('a friend can ask the whole room to wait, and only the host can resume', async (t) => {
  let timestamp = 100000;
  const { roomId, host, connect } = await fixture(t, { now: () => timestamp });
  host.send({ type: 'add', url: TRACK_A });
  await host.state((room) => room.queue.length === 1);
  const guest = connect({ name: 'Ad listener' });
  await guest.join(roomId);
  host.send({ type: 'control', action: 'play', positionMs: 15000 });
  await guest.state((room) => room.playback.playing);
  timestamp += 2000;
  // A guest cannot substitute their own playback offset or claim automatic ad detection.
  guest.send({ type: 'hold', positionMs: 1, reason: 'advertisement' });
  const [hostState, guestState] = await Promise.all([
    host.state((room) => room.hold !== null), guest.state((room) => room.hold !== null),
  ]);
  assert.deepEqual(hostState.room.playback, guestState.room.playback);
  assert.equal(guestState.room.playback.playing, false);
  assert.equal(guestState.room.playback.positionMs, 17000);
  assert.deepEqual(guestState.room.hold, { memberId: guest.identity.clientId, name: 'Ad listener', reason: 'manual', at: timestamp, wasPlaying: true,
    waiters: [{ memberId: guest.identity.clientId, name: 'Ad listener', ready: false }] });
  guest.send({ type: 'control', action: 'play' });
  assert.equal((await guest.waitFor((message) => message.type === 'error')).code, 'host_only');
  host.send({ type: 'control', action: 'seek', positionMs: 18000 });
  const stillWaiting = await guest.state((room) => room.playback.positionMs === 18000);
  assert.equal(stillWaiting.room.playback.playing, false);
  assert.ok(stillWaiting.room.hold);
  host.send({ type: 'control', action: 'play' });
  assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'room_waiting');
  guest.send({ type: 'hold_ready' });
  await host.state((room) => room.hold?.waiters.every((item) => item.ready));
  host.send({ type: 'control', action: 'play' });
  const resumed = await guest.state((room) => room.playback.playing && room.hold === null);
  assert.equal(resumed.room.playback.positionMs, 18000);
});

test('waiting listeners become ready independently without resuming the shared track', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  await host.state((room) => room.queue.length === 1);
  const first = connect({ name: 'First waiter' });
  const second = connect({ name: 'Second waiter' });
  const bystander = connect({ name: 'Already ready' });
  await first.join(roomId);
  await second.join(roomId);
  await bystander.join(roomId);
  host.send({ type: 'control', action: 'play', positionMs: 12000 });
  await first.state((room) => room.playback.playing);
  first.send({ type: 'hold' });
  const original = await host.state((room) => room.hold?.waiters.length === 1);
  second.send({ type: 'hold' });
  const waiting = await host.state((room) => room.hold?.waiters.length === 2);
  assert.equal(waiting.room.hold.memberId, first.identity.clientId);
  assert.equal(waiting.room.hold.at, original.room.hold.at);
  assert.ok(waiting.room.hold.waiters.every((item) => item.ready === false));
  // The sender's authenticated identity controls readiness, not a supplied memberId.
  bystander.send({ type: 'hold_ready', memberId: first.identity.clientId });
  assert.equal((await bystander.waitFor((message) => message.type === 'error')).code, 'not_waiting');
  first.send({ type: 'hold_ready', memberId: second.identity.clientId });
  const oneReady = await host.state((room) => room.hold?.waiters.some((item) => item.memberId === first.identity.clientId && item.ready));
  assert.equal(oneReady.room.hold.waiters.find((item) => item.memberId === second.identity.clientId).ready, false);
  assert.equal(oneReady.room.playback.playing, false);
  second.send({ type: 'hold_ready' });
  const allReady = await host.state((room) => room.hold?.waiters.length === 2 && room.hold.waiters.every((item) => item.ready));
  assert.equal(allReady.room.playback.playing, false);
  first.send({ type: 'control', action: 'play' });
  assert.equal((await first.waitFor((message) => message.type === 'error')).code, 'host_only');
  host.send({ type: 'control', action: 'play' });
  await second.state((room) => room.playback.playing && room.hold === null);
});

test('guests cannot play, seek, remove tracks, or publish host position', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  const track = (await host.state((room) => room.queue.length === 1)).room.queue[0];
  const guest = connect({ name: 'Friend' });
  await guest.join(roomId);
  for (const message of [
    { type: 'control', action: 'play' },
    { type: 'control', action: 'seek', positionMs: 6000 },
    { type: 'control', action: 'remove', trackId: track.id },
    { type: 'position', trackId: track.id, positionMs: 6000, playing: true },
  ]) {
    guest.send(message);
    const error = await guest.waitFor((event) => event.type === 'error');
    assert.match(error.message, /host/i);
  }
  const witness = connect({ name: 'Witness' });
  const state = await witness.join(roomId);
  assert.equal(state.room.queue.length, 1);
  assert.equal(state.room.playback.playing, false);
  assert.equal(state.room.playback.positionMs, 0);
});

test('a late joiner receives an advancing timeline; pause and seek propagate', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  await host.state((room) => room.queue.length === 1);
  host.send({ type: 'control', action: 'seek', positionMs: 12000 });
  await host.state((room) => room.playback.positionMs === 12000);
  host.send({ type: 'control', action: 'play' });
  await host.state((room) => room.playback.playing);
  await delay(80);
  const guest = connect({ name: 'Late arrival' });
  const joined = await guest.join(roomId);
  const position = joined.room.playback.positionMs + joined.serverTime - joined.room.playback.updatedAt;
  assert.ok(position >= 12050, `late join position should advance: ${position}`);
  assert.ok(position < 14000, `late join position should stay on timeline: ${position}`);
  host.send({ type: 'control', action: 'pause' });
  const paused = await guest.state((room) => !room.playback.playing);
  assert.ok(paused.room.playback.positionMs >= 12050);
  host.send({ type: 'control', action: 'seek', positionMs: 45000 });
  const sought = await guest.state((room) => room.playback.positionMs === 45000);
  assert.equal(sought.room.playback.playing, false);
});

test('skip selects the next queued track and resets its playback position', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  await host.state((room) => room.queue.length === 1);
  host.send({ type: 'add', url: TRACK_B });
  const queued = await host.state((room) => room.queue.length === 2);
  const secondId = queued.room.queue[1].id;
  const guest = connect();
  await guest.join(roomId);
  host.send({ type: 'control', action: 'seek', positionMs: 35000 });
  await host.state((room) => room.playback.positionMs === 35000);
  host.send({ type: 'control', action: 'skip' });
  const skipped = await guest.state((room) => room.currentTrackId === secondId);
  assert.equal(skipped.room.playback.positionMs, 0);
  assert.equal(skipped.room.queue.length, 1);
  assert.equal(skipped.room.queue[0].id, secondId);
});

test('finishing consumes the old track, keeps the next playing, and ignores duplicate completion', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url: TRACK_B }, { url: 'https://soundcloud.com/artist/third-track' }] });
  const queued = await host.state((room) => room.queue.length === 3);
  const [firstId, secondId, thirdId] = queued.room.queue.map((track) => track.id);
  const guest = connect();
  await guest.join(roomId);
  host.send({ type: 'control', action: 'play', positionMs: 45000 });
  await guest.state((room) => room.playback.playing);
  host.send({ type: 'control', action: 'finish', trackId: firstId });
  const advanced = await guest.state((room) => room.currentTrackId === secondId);
  assert.deepEqual(advanced.room.queue.map((track) => track.id), [secondId, thirdId]);
  assert.equal(advanced.room.playback.playing, true);
  assert.equal(advanced.room.playback.positionMs, 0);
  host.send({ type: 'control', action: 'finish', trackId: firstId });
  host.send({ type: 'control', action: 'skip', trackId: firstId });
  host.send({ type: 'ping', sentAt: 7701 });
  await host.waitFor((message) => message.type === 'pong' && message.sentAt === 7701);
  const witness = connect();
  const unchanged = await witness.join(roomId);
  assert.equal(unchanged.room.currentTrackId, secondId);
  assert.equal(unchanged.room.revision, advanced.room.revision + 1, 'only witness join should increment the revision');
  host.send({ type: 'control', action: 'finish', trackId: secondId });
  await guest.state((room) => room.currentTrackId === thirdId);
  host.send({ type: 'control', action: 'finish', trackId: thirdId });
  const ended = await guest.state((room) => room.currentTrackId === null);
  assert.deepEqual(ended.room.queue, []);
  assert.equal(ended.room.playback.playing, false);
  assert.equal(ended.room.playback.positionMs, 0);
  host.send({ type: 'control', action: 'finish', trackId: thirdId });
  host.send({ type: 'ping', sentAt: 7702 });
  await host.waitFor((message) => message.type === 'pong' && message.sentAt === 7702);
});

test('selecting a pending track consumes the old current and preserves the remaining upcoming order', async (t) => {
  const { host } = await fixture(t);
  host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url: TRACK_B }, { url: 'https://soundcloud.com/artist/third-track' }, { url: 'https://soundcloud.com/artist/fourth-track' }] });
  const queued = await host.state((room) => room.queue.length === 4);
  const [firstId, secondId, thirdId, fourthId] = queued.room.queue.map((track) => track.id);
  host.send({ type: 'control', action: 'play' });
  await host.state((room) => room.playback.playing);
  host.send({ type: 'control', action: 'select', trackId: thirdId });
  const selected = await host.state((room) => room.currentTrackId === thirdId);
  assert.deepEqual(selected.room.queue.map((track) => track.id), [thirdId, secondId, fourthId]);
  assert.ok(!selected.room.queue.some((track) => track.id === firstId));
  assert.equal(selected.room.playback.playing, true);
  assert.equal(selected.room.playback.positionMs, 0);
  host.send({ type: 'control', action: 'remove', trackId: thirdId });
  const removed = await host.state((room) => room.currentTrackId === secondId);
  assert.deepEqual(removed.room.queue.map((track) => track.id), [secondId, fourthId]);
  assert.equal(removed.room.playback.playing, true);
});

test('only the host can reorder upcoming tracks without changing the playback timeline', async (t) => {
  let timestamp = 100000;
  const { roomId, host, connect } = await fixture(t, { now: () => timestamp });
  host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url: TRACK_B }, { url: 'https://soundcloud.com/artist/third-track' }] });
  const queued = await host.state((room) => room.queue.length === 3);
  const ids = queued.room.queue.map((track) => track.id);
  const guest = connect();
  await guest.join(roomId);
  host.send({ type: 'control', action: 'play', positionMs: 40000 });
  const playing = await guest.state((room) => room.playback.playing);
  const reorderedIds = [ids[0], ids[2], ids[1]];
  guest.send({ type: 'control', action: 'reorder', trackIds: reorderedIds });
  assert.equal((await guest.waitFor((message) => message.type === 'error')).code, 'host_only');
  timestamp += 2000;
  host.send({ type: 'control', action: 'reorder', trackIds: reorderedIds });
  const reordered = await guest.state((room) => room.queue[1].id === ids[2]);
  assert.deepEqual(reordered.room.queue.map((track) => track.id), reorderedIds);
  assert.equal(reordered.room.currentTrackId, ids[0]);
  assert.deepEqual(reordered.room.playback, playing.room.playback);
  host.send({ type: 'control', action: 'finish', trackId: ids[0] });
  const next = await guest.state((room) => room.currentTrackId === ids[2]);
  assert.equal(next.room.playback.playing, true);
});

test('invalid queue permutations cannot duplicate, lose, or move the current track', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url: TRACK_B }, { url: 'https://soundcloud.com/artist/third-track' }] });
  const queued = await host.state((room) => room.queue.length === 3);
  const ids = queued.room.queue.map((track) => track.id);
  for (const order of [[ids[0], ids[1]], [ids[0], ids[1], ids[1]], [ids[0], ids[1], 'unknown'], [ids[1], ids[0], ids[2]]]) {
    host.send({ type: 'control', action: 'reorder', trackIds: order });
    const error = await host.waitFor((message) => message.type === 'error');
    assert.ok(['invalid_order', 'current_track_locked'].includes(error.code));
  }
  const guest = connect();
  const unchanged = await guest.join(roomId);
  assert.deepEqual(unchanged.room.queue.map((track) => track.id), ids);
  assert.deepEqual(unchanged.room.playback, queued.room.playback);
  assert.equal(unchanged.room.revision, queued.room.revision + 1);
});

test('waiting survives track changes, departed waiters become ready, and an empty queue clears the hold', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url: TRACK_B }] });
  const queued = await host.state((room) => room.queue.length === 2);
  const firstId = queued.room.currentTrackId;
  const waiter = connect({ name: 'Leaving listener' });
  await waiter.join(roomId);
  host.send({ type: 'control', action: 'play' });
  await waiter.state((room) => room.playback.playing);
  waiter.send({ type: 'hold' });
  await host.state((room) => Boolean(room.hold));
  host.send({ type: 'control', action: 'finish', trackId: firstId });
  host.send({ type: 'ping', sentAt: 8801 });
  await host.waitFor((message) => message.type === 'pong' && message.sentAt === 8801);
  host.send({ type: 'control', action: 'skip', trackId: firstId });
  const skipped = await host.state((room) => room.currentTrackId !== firstId);
  assert.equal(skipped.room.queue.length, 1);
  assert.equal(skipped.room.playback.playing, false);
  assert.equal(skipped.room.hold.wasPlaying, true);
  host.send({ type: 'control', action: 'play' });
  assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'room_waiting');
  waiter.close();
  const departed = await host.state((room) => room.hold?.waiters.every((item) => item.ready));
  assert.equal(departed.room.playback.playing, false);
  host.send({ type: 'control', action: 'play' });
  await host.state((room) => room.playback.playing && room.hold === null);
  host.send({ type: 'control', action: 'remove', trackId: skipped.room.currentTrackId });
  const emptied = await host.state((room) => room.queue.length === 0);
  assert.equal(emptied.room.currentTrackId, null);
  assert.equal(emptied.room.playback.playing, false);
  assert.equal(emptied.room.hold, null);
});

test('listeners without a selected name are called User instead of exposing identity fragments', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const blank = connect({ name: '  \u0000  ' });
  const joined = await blank.join(roomId);
  const member = joined.room.members.find((item) => item.id === blank.identity.clientId);
  assert.equal(member.name, 'User');
  assert.ok(!member.name.includes(blank.identity.clientId.slice(0, 4)));
  await host.state((room) => room.members.some((item) => item.name === 'User'));
});

test('an old asynchronous position sample cannot undo a newer seek', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  await host.state((room) => room.queue.length === 1);
  host.send({ type: 'control', action: 'play' });
  const sampled = await host.state((room) => room.playback.playing);
  host.send({ type: 'control', action: 'seek', positionMs: 80000 });
  const sought = await host.state((room) => room.playback.positionMs === 80000);
  host.send({ type: 'position', trackId: sampled.room.currentTrackId, positionMs: 1000,
    playing: true, baseRevision: sampled.room.revision });
  // A following ping is a socket-order barrier: the server must process the old sample first.
  host.send({ type: 'ping', sentAt: 9191 });
  await host.waitFor((message) => message.type === 'pong' && message.sentAt === 9191);
  const guest = connect();
  const joined = await guest.join(roomId);
  assert.equal(joined.room.playback.positionMs, 80000);
  // Joining itself increments revision once; the rejected stale sample must not mutate it.
  assert.equal(joined.room.revision, sought.room.revision + 1);
});

test('rejoining with the same identity keeps host ownership after the old socket closes', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const replacement = connect(host.identity);
  const state = await replacement.join(roomId);
  assert.equal(state.room.hostId, host.identity.clientId);
  host.close();
  await delay(30);
  replacement.send({ type: 'add', url: TRACK_A });
  const updated = await replacement.state((room) => room.queue.length === 1);
  assert.equal(updated.room.hostId, replacement.identity.clientId);
  assert.equal(updated.room.members.filter((member) => member.id === host.identity.clientId).length, 1);
  assert.equal(updated.room.members.find((member) => member.id === host.identity.clientId).connected, true);
});

test('knowing a room link and client ID cannot steal an existing identity', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const imposter = connect({ ...host.identity, token: randomUUID() });
  await imposter.opened;
  imposter.send({ type: 'join', roomId, ...imposter.identity });
  const error = await imposter.waitFor((message) => message.type === 'error');
  assert.match(error.message, /identity|token|session|reconnect/i);
  host.send({ type: 'add', url: TRACK_A });
  const updated = await host.state((room) => room.queue.length === 1);
  assert.equal(updated.room.hostId, host.identity.clientId);
});

test('a connected friend becomes host after the disconnected host grace period', async (t) => {
  const { roomId, host, connect } = await fixture(t, { hostGraceMs: 40 });
  const guest = connect({ name: 'New host' });
  await guest.join(roomId);
  host.close();
  const elected = await guest.state((room) => room.hostId === guest.identity.clientId);
  assert.equal(elected.room.members.find((member) => member.id === guest.identity.clientId).connected, true);
  guest.send({ type: 'add', url: TRACK_A });
  await guest.state((room) => room.queue.length === 1);
  guest.send({ type: 'control', action: 'play' });
  const playing = await guest.state((room) => room.playback.playing);
  assert.equal(playing.room.hostId, guest.identity.clientId);
});

test('invalid track links and non-finite positions cannot corrupt the room', async (t) => {
  const { host } = await fixture(t);
  for (const url of [
    'https://evil.example/song',
    'https://soundcloud.com.evil.example/artist/track',
    'javascript:alert(1)',
    'https://soundcloud.com/matas',
    'https://soundcloud.com/matas/sets/album',
  ]) {
    host.send({ type: 'add', url });
    await host.waitFor((message) => message.type === 'error');
  }
  host.send({ type: 'add', url: TRACK_A });
  await host.state((room) => room.queue.length === 1);
  host.send({ type: 'control', action: 'seek', positionMs: 'Infinity' });
  await host.waitFor((message) => message.type === 'error');
  host.send({ type: 'ping', sentAt: 12345 });
  const pong = await host.waitFor((message) => message.type === 'pong');
  assert.equal(pong.sentAt, 12345);
  assert.ok(Number.isFinite(pong.serverTime));
});

test('HTTP only exposes public assets and rejects unknown rooms', async (t) => {
  const { origin, roomId } = await fixture(t);
  const existing = await fetch(`${origin}/api/rooms/${roomId}`);
  assert.equal(existing.status, 200);
  assert.equal((await existing.json()).roomId, roomId);
  const invite = await fetch(`${origin}/room/${roomId}`);
  assert.equal(invite.status, 200, 'a copied invite must work when opened directly in another browser');
  assert.match(invite.headers.get('content-type'), /text\/html/);
  const unknown = await fetch(`${origin}/api/rooms/not-a-real-room`);
  assert.equal(unknown.status, 404);
  for (const path of ['/src/server.js', '/package.json', '/%2e%2e%2fpackage.json', '/%2e%2e%5cpackage.json']) {
    const response = await fetch(origin + path);
    assert.ok([400, 403, 404].includes(response.status), `${path} returned ${response.status}`);
  }
});
