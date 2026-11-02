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
