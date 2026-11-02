import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DURATION = 24 * 60 * 60 * 1000;

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireValue(condition, code, message) {
  if (!condition) throw new RoomError(code, message);
}

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
}

function position(value) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION, 'invalid_position', 'Choose a valid playback position.');
  return Math.round(value);
}

function metadata(value) {
  const result = {};
  const title = text(value.title, 200);
  const artist = text(value.artist, 100);
  if (title) result.title = title;
  if (artist) result.artist = artist;
  if (value.duration !== undefined) result.duration = position(value.duration);
  if (typeof value.artwork === 'string' && value.artwork.length < 2048) {
    try {
      const artwork = new URL(value.artwork);
      if (artwork.protocol === 'https:' && !artwork.username && !artwork.password && !artwork.port && (artwork.hostname === 'sndcdn.com' || artwork.hostname.endsWith('.sndcdn.com'))) result.artwork = artwork.href;
    } catch { /* Artwork is optional; ignore invalid values. */ }
  }
  return result;
}

function newTrack(value, member) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid_track', 'Each playlist item must be a SoundCloud track.');
  const url = normalizeTrackUrl(value.url);
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return { id: randomUUID(), url, title: parts[1].replace(/-/g, ' '), artist: parts[0], artwork: null, duration: 0, addedBy: member.id, ...metadata(value) };
}

export function getPosition(room, at = Date.now()) {
  const elapsed = room.playback.playing ? Math.max(0, at - room.playback.updatedAt) : 0;
  const duration = room.queue.find((track) => track.id === room.currentTrackId)?.duration;
  return Math.min(room.playback.positionMs + elapsed, duration > 0 ? duration : MAX_DURATION);
}

export function normalizeTrackUrl(value) {
  requireValue(typeof value === 'string' && value.length < 2048, 'invalid_url', 'Paste a full SoundCloud track link.');
  let url;
  try { url = new URL(value); } catch { throw new RoomError('invalid_url', 'Paste a full SoundCloud track link.'); }
  if (url.hostname === 'on.soundcloud.com' || url.hostname === 'snd.sc') {
    throw new RoomError('short_link', 'Open this link in SoundCloud, then copy the full track address from your browser.');
  }
  requireValue(url.protocol === 'https:' && ['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) && !url.username && !url.password && !url.port, 'invalid_url', 'Use an https://soundcloud.com/artist/track link.');
  const segments = url.pathname.split('/').filter(Boolean);
  const forbidden = new Set(['sets', 'likes', 'reposts', 'albums', 'tracks', 'popular-tracks', 'followers', 'following']);
  requireValue(segments.length === 2 && !forbidden.has(segments[1]) && !['discover', 'search', 'stream', 'you', 'stations'].includes(segments[0]), 'invalid_url', 'Add an individual track, rather than a profile or playlist.');
  requireValue(segments.every((part) => /^[a-zA-Z0-9_-]+$/.test(part)), 'invalid_url', 'Paste a public SoundCloud track address.');
  requireValue(!url.searchParams.has('secret_token'), 'private_track', 'This prototype supports public tracks. Choose a public SoundCloud link.');
  return `https://soundcloud.com/${segments.join('/')}`;
}

export function createRoomStore({
  now = Date.now,
  hostGraceMs = 15_000,
  roomIdleMs = 2 * 60 * 60 * 1000,
  memberGraceMs = 120_000,
  maxRooms = 1000,
  onChange = () => {},
} = {}) {
  const rooms = new Map();
  const timers = new Set();

  function later(callback, delay) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timer.unref?.();
    timers.add(timer);
    return timer;
  }

  function cancel(timer) {
    if (timer) { clearTimeout(timer); timers.delete(timer); }
  }

  function changed(room) {
    room.lastActive = now();
    room.revision += 1;
    onChange(room);
  }

  function elect(room) {
    const next = [...room.members.values()].find((member) => member.connected);
    room.hostId = next?.id ?? null;
  }

  function create() {
    requireValue(rooms.size < maxRooms, 'server_full', 'This server is full. Please try again later.');
    let id;
    do { id = randomBytes(9).toString('base64url'); } while (rooms.has(id));
    const timestamp = now();
    const room = { id, revision: 0, hostId: null, members: new Map(), queue: [], currentTrackId: null,
      playback: { playing: false, positionMs: 0, updatedAt: timestamp }, hold: null, createdAt: timestamp, lastActive: timestamp };
    rooms.set(id, room);
    return room;
  }

  function get(id) {
    const room = typeof id === 'string' ? rooms.get(id) : null;
    requireValue(room, 'room_not_found', 'This room has expired. Start a new jam.');
    return room;
  }

  function snapshot(room) {
    return { id: room.id, revision: room.revision, hostId: room.hostId,
      members: [...room.members.values()].map(({ id, name, connected }) => ({ id, name, connected })),
      queue: room.queue.map((track) => ({ ...track })), currentTrackId: room.currentTrackId,
      playback: { ...room.playback }, hold: room.hold ? { ...room.hold, waiters: room.hold.waiters.map((waiter) => ({ ...waiter })) } : null };
  }

  function join(roomId, { clientId, token, name }, socket) {
    const room = get(roomId);
    requireValue(UUID.test(clientId ?? '') && UUID.test(token ?? ''), 'invalid_identity', 'Your browser could not create a session. Refresh and try again.');
    const nickname = text(name, 24);
    requireValue(nickname.length > 0, 'invalid_name', 'Enter a nickname to join.');
    let member = room.members.get(clientId);
    if (member) {
      const known = Buffer.from(member.token);
      const presented = Buffer.from(token);
      requireValue(known.length === presented.length && timingSafeEqual(known, presented), 'invalid_session', 'This session belongs to another listener. Refresh to create a new session.');
      const oldSocket = member.socket;
      cancel(member.hostTimer);
      cancel(member.removeTimer);
      member.hostTimer = null;
      member.removeTimer = null;
      member.connected = true;
      member.socket = socket;
      member.name = nickname;
      if (oldSocket && oldSocket !== socket) oldSocket.close(4001, 'Session opened in another tab');
    } else {
      requireValue(room.members.size < 20, 'room_full', 'This room is full (20 listeners).');
      member = { id: clientId, token, name: nickname, connected: true, socket, joinedAt: now(), hostTimer: null, removeTimer: null };
      room.members.set(clientId, member);
    }
    if (!room.hostId) room.hostId = clientId;
    changed(room);
    return { room, member };
  }

  function leave(room, member, socket) {
    if (!rooms.has(room.id) || member.socket !== socket) return;
    member.socket = null;
    member.connected = false;
    if (room.hostId === member.id) {
      member.hostTimer = later(() => {
        if (member.connected || !rooms.has(room.id) || room.hostId !== member.id) return;
        elect(room);
        // Freeze the shared timeline while there is nobody to lead playback.
        if (!room.hostId) {
          room.playback.positionMs = getPosition(room, now());
          room.playback.playing = false;
          room.playback.updatedAt = now();
        }
        changed(room);
      }, hostGraceMs);
    }
    member.removeTimer = later(() => {
      if (member.connected || !rooms.has(room.id)) return;
      room.members.delete(member.id);
      if (room.hostId === member.id) elect(room);
      changed(room);
    }, Math.max(memberGraceMs, hostGraceMs + 1));
    changed(room);
  }

  function requireHost(room, member) {
    requireValue(room.hostId === member.id, 'host_only', 'The host controls playback. You can add a track to the queue.');
  }

  function select(room, trackId, playing = room.playback.playing) {
    room.currentTrackId = trackId;
    room.playback = { playing: Boolean(trackId && playing), positionMs: 0, updatedAt: now() };
  }

  function apply(room, member, message) {
    requireValue(message && typeof message === 'object' && !Array.isArray(message), 'invalid_message', 'Send a valid room message.');
    if (message.type === 'add') {
      requireValue(room.queue.length < 100, 'queue_full', 'The queue is full (100 tracks).');
      const track = newTrack({ url: message.url }, member);
      requireValue(!room.queue.some((item) => item.url === track.url), 'duplicate_track', 'That track is already in the queue.');
      room.queue.push(track);
      if (!room.currentTrackId) select(room, track.id, false);
    } else if (message.type === 'add_many') {
      requireValue(Array.isArray(message.tracks) && message.tracks.length > 0 && message.tracks.length <= 100, 'invalid_batch', 'Import between 1 and 100 tracks at a time.');
      // Validate every item before changing the queue, including duplicated items.
      const prepared = message.tracks.map((item) => newTrack(item, member));
      const seen = new Set(room.queue.map((track) => track.url));
      const additions = prepared.filter((track) => {
        if (seen.has(track.url)) return false;
        seen.add(track.url);
        return true;
      });
      requireValue(additions.length > 0, 'duplicate_track', 'These tracks are already in the queue.');
      requireValue(room.queue.length + additions.length <= 100, 'queue_full', 'The queue holds 100 tracks. Remove some tracks before importing this playlist.');
      room.queue.push(...additions);
      if (!room.currentTrackId) select(room, additions[0].id, false);
    } else if (message.type === 'hold') {
      requireValue(room.currentTrackId, 'empty_queue', 'Add a track before asking the room to wait.');
      const at = now();
      room.playback = { playing: false, positionMs: getPosition(room, at), updatedAt: at };
      room.hold ??= { memberId: member.id, name: member.name, reason: 'manual', at, waiters: [] };
      const waiter = room.hold.waiters.find((item) => item.memberId === member.id);
      if (waiter) { waiter.name = member.name; waiter.ready = false; }
      else room.hold.waiters.push({ memberId: member.id, name: member.name, ready: false });
    } else if (message.type === 'hold_ready') {
      const waiter = room.hold?.waiters.find((item) => item.memberId === member.id);
      requireValue(waiter, 'not_waiting', 'You have not asked this room to wait.');
      if (waiter.ready) return;
      // Readiness is personal; it never resumes the room or changes another listener.
      waiter.ready = true;
    } else if (message.type === 'metadata') {
      requireHost(room, member);
      const track = room.queue.find((item) => item.id === message.trackId);
      requireValue(track, 'track_not_found', 'This track is no longer in the queue.');
      Object.assign(track, metadata(message));
    } else if (message.type === 'position') {
      requireHost(room, member);
      requireValue(room.currentTrackId && message.trackId === room.currentTrackId, 'stale_track', 'Playback changed. Sync to the current track.');
      if (message.baseRevision !== undefined) {
        requireValue(Number.isSafeInteger(message.baseRevision) && message.baseRevision >= 0, 'invalid_message', 'Use a valid room revision.');
        // Async widget getters may finish after a seek or another room update.
        // Silently discard these ordinary stale samples; the next one will catch up.
        if (message.baseRevision !== room.revision) return;
      }
      requireValue(typeof message.playing === 'boolean', 'invalid_message', 'Playback state must be true or false.');
      // Position reports cannot undo a more recent play/pause command.
      requireValue(message.playing === room.playback.playing, 'stale_playback', 'Playback changed. Sync to the current room state.');
      const next = position(message.positionMs);
      const track = room.queue.find((item) => item.id === room.currentTrackId);
      room.playback = { playing: room.playback.playing, positionMs: Math.min(next, track.duration || MAX_DURATION), updatedAt: now() };
    } else if (message.type === 'control') {
      requireHost(room, member);
      const currentIndex = room.queue.findIndex((track) => track.id === room.currentTrackId);
      if (message.action === 'select') {
        requireValue(room.queue.some((track) => track.id === message.trackId), 'track_not_found', 'This track is no longer in the queue.');
        select(room, message.trackId);
      } else if (message.action === 'remove') {
        const index = room.queue.findIndex((track) => track.id === message.trackId);
        requireValue(index >= 0, 'track_not_found', 'This track is no longer in the queue.');
        const removingCurrent = message.trackId === room.currentTrackId;
        room.queue.splice(index, 1);
        if (removingCurrent) select(room, room.queue[index]?.id ?? room.queue[0]?.id ?? null);
      } else if (message.action === 'skip') {
        requireValue(currentIndex >= 0, 'empty_queue', 'Add a track to start listening.');
        // End the queue instead of unexpectedly repeating earlier tracks.
        const next = room.queue[currentIndex + 1];
        if (next) select(room, next.id);
        else {
          room.playback = { playing: false, positionMs: 0, updatedAt: now() };
        }
      } else {
        requireValue(currentIndex >= 0, 'empty_queue', 'Add a track to start listening.');
        const current = room.queue[currentIndex];
        const nextPosition = message.positionMs === undefined ? getPosition(room, now()) : position(message.positionMs);
        requireValue(['play', 'pause', 'seek'].includes(message.action), 'invalid_action', 'Choose a valid playback action.');
        room.playback = { playing: message.action === 'play' ? true : message.action === 'pause' ? false : room.playback.playing,
          positionMs: Math.min(nextPosition, current.duration || MAX_DURATION), updatedAt: now() };
        if (message.action === 'play') room.hold = null;
      }
    } else throw new RoomError('unknown_message', 'This room message is not supported.');
    changed(room);
  }

  function cleanup() {
    for (const [id, room] of rooms) {
      if ([...room.members.values()].some((member) => member.connected)) continue;
      if (now() - room.lastActive > roomIdleMs) {
        for (const member of room.members.values()) { cancel(member.hostTimer); cancel(member.removeTimer); }
        rooms.delete(id);
      }
    }
  }

  function close() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    rooms.clear();
  }

  return { rooms, create, get, snapshot, join, leave, apply, cleanup, close };
}
