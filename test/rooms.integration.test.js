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
  assert.equal(hostState.room.playback.playing, true);
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
  host.send({ type: 'add', url: TRACK_B });
  assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'queue_full');
});

test('playlist imports retain ID-only tracks through the 100-track cap and play them normally', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const guest = connect({ name: 'Playlist friend' });
  await guest.join(roomId);
  const tracks = Array.from({ length: 100 }, (_, index) => index < 5
    ? { url: `https://soundcloud.com/artist/playlist-${index}`, title: `Full track ${index + 1}` }
    : { url: `https://api.soundcloud.com/tracks/${2000000 + index}` });
  tracks[5].url += '?utm_source=share';
  tracks[5].title = 'Playlist track 6';
  guest.send({ type: 'add_many', tracks });
  const imported = await host.state((room) => room.queue.length === 100);
  assert.equal(imported.room.queue.filter((track) => track.url.startsWith('https://api.soundcloud.com/tracks/')).length, 95);
  assert.equal(imported.room.queue[5].url, 'https://api.soundcloud.com/tracks/2000005');
  assert.equal(imported.room.queue[5].soundcloudId, '2000005');
  assert.equal(imported.room.queue[5].title, 'Playlist track 6');
  assert.equal(imported.room.queue[6].title, 'SoundCloud track 2000006');
  assert.equal(imported.room.queue[6].artist, 'SoundCloud');
  assert.ok(imported.room.queue.every((track) => track.addedBy === guest.identity.clientId && track.addedByName === 'Playlist friend'));
  assert.equal(imported.room.playback.playing, true);
  host.send({ type: 'add', url: 'https://api.soundcloud.com/tracks/2000100' });
  assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'queue_full');
  host.send({ type: 'add_many', tracks: [{ url: 'https://api.soundcloud.com/tracks/2000100' }] });
  assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'queue_full');
  const selected = imported.room.queue[5];
  host.send({ type: 'control', action: 'select', trackId: selected.id });
  const playing = await host.state((room) => room.currentTrackId === selected.id);
  assert.equal(playing.room.queue[0].url, selected.url);
  assert.equal(playing.room.playback.playing, true);
  host.send({ type: 'metadata', trackId: selected.id, title: 'Resolved track title', artist: 'Resolved artist', duration: 123456, permalinkUrl: 'https://soundcloud.com/artist/resolved-track?utm_source=share' });
  const hydrated = await guest.state((room) => room.queue[0].title === 'Resolved track title');
  assert.equal(hydrated.room.queue[0].artist, 'Resolved artist');
  assert.equal(hydrated.room.queue[0].permalinkUrl, 'https://soundcloud.com/artist/resolved-track');
  assert.equal(hydrated.room.queue[0].url, selected.url, 'resolving a public link must retain the playback source');
  assert.equal(hydrated.room.queue[0].addedByName, 'Playlist friend');
});

test('ID-only track references reject malformed and private API addresses atomically', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  for (const url of [
    'http://api.soundcloud.com/tracks/293',
    'https://api.soundcloud.com/tracks/0',
    'https://api.soundcloud.com/tracks/-293',
    'https://api.soundcloud.com/tracks/0293',
    'https://api.soundcloud.com/tracks/1.5',
    'https://api.soundcloud.com/tracks/123456789012345678901',
    'https://api.soundcloud.com/tracks/293/stream',
    'https://api.soundcloud.com/playlists/293',
    'https://api.soundcloud.com/tracks/%32%39%33',
    'https://api.soundcloud.com:444/tracks/293',
    'https://user:password@api.soundcloud.com/tracks/293',
    'https://api.soundcloud.com.evil.example/tracks/293',
    'https://api.soundcloud.com/tracks/293?secret_token=s-private',
  ]) {
    host.send({ type: 'add_many', tracks: [{ url: TRACK_A }, { url }] });
    const error = await host.waitFor((message) => message.type === 'error');
    assert.equal(error.code, url.includes('secret_token') ? 'private_track' : 'invalid_url', url);
  }
  const guest = connect();
  const empty = await guest.join(roomId);
  assert.deepEqual(empty.room.queue, []);
  host.send({ type: 'add', url: 'https://api.soundcloud.com/tracks/293?utm_source=share' });
  const added = await guest.state((room) => room.queue.length === 1);
  assert.equal(added.room.queue[0].url, 'https://api.soundcloud.com/tracks/293');
  host.send({ type: 'add', url: 'https://api.soundcloud.com/tracks/293' });
  assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'duplicate_track');
});

test('playlist deduplication shares validated track IDs and permalinks without trusting attribution', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  const initial = await host.state((room) => room.queue.length === 1);
  host.send({ type: 'metadata', trackId: initial.room.queue[0].id, soundcloudId: 'soundcloud:tracks:293', permalinkUrl: TRACK_A });
  await host.state((room) => room.queue[0].soundcloudId === '293');
  const guest = connect({ name: 'Playlist friend' });
  await guest.join(roomId);
  guest.send({ type: 'add_many', tracks: [
    { url: 'https://api.soundcloud.com/tracks/293', title: 'Already queued by public link' },
    { url: TRACK_B, soundcloudId: 42, permalinkUrl: TRACK_B + '?utm_source=share' },
    { url: 'https://api.soundcloud.com/tracks/42', title: 'Already imported by ID' },
    { url: 'https://api.soundcloud.com/tracks/43', soundcloudId: '999', addedBy: host.identity.clientId, addedByName: 'Forged', permalinkUrl: 'https://evil.example/fake' },
  ] });
  const imported = await host.state((room) => room.queue.length === 3);
  assert.equal(imported.room.queue[1].soundcloudId, '42');
  assert.equal(imported.room.queue[1].permalinkUrl, TRACK_B);
  assert.equal(imported.room.queue[2].soundcloudId, '43', 'the API source ID overrides supplied metadata');
  assert.equal(imported.room.queue[2].permalinkUrl, undefined);
  assert.equal(imported.room.queue[2].addedBy, guest.identity.clientId);
  assert.equal(imported.room.queue[2].addedByName, 'Playlist friend');
  guest.send({ type: 'add', url: 'https://api.soundcloud.com/tracks/42' });
  assert.equal((await guest.waitFor((message) => message.type === 'error')).code, 'duplicate_track');
  host.send({ type: 'metadata', trackId: imported.room.queue[2].id, soundcloudId: '999', permalinkUrl: 'https://soundcloud.com/artist/third-track' });
  const updated = await guest.state((room) => room.queue[2].permalinkUrl === 'https://soundcloud.com/artist/third-track');
  assert.equal(updated.room.queue[2].soundcloudId, '43');
  guest.send({ type: 'add', url: 'https://soundcloud.com/artist/third-track' });
  assert.equal((await guest.waitFor((message) => message.type === 'error')).code, 'duplicate_track');
  guest.send({ type: 'add_many', tracks: [
    { url: 'https://soundcloud.com/artist/unsafe-number', soundcloudId: Number.MAX_SAFE_INTEGER + 1, permalinkUrl: 'https://api.soundcloud.com/tracks/294' },
    { url: 'https://soundcloud.com/artist/invalid-id', soundcloudId: 'soundcloud:tracks:0', permalinkUrl: 'https://soundcloud.com/artist/private?secret_token=s-secret' },
  ] });
  const sanitized = await host.state((room) => room.queue.length === 5);
  assert.ok(sanitized.room.queue.slice(3).every((track) => track.soundcloudId === undefined && track.permalinkUrl === undefined), 'invalid optional metadata is ignored');
});

test('guests cannot seek, remove tracks, or publish host position', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  const track = (await host.state((room) => room.queue.length === 1)).room.queue[0];
  const guest = connect({ name: 'Friend' });
  await guest.join(roomId);
  for (const message of [
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
  assert.equal(state.room.playback.playing, true);
  assert.ok(state.room.playback.positionMs >= 0);
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
  const last = await host.state((room) => room.currentTrackId === thirdId);
  host.send({ type: 'control', action: 'finish', trackId: thirdId, generation: last.room.playback.generation });
  const repeated = await guest.state((room) => room.currentTrackId === thirdId && room.playback.generation > last.room.playback.generation);
  assert.equal(repeated.room.queue.length, 1);
  assert.equal(repeated.room.playback.playing, true);
  assert.equal(repeated.room.playback.positionMs, 0);
  host.send({ type: 'control', action: 'finish', trackId: thirdId, generation: last.room.playback.generation });
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

test('selecting another track during queue repeat preserves every queued song', async (t) => {
  const { host } = await fixture(t);
  const queued = await addQueue(host, 3);
  const [firstId, secondId, thirdId] = queued.room.queue.map((track) => track.id);
  host.send({ type: 'control', action: 'repeat', mode: 'queue' });
  await host.state((room) => room.repeatMode === 'queue');
  host.send({ type: 'control', action: 'play', positionMs: 12000 });
  const playing = await host.state((room) => room.playback.playing && room.playback.positionMs === 12000);
  host.send({ type: 'control', action: 'select', trackId: thirdId });
  const selected = await host.state((room) => room.currentTrackId === thirdId);
  assert.deepEqual(selected.room.queue.map((track) => track.id), [thirdId, secondId, firstId]);
  assert.equal(selected.room.playback.positionMs, 0);
  assert.equal(selected.room.playback.generation, playing.room.playback.generation + 1);
  assert.equal(selected.room.playback.playing, true);
  host.send({ type: 'control', action: 'remove', trackId: thirdId });
  const removed = await host.state((room) => room.currentTrackId === secondId);
  assert.deepEqual(removed.room.queue.map((track) => track.id), [secondId, firstId]);
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

test('a connected friend becomes host immediately after the host disconnects', async (t) => {
  const { roomId, host, connect } = await fixture(t);
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

async function addQueue(host, count = 3) {
  host.send({ type: 'add_many', tracks: Array.from({ length: count }, (_, index) => ({ url: `https://soundcloud.com/artist/track-${index}` })) });
  return host.state((room) => room.queue.length === count);
}

let barrierSerial = 10_000;
async function barrier(peer) {
  const sentAt = ++barrierSerial;
  peer.send({ type: 'ping', sentAt });
  await peer.waitFor((message) => message.type === 'pong' && message.sentAt === sentAt);
}

test('guest pause uses the server timeline and hosts are exempt even while a guest is limited', async (t) => {
  let timestamp = 10_000;
  const { roomId, host, connect } = await fixture(t, { now: () => timestamp });
  const queued = await addQueue(host, 2);
  const guest = connect({ name: 'Pausing friend' });
  await guest.join(roomId);
  host.send({ type: 'control', action: 'play', positionMs: 5000 });
  const playing = await host.state((room) => room.playback.playing && room.playback.positionMs === 5000);
  timestamp += 2000;
  guest.send({ type: 'control', action: 'pause', positionMs: 999999 });
  let paused = await host.state((room) => !room.playback.playing && room.revision > playing.room.revision);
  assert.equal(paused.room.playback.positionMs, 7000, 'guest offsets cannot seek the shared song');
  assert.equal(paused.room.playback.generation, queued.room.playback.generation);
  for (let index = 0; index < 5; index++) {
    guest.send({ type: 'control', action: index % 2 ? 'pause' : 'play' });
    paused = await host.state((room) => room.revision > paused.room.revision);
  }
  guest.send({ type: 'control', action: 'pause' });
  const limited = await guest.waitFor((message) => message.type === 'error');
  assert.equal(limited.code, 'pause_rate_limited');
  assert.equal(limited.retryAfterMs, 5000);
  for (let index = 0; index < 20; index++) {
    host.send({ type: 'control', action: index % 2 ? 'pause' : 'play' });
    paused = await host.state((room) => room.revision > paused.room.revision);
  }
  guest.close();
  paused = await host.state((room) => room.members.filter((member) => member.connected).length === 1 && room.revision > paused.room.revision);
  for (let index = 0; index < 7; index++) {
    host.send({ type: 'control', action: 'pause' });
    paused = await host.state((room) => room.revision > paused.room.revision);
  }
  timestamp += 5000;
  const rejoined = connect(guest.identity);
  await rejoined.join(roomId);
  rejoined.send({ type: 'control', action: 'pause' });
  await rejoined.state((room) => room.revision > paused.room.revision + 1);
});

test('either listener in a two-person room skips directly and starts the next track', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const queued = await addQueue(host, 3);
  const guest = connect();
  await guest.join(roomId);
  guest.send({ type: 'control', action: 'skip', trackId: queued.room.currentTrackId, generation: queued.room.playback.generation });
  const skipped = await host.state((room) => room.currentTrackId === queued.room.queue[1].id);
  assert.equal(skipped.room.skipVote, null);
  assert.equal(skipped.room.playback.playing, true);
  assert.equal(skipped.room.queue.length, 2);
});

test('three-person skip voting counts each identity once and a majority overrides the host', async (t) => {
  const { app, roomId, host, connect } = await fixture(t);
  const queued = await addQueue(host, 3);
  const first = connect({ name: 'First voter' }), second = connect({ name: 'Second voter' });
  await first.join(roomId);
  await second.join(roomId);
  const skip = { type: 'control', action: 'skip', trackId: queued.room.currentTrackId, generation: queued.room.playback.generation };
  first.send(skip);
  const vote = await host.state((room) => room.skipVote?.voterIds.length === 1);
  assert.equal(vote.room.skipVote.required, 2);
  assert.equal(vote.room.skipVote.eligibleCount, 3);
  assert.equal(vote.room.currentTrackId, queued.room.currentTrackId);
  first.send(skip);
  await barrier(first);
  assert.equal(app.rooms.get(roomId).revision, vote.room.revision, 'duplicate yes clicks are idempotent');
  second.send({ ...skip, action: 'vote_skip' });
  const advanced = await host.state((room) => room.currentTrackId === queued.room.queue[1].id);
  assert.equal(advanced.room.playback.playing, true);
  assert.equal(advanced.room.skipVote, null);
  assert.equal(advanced.room.queue.length, 2);
  second.send(skip);
  await barrier(second);
  assert.equal(app.rooms.get(roomId).currentTrackId, advanced.room.currentTrackId, 'old votes cannot skip the new song');
});

test('a four-person lobby needs three votes, and joining or leaving recomputes eligibility', async (t) => {
  const { app, roomId, host, connect } = await fixture(t);
  const queued = await addQueue(host, 3);
  const first = connect(), second = connect(), fourth = connect();
  await first.join(roomId);
  await second.join(roomId);
  await fourth.join(roomId);
  first.send({ type: 'control', action: 'skip', trackId: queued.room.currentTrackId });
  await host.state((room) => room.skipVote?.required === 3);
  second.send({ type: 'control', action: 'vote_skip', trackId: queued.room.currentTrackId });
  const twoVotes = await host.state((room) => room.skipVote?.voterIds.length === 2);
  assert.equal(twoVotes.room.currentTrackId, queued.room.currentTrackId);
  const fifth = connect();
  await fifth.join(roomId);
  assert.equal(app.rooms.get(roomId).skipVote.voterIds.size, 2);
  first.close();
  const voteRemoved = await host.state((room) => room.skipVote?.voterIds.length === 1);
  assert.equal(voteRemoved.room.skipVote.required, 3);
  fifth.close();
  await host.state((room) => room.skipVote?.eligibleCount === 3);
  fourth.close();
  const advanced = await host.state((room) => room.currentTrackId === queued.room.queue[1].id);
  assert.equal(advanced.room.playback.playing, true);
  assert.equal(advanced.room.skipVote, null);
});

test('the host can contribute a vote without forcing an immediate skip', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const queued = await addQueue(host, 3);
  const first = connect(), second = connect(), third = connect();
  await first.join(roomId); await second.join(roomId); await third.join(roomId);
  first.send({ type: 'control', action: 'skip', trackId: queued.room.currentTrackId });
  await host.state((room) => room.skipVote?.voterIds.length === 1);
  host.send({ type: 'control', action: 'vote_skip', trackId: queued.room.currentTrackId });
  const voted = await second.state((room) => room.skipVote?.voterIds.length === 2);
  assert.equal(voted.room.currentTrackId, queued.room.currentTrackId);
  host.send({ type: 'control', action: 'skip', trackId: queued.room.currentTrackId });
  const advanced = await second.state((room) => room.currentTrackId === queued.room.queue[1].id);
  assert.equal(advanced.room.skipVote, null);
});

test('single-track autoplay restarts until another track is added and rejects old-generation finish events', async (t) => {
  const { app, roomId, host } = await fixture(t);
  const queued = await addQueue(host, 1);
  host.send({ type: 'control', action: 'play' });
  await host.state((room) => room.playback.playing);
  const finish = { type: 'control', action: 'finish', trackId: queued.room.currentTrackId, generation: queued.room.playback.generation };
  host.send(finish);
  const repeated = await host.state((room) => room.playback.generation > finish.generation);
  assert.equal(repeated.room.currentTrackId, finish.trackId);
  assert.equal(repeated.room.queue.length, 1);
  assert.equal(repeated.room.playback.playing, true);
  host.send(finish);
  await barrier(host);
  assert.equal(app.rooms.get(roomId).playback.generation, repeated.room.playback.generation);
  host.send({ type: 'add', url: TRACK_B });
  const withNext = await host.state((room) => room.queue.length === 2);
  host.send({ ...finish, generation: withNext.room.playback.generation });
  const advanced = await host.state((room) => room.currentTrackId === withNext.room.queue[1].id);
  assert.equal(advanced.room.queue.length, 1);
  assert.equal(advanced.room.playback.playing, true);
});

test('host repeat modes loop the track or cycle the queue while explicit skip bypasses track repeat', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const queued = await addQueue(host, 3);
  const guest = connect();
  await guest.join(roomId);
  for (const action of [{ action: 'repeat', mode: 'track' }, { action: 'shuffle' }]) {
    guest.send({ type: 'control', ...action });
    assert.equal((await guest.waitFor((message) => message.type === 'error')).code, 'host_only');
  }
  host.send({ type: 'control', action: 'repeat', mode: 'track' });
  await host.state((room) => room.repeatMode === 'track');
  host.send({ type: 'control', action: 'play' });
  await host.state((room) => room.playback.playing);
  host.send({ type: 'control', action: 'finish', trackId: queued.room.currentTrackId, generation: queued.room.playback.generation });
  const repeated = await host.state((room) => room.playback.generation > queued.room.playback.generation);
  assert.equal(repeated.room.currentTrackId, queued.room.currentTrackId);
  assert.deepEqual(repeated.room.queue.map((track) => track.id), queued.room.queue.map((track) => track.id));
  host.send({ type: 'control', action: 'skip', trackId: repeated.room.currentTrackId, generation: repeated.room.playback.generation });
  const skipped = await host.state((room) => room.currentTrackId === queued.room.queue[1].id);
  host.send({ type: 'control', action: 'repeat', mode: 'queue' });
  await host.state((room) => room.repeatMode === 'queue');
  host.send({ type: 'control', action: 'finish', trackId: skipped.room.currentTrackId, generation: skipped.room.playback.generation });
  const cycled = await host.state((room) => room.currentTrackId === queued.room.queue[2].id);
  assert.deepEqual(cycled.room.queue.map((track) => track.id), [queued.room.queue[2].id, queued.room.queue[1].id]);
  assert.equal(cycled.room.playback.playing, true);
});

test('shuffle changes only upcoming order and queue attribution survives departure or forged metadata', async (t) => {
  const { roomId, host, connect } = await fixture(t, { random: () => 0.99 });
  const queued = await addQueue(host, 4);
  const guest = connect({ name: 'Queued by Alex' });
  await guest.join(roomId);
  guest.send({ type: 'add', url: TRACK_B });
  const added = await host.state((room) => room.queue.length === 5);
  const theirs = added.room.queue[4];
  assert.equal(theirs.addedByName, 'Queued by Alex');
  guest.close();
  await host.state((room) => !room.members.some((member) => member.id === guest.identity.clientId));
  host.send({ type: 'metadata', trackId: theirs.id, title: 'Metadata title', addedByName: 'Forged attribution', addedBy: host.identity.clientId });
  const metadataState = await host.state((room) => room.queue.some((track) => track.title === 'Metadata title'));
  host.send({ type: 'control', action: 'play', positionMs: 12000 });
  const playing = await host.state((room) => room.playback.playing && room.playback.positionMs === 12000);
  host.send({ type: 'control', action: 'shuffle' });
  const shuffled = await host.state((room) => room.revision > playing.room.revision);
  assert.equal(shuffled.room.currentTrackId, queued.room.currentTrackId);
  assert.equal(shuffled.room.queue[0].id, queued.room.currentTrackId);
  assert.notDeepEqual(shuffled.room.queue.map((track) => track.id), metadataState.room.queue.map((track) => track.id));
  assert.deepEqual([...shuffled.room.queue.map((track) => track.id)].sort(), [...playing.room.queue.map((track) => track.id)].sort());
  assert.deepEqual(shuffled.room.playback, playing.room.playback);
  assert.equal(shuffled.room.queue.find((track) => track.id === theirs.id).addedByName, 'Queued by Alex');
});

test('guests get three pause/resume cycles per second and a five-second cooldown survives reconnect', async (t) => {
  let timestamp = 10_000;
  const { roomId, host, connect } = await fixture(t, { now: () => timestamp });
  host.send({ type: 'add', url: TRACK_A });
  await host.state((room) => room.queue.length === 1 && room.playback.playing);
  const guest = connect({ name: 'Guest' });
  await guest.join(roomId);
  timestamp += 2000;
  guest.send({ type: 'control', action: 'pause', positionMs: 90000 });
  const paused = await guest.state((room) => !room.playback.playing);
  assert.equal(paused.room.playback.positionMs, 2000);
  timestamp += 2000;
  guest.send({ type: 'control', action: 'play', positionMs: 90000 });
  const resumed = await guest.state((room) => room.playback.playing && room.revision > paused.room.revision);
  assert.equal(resumed.room.playback.positionMs, 2000, 'a guest resume cannot seek');
  // The earlier pause is outside the one-second window. The resume starts a
  // fresh allowance, and five more toggles must succeed within the same second.
  let latest = resumed;
  for (let index = 0; index < 5; index++) {
    guest.send({ type: 'control', action: index % 2 ? 'play' : 'pause' });
    latest = await guest.state((room) => room.revision > latest.room.revision);
  }
  assert.equal(latest.room.playback.playing, false);
  guest.send({ type: 'control', action: 'pause' });
  const limited = await guest.waitFor((message) => message.type === 'error');
  assert.equal(limited.code, 'pause_rate_limited');
  assert.equal(limited.retryAfterMs, 5000);
  guest.close();
  await host.state((room) => !room.members.some((member) => member.id === guest.identity.clientId));
  const returned = connect(guest.identity);
  await returned.join(roomId);
  returned.send({ type: 'control', action: 'play' });
  assert.equal((await returned.waitFor((message) => message.type === 'error')).code, 'pause_rate_limited');
  timestamp += 4999;
  returned.send({ type: 'control', action: 'play' });
  assert.equal((await returned.waitFor((message) => message.type === 'error')).retryAfterMs, 1, 'rejected requests do not extend the cooldown');
  timestamp += 1;
  const rejoined = await host.state((room) => room.members.some((member) => member.id === guest.identity.clientId) && room.revision > latest.room.revision);
  latest = rejoined;
  for (let index = 0; index < 6; index++) {
    returned.send({ type: 'control', action: index % 2 ? 'pause' : 'play' });
    latest = await returned.state((room) => room.revision > latest.room.revision);
  }
  returned.send({ type: 'control', action: 'play' });
  assert.equal((await returned.waitFor((message) => message.type === 'error')).retryAfterMs, 5000, 'the entire allowance is restored after cooldown');
});

test('guest toggle allowance uses a rolling one-second window', async (t) => {
  let timestamp = 10_000;
  const { roomId, host, connect } = await fixture(t, { now: () => timestamp });
  await addQueue(host, 1);
  const guest = connect();
  let latest = await guest.join(roomId);
  for (let index = 0; index < 6; index++) {
    guest.send({ type: 'control', action: index % 2 ? 'play' : 'pause' });
    latest = await guest.state((room) => room.revision > latest.room.revision);
  }
  timestamp += 1000;
  for (let index = 0; index < 6; index++) {
    guest.send({ type: 'control', action: index % 2 ? 'play' : 'pause' });
    latest = await guest.state((room) => room.revision > latest.room.revision);
  }
  assert.equal(guest.inbox.some((message) => message.type === 'error'), false);
});

test('a limited guest promoted to host can immediately play and pause without a cooldown', async (t) => {
  const { roomId, host, connect } = await fixture(t, { now: () => 10_000 });
  await addQueue(host, 1);
  const guest = connect(), other = connect();
  let latest = await guest.join(roomId);
  await other.join(roomId);
  latest = await guest.state((room) => room.members.length === 3);
  for (let index = 0; index < 6; index++) {
    guest.send({ type: 'control', action: index % 2 ? 'play' : 'pause' });
    latest = await guest.state((room) => room.revision > latest.room.revision);
  }
  guest.send({ type: 'control', action: 'pause' });
  assert.equal((await guest.waitFor((message) => message.type === 'error')).code, 'pause_rate_limited');
  host.close();
  latest = await guest.state((room) => room.hostId === guest.identity.clientId);
  assert.equal(latest.room.members.length, 2, 'the new host is still in a shared room');
  for (let index = 0; index < 12; index++) {
    guest.send({ type: 'control', action: index % 2 ? 'play' : 'pause' });
    latest = await guest.state((room) => room.revision > latest.room.revision);
  }
});

test('adding, selecting, skipping and removing the current song all start playback', async (t) => {
  const { host } = await fixture(t);
  host.send({ type: 'add', url: TRACK_A });
  const first = await host.state((room) => room.queue.length === 1);
  assert.equal(first.room.playback.playing, true, 'first track starts automatically');
  host.send({ type: 'control', action: 'pause', positionMs: 12345 });
  await host.state((room) => !room.playback.playing);
  host.send({ type: 'add', url: TRACK_B });
  const added = await host.state((room) => room.queue.length === 2);
  assert.equal(added.room.playback.playing, true);
  assert.equal(added.room.currentTrackId, first.room.currentTrackId);
  assert.equal(added.room.playback.positionMs, 12345, 'adding resumes the existing paused song without restarting it');
  assert.equal(added.room.playback.generation, first.room.playback.generation);
  host.send({ type: 'control', action: 'pause' });
  await host.state((room) => !room.playback.playing && room.revision > added.room.revision);
  host.send({ type: 'add_many', tracks: [{ url: 'https://soundcloud.com/artist/third' }, { url: 'https://soundcloud.com/artist/fourth' }] });
  const imported = await host.state((room) => room.queue.length === 4);
  assert.equal(imported.room.playback.playing, true);
  host.send({ type: 'control', action: 'pause' });
  await host.state((room) => !room.playback.playing && room.revision > imported.room.revision);
  host.send({ type: 'control', action: 'select', trackId: imported.room.queue[2].id });
  const selected = await host.state((room) => room.currentTrackId === imported.room.queue[2].id);
  assert.equal(selected.room.playback.playing, true);
  host.send({ type: 'control', action: 'pause' });
  await host.state((room) => !room.playback.playing && room.revision > selected.room.revision);
  host.send({ type: 'control', action: 'skip', trackId: selected.room.currentTrackId });
  const skipped = await host.state((room) => room.currentTrackId !== selected.room.currentTrackId);
  assert.equal(skipped.room.playback.playing, true);
  host.send({ type: 'control', action: 'pause' });
  await host.state((room) => !room.playback.playing && room.revision > skipped.room.revision);
  host.send({ type: 'control', action: 'remove', trackId: skipped.room.currentTrackId });
  const removed = await host.state((room) => room.currentTrackId !== skipped.room.currentTrackId);
  assert.equal(removed.room.playback.playing, true);
});

test('disconnect removes listeners immediately and hosting follows current join order', async (t) => {
  const { roomId, host, connect } = await fixture(t);
  const first = connect({ name: 'First' }), second = connect({ name: 'Second' }), third = connect({ name: 'Third' });
  await first.join(roomId); await second.join(roomId); await third.join(roomId);
  host.close();
  const passed = await first.state((room) => room.hostId === first.identity.clientId);
  assert.ok(!passed.room.members.some((member) => member.id === host.identity.clientId));
  assert.ok(passed.room.members.every((member) => member.connected));
  const returned = connect(host.identity);
  const back = await returned.join(roomId);
  assert.equal(back.room.hostId, first.identity.clientId, 'returning host does not reclaim the role');
  assert.equal(back.room.members.at(-1).id, host.identity.clientId, 'returning listener joins the end');
  first.close();
  await second.state((room) => room.hostId === second.identity.clientId);
  second.close();
  await third.state((room) => room.hostId === third.identity.clientId);
  third.close();
  await returned.state((room) => room.hostId === returned.identity.clientId && room.members.length === 1);
});

test('wait messages are gone and room snapshots contain no wait state', async (t) => {
  const { host } = await fixture(t);
  const queued = await addQueue(host, 1);
  assert.ok(!Object.hasOwn(queued.room, 'hold'));
  for (const type of ['hold', 'hold_ready']) {
    host.send({ type });
    assert.equal((await host.waitFor((message) => message.type === 'error')).code, 'unknown_message');
  }
});

test('an empty room closes after thirty minutes even while its listeners ping', async (t) => {
  let timestamp = 10_000;
  const { app, origin, roomId, host, connect } = await fixture(t, { now: () => timestamp });
  timestamp += 29 * 60_000;
  await barrier(host);
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}`)).status, 200);
  timestamp += 60_001;
  const closed = new Promise((resolve) => host.socket.once('close', resolve));
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}`)).status, 404);
  assert.equal((await host.waitFor((message) => message.type === 'room_closed')).reason, 'inactive');
  assert.equal(await closed, 4004);
  assert.equal(app.rooms.has(roomId), false);
  const late = connect();
  await late.opened;
  late.send({ type: 'join', roomId, ...late.identity });
  assert.equal((await late.waitFor((message) => message.type === 'error')).code, 'room_not_found');
});

test('paused queued rooms expire despite metadata and late resume cannot revive them', async (t) => {
  let timestamp = 10_000;
  const { app, roomId, host, connect } = await fixture(t, { now: () => timestamp });
  const queued = await addQueue(host, 2);
  host.send({ type: 'control', action: 'pause' });
  const paused = await host.state((room) => !room.playback.playing);
  timestamp += 29 * 60_000;
  host.send({ type: 'metadata', trackId: queued.room.currentTrackId, title: 'Still paused' });
  await host.state((room) => room.revision > paused.room.revision);
  const guest = connect();
  await guest.join(roomId);
  timestamp += 60_001;
  guest.send({ type: 'control', action: 'play' });
  await guest.waitFor((message) => message.type === 'room_closed');
  assert.equal(app.rooms.has(roomId), false);
});

test('actual advancing listening progress keeps playback alive without broadcasting revisions', async (t) => {
  let timestamp = 10_000;
  const { app, origin, roomId, host } = await fixture(t, { now: () => timestamp });
  const queued = await addQueue(host, 1);
  const originalRevision = queued.room.revision;
  for (let index = 1; index <= 3; index++) {
    timestamp += 29 * 60_000;
    host.send({ type: 'listening', trackId: queued.room.currentTrackId, generation: queued.room.playback.generation, positionMs: index * 1000 });
    await barrier(host);
    assert.equal((await fetch(`${origin}/api/rooms/${roomId}`)).status, 200);
    assert.equal(app.rooms.get(roomId).revision, originalRevision);
  }
  timestamp += 29 * 60_000;
  host.send({ type: 'metadata', trackId: queued.room.currentTrackId, title: 'Metadata cannot replace listening' });
  await host.state((room) => room.revision > originalRevision);
  host.send({ type: 'listening', trackId: queued.room.currentTrackId, generation: queued.room.playback.generation, positionMs: 3000 });
  await barrier(host); // A repeated frozen position is not music activity.
  timestamp += 60_001;
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}`)).status, 404);
});

test('cleanup closes connected rooms whose player never produces audio progress', async (t) => {
  let timestamp = 10_000;
  const { app, roomId, host } = await fixture(t, { now: () => timestamp, cleanupIntervalMs: 10 });
  await addQueue(host, 1);
  timestamp += 30 * 60_000 + 1;
  await host.waitFor((message) => message.type === 'room_closed');
  assert.equal(app.rooms.has(roomId), false);
});

test('a room with no remaining listeners starts its inactivity window at disconnection', async (t) => {
  let timestamp = 10_000;
  const { app, origin, roomId, host } = await fixture(t, { now: () => timestamp });
  await addQueue(host, 1);
  timestamp += 10 * 60_000;
  host.close();
  await delay(10);
  assert.equal(app.rooms.get(roomId).members.size, 0);
  assert.equal(app.rooms.get(roomId).playback.playing, false);
  timestamp += 29 * 60_000;
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}`)).status, 200);
  timestamp += 60_001;
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}`)).status, 404);
});
