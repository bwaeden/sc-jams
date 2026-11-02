import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DURATION = 24 * 60 * 60 * 1000;

export class RoomError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
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

function soundcloudId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return /^(?:soundcloud:tracks:)?([1-9][0-9]{0,19})$/.exec(String(value))?.[1] ?? null;
}

function metadata(value) {
  const result = {};
  const title = text(value.title, 200);
  const artist = text(value.artist, 100);
  if (title) result.title = title;
  if (artist) result.artist = artist;
  const id = soundcloudId(value.soundcloudId);
  if (id) result.soundcloudId = id;
  if (typeof value.permalinkUrl === 'string') {
    try {
      const permalink = normalizeTrackUrl(value.permalinkUrl);
      if (new URL(permalink).hostname === 'soundcloud.com') result.permalinkUrl = permalink;
    } catch { /* Public track links are optional metadata. */ }
  }
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
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const byId = parsed.hostname === 'api.soundcloud.com';
  return { id: randomUUID(), url, title: byId ? `SoundCloud track ${parts[1]}` : parts[1].replace(/-/g, ' '), artist: byId ? 'SoundCloud' : parts[0], artwork: null, duration: 0, addedBy: member.id, addedByName: member.name, ...metadata(value), ...(byId ? { soundcloudId: parts[1] } : {}) };
}

function trackKeys(track) {
  return [`url:${track.url}`, ...(track.permalinkUrl ? [`url:${track.permalinkUrl}`] : []), ...(track.soundcloudId ? [`id:${track.soundcloudId}`] : [])];
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
  // Playlist widgets may expose only an ID for tracks beyond the first five.
  // The official player accepts this exact public track reference directly.
  if (url.hostname === 'api.soundcloud.com') {
    const match = /^\/tracks\/([1-9][0-9]{0,19})$/.exec(url.pathname);
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port && match, 'invalid_url', 'Use a public SoundCloud track address.');
    requireValue(!url.searchParams.has('secret_token'), 'private_track', 'This prototype supports public tracks. Choose a public SoundCloud link.');
    return `https://api.soundcloud.com/tracks/${match[1]}`;
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
  roomIdleMs = 30 * 60 * 1000,
  maxRooms = 1000,
  random = Math.random,
  onChange = () => {},
  onClose = () => {},
} = {}) {
  const rooms = new Map();
  const identityRetentionMs = 2 * 60 * 60 * 1000;

  function refreshIdle(room) {
    const playing = room.currentTrackId && room.queue.length && room.playback.playing && room.members.size;
    if (playing) room.idleSince = null;
    else if (room.idleSince === null) room.idleSince = now();
  }

  function expire(room) {
    const since = room.idleSince ?? room.lastMusicActivityAt;
    if (now() - since < roomIdleMs) return false;
    if (!rooms.has(room.id)) return true;
    onClose(room);
    rooms.delete(room.id);
    room.members.clear();
    room.identities.clear();
    return true;
  }

  function pruneIdentities(room) {
    for (const [id, identity] of room.identities) {
      if (!identity.connected && now() - identity.lastSeen > identityRetentionMs) room.identities.delete(id);
    }
    // Reconnect credentials are private and bounded even in long-lived rooms.
    if (room.identities.size >= 1000) {
      for (const [id, identity] of room.identities) {
        if (!identity.connected) room.identities.delete(id);
        if (room.identities.size < 1000) break;
      }
    }
  }

  function changed(room) {
    refreshIdle(room);
    room.revision += 1;
    onChange(room);
  }

  function elect(room) {
    const next = [...room.members.values()].find((member) => member.connected);
    room.hostId = next?.id ?? null;
  }

  function create() {
    cleanup();
    requireValue(rooms.size < maxRooms, 'server_full', 'This server is full. Please try again later.');
    let id;
    do { id = randomBytes(9).toString('base64url'); } while (rooms.has(id));
    const timestamp = now();
    const room = { id, revision: 0, hostId: null, members: new Map(), identities: new Map(), queue: [], currentTrackId: null,
      playback: { playing: false, positionMs: 0, updatedAt: timestamp, generation: 0 }, repeatMode: 'off', skipVote: null, createdAt: timestamp, idleSince: timestamp, lastMusicActivityAt: timestamp };
    rooms.set(id, room);
    return room;
  }

  function get(id) {
    const room = typeof id === 'string' ? rooms.get(id) : null;
    requireValue(room && !expire(room), 'room_not_found', 'This room has expired. Start a new jam.');
    return room;
  }

  function snapshot(room) {
    return { id: room.id, revision: room.revision, hostId: room.hostId,
      members: [...room.members.values()].map(({ id, name, connected }) => ({ id, name, connected })),
      queue: room.queue.map((track) => ({ ...track })), currentTrackId: room.currentTrackId,
      playback: { ...room.playback }, repeatMode: room.repeatMode,
      skipVote: room.skipVote ? { trackId: room.skipVote.trackId, generation: room.skipVote.generation, voterIds: [...room.skipVote.voterIds], required: Math.floor(connectedMembers(room).length / 2) + 1, eligibleCount: connectedMembers(room).length } : null };
  }

  function join(roomId, { clientId, token, name }, socket) {
    const room = get(roomId);
    requireValue(UUID.test(clientId ?? '') && UUID.test(token ?? ''), 'invalid_identity', 'Your browser could not create a session. Refresh and try again.');
    const nickname = text(name, 24) || 'User';
    pruneIdentities(room);
    let member = room.identities.get(clientId);
    if (member) {
      const known = Buffer.from(member.token);
      const presented = Buffer.from(token);
      requireValue(known.length === presented.length && timingSafeEqual(known, presented), 'invalid_session', 'This session belongs to another listener. Refresh to create a new session.');
      const oldSocket = member.socket;
      if (!member.connected) {
        requireValue(room.members.size < 20, 'room_full', 'This room is full (20 listeners).');
        member.joinedAt = now();
        room.members.set(clientId, member);
      }
      member.connected = true;
      member.socket = socket;
      member.name = nickname;
      member.lastSeen = now();
      if (oldSocket && oldSocket !== socket) oldSocket.close(4001, 'Session opened in another tab');
    } else {
      requireValue(room.members.size < 20, 'room_full', 'This room is full (20 listeners).');
      member = { id: clientId, token, name: nickname, connected: true, socket, joinedAt: now(), lastSeen: now() };
      room.members.set(clientId, member);
      room.identities.set(clientId, member);
    }
    if (!room.hostId) room.hostId = clientId;
    reconcileVote(room);
    changed(room);
    return { room, member };
  }

  function leave(room, member, socket) {
    if (!rooms.has(room.id) || member.socket !== socket) return;
    member.socket = null;
    member.connected = false;
    member.lastSeen = now();
    room.members.delete(member.id);
    if (room.hostId === member.id) elect(room);
    reconcileVote(room);
    if (!room.members.size) {
      room.playback.positionMs = getPosition(room, now());
      room.playback.playing = false;
      room.playback.updatedAt = now();
    }
    changed(room);
  }

  function requireHost(room, member) {
    requireValue(room.hostId === member.id, 'host_only', 'The host controls playback. You can add a track to the queue.');
  }

  function select(room, trackId, playing = true) {
    room.currentTrackId = trackId;
    room.playback = { playing: Boolean(trackId && playing), positionMs: 0, updatedAt: now(), generation: room.playback.generation + 1 };
    if (trackId && playing) room.lastMusicActivityAt = now();
    room.skipVote = null;
  }

  function resume(room) {
    const at = now();
    room.playback = { ...room.playback, positionMs: getPosition(room, at), playing: true, updatedAt: at };
    room.lastMusicActivityAt = at;
  }

  function advance(room, { natural = false, forcePlaying = false } = {}) {
    const playing = true;
    const index = room.queue.findIndex((track) => track.id === room.currentTrackId);
    if (index < 0) return;
    if (room.queue.length === 1 || (natural && room.repeatMode === 'track')) {
      select(room, room.currentTrackId, playing);
      return;
    }
    const [previous] = room.queue.splice(index, 1);
    if (room.repeatMode === 'queue') room.queue.push(previous);
    select(room, room.queue[0]?.id ?? null, playing);
  }

  function connectedMembers(room) {
    return [...room.members.values()].filter((member) => member.connected);
  }

  function reconcileVote(room) {
    const vote = room.skipVote;
    if (!vote) return;
    if (vote.trackId !== room.currentTrackId || vote.generation !== room.playback.generation) { room.skipVote = null; return; }
    const members = connectedMembers(room);
    const eligible = new Set(members.map((member) => member.id));
    vote.voterIds = new Set([...vote.voterIds].filter((id) => eligible.has(id)));
    if (!vote.voterIds.size) { room.skipVote = null; return; }
    if (members.length <= 2 || vote.voterIds.size >= Math.floor(members.length / 2) + 1) advance(room, { forcePlaying: true });
  }

  function requestSkip(room, member, { voteOnly = false } = {}) {
    const members = connectedMembers(room);
    if (!voteOnly && (room.hostId === member.id || members.length <= 2)) {
      advance(room, { forcePlaying: true });
      return true;
    }
    room.skipVote ??= { trackId: room.currentTrackId, generation: room.playback.generation, voterIds: new Set() };
    if (room.skipVote.voterIds.has(member.id)) return false;
    room.skipVote.voterIds.add(member.id);
    reconcileVote(room);
    return true;
  }

  function limitPlayback(room, member) {
    if (room.hostId === member.id) {
      member.pauseAttempts = [];
      member.pauseBlockedUntil = 0;
      return;
    }
    const timestamp = now();
    if (member.pauseBlockedUntil > timestamp) {
      throw new RoomError('pause_rate_limited', 'Play/pause is on cooldown. Please give the room a moment.', { retryAfterMs: member.pauseBlockedUntil - timestamp });
    }
    if (member.pauseBlockedUntil) {
      member.pauseAttempts = [];
      member.pauseBlockedUntil = 0;
    }
    member.pauseAttempts = (member.pauseAttempts || []).filter((at) => timestamp - at < 1000);
    // Allow three complete pause/resume cycles before blocking the next request.
    if (member.pauseAttempts.length >= 6) {
      member.pauseBlockedUntil = timestamp + 5000;
      throw new RoomError('pause_rate_limited', 'Play/pause is on cooldown. Please give the room a moment.', { retryAfterMs: 5000 });
    }
    member.pauseAttempts.push(timestamp);
  }

  function apply(room, member, message) {
    get(room.id);
    requireValue(room.members.get(member.id) === member && member.connected, 'not_joined', 'Join the room before sending controls.');
    requireValue(message && typeof message === 'object' && !Array.isArray(message), 'invalid_message', 'Send a valid room message.');
    if (message.type === 'add') {
      requireValue(room.queue.length < 100, 'queue_full', 'The queue is full (100 tracks).');
      const track = newTrack({ url: message.url }, member);
      const keys = new Set(trackKeys(track));
      requireValue(!room.queue.some((item) => trackKeys(item).some((key) => keys.has(key))), 'duplicate_track', 'That track is already in the queue.');
      room.queue.push(track);
      if (!room.currentTrackId) select(room, track.id);
      else resume(room);
    } else if (message.type === 'add_many') {
      requireValue(Array.isArray(message.tracks) && message.tracks.length > 0 && message.tracks.length <= 100, 'invalid_batch', 'Import between 1 and 100 tracks at a time.');
      // Validate every item before changing the queue, including duplicated items.
      const prepared = message.tracks.map((item) => newTrack(item, member));
      const seen = new Set(room.queue.flatMap(trackKeys));
      const additions = prepared.filter((track) => {
        const keys = trackKeys(track);
        if (keys.some((key) => seen.has(key))) return false;
        for (const key of keys) seen.add(key);
        return true;
      });
      requireValue(additions.length > 0, 'duplicate_track', 'These tracks are already in the queue.');
      requireValue(room.queue.length + additions.length <= 100, 'queue_full', 'The queue holds 100 tracks. Remove some tracks before importing this playlist.');
      room.queue.push(...additions);
      if (!room.currentTrackId) select(room, additions[0].id);
      else resume(room);
    } else if (message.type === 'listening') {
      requireValue(message.trackId === room.currentTrackId && message.generation === room.playback.generation, 'stale_track', 'Report progress for the current track.');
      const next = position(message.positionMs);
      if (!room.playback.playing) return;
      const prior = member.listening;
      const advanced = next > 0 && (!prior || prior.trackId !== message.trackId || prior.generation !== message.generation || next > prior.positionMs);
      member.listening = { trackId: message.trackId, generation: message.generation, positionMs: next };
      if (advanced) room.lastMusicActivityAt = now();
      return;
    } else if (message.type === 'metadata') {
      requireHost(room, member);
      const track = room.queue.find((item) => item.id === message.trackId);
      requireValue(track, 'track_not_found', 'This track is no longer in the queue.');
      const details = metadata(message);
      if (new URL(track.url).hostname === 'api.soundcloud.com') details.soundcloudId = new URL(track.url).pathname.split('/').at(-1);
      Object.assign(track, details);
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
      room.playback = { ...room.playback, playing: room.playback.playing, positionMs: Math.min(next, track.duration || MAX_DURATION), updatedAt: now() };
    } else if (message.type === 'control') {
      requireValue(typeof message.action === 'string', 'invalid_action', 'Choose a valid playback action.');
      if (!['play', 'pause', 'skip', 'vote_skip'].includes(message.action)) requireHost(room, member);
      const currentIndex = room.queue.findIndex((track) => track.id === room.currentTrackId);
      if (message.action === 'pause' || message.action === 'play') {
        requireValue(currentIndex >= 0, 'empty_queue', 'Add a track to start listening.');
        limitPlayback(room, member);
        const at = now();
        // Any listener can toggle playback, but guests cannot seek the timeline.
        const next = room.hostId === member.id && message.positionMs !== undefined ? position(message.positionMs) : getPosition(room, at);
        const duration = room.queue[currentIndex].duration || MAX_DURATION;
        room.playback = { ...room.playback, playing: message.action === 'play', positionMs: Math.min(next, duration), updatedAt: at };
        if (message.action === 'play') room.lastMusicActivityAt = at;
      } else if (message.action === 'repeat') {
        requireValue(['off', 'track', 'queue'].includes(message.mode), 'invalid_repeat', 'Choose off, track, or queue repeat.');
        if (room.repeatMode === message.mode) return;
        room.repeatMode = message.mode;
      } else if (message.action === 'shuffle') {
        const start = room.currentTrackId ? 1 : 0;
        if (room.queue.length - start < 2) return;
        const currentOrder = room.queue.map((track) => track.id);
        for (let index = room.queue.length - 1; index > start; index--) {
          const target = start + Math.min(index - start, Math.max(0, Math.floor(random() * (index - start + 1))));
          [room.queue[index], room.queue[target]] = [room.queue[target], room.queue[index]];
        }
        // Make a shuffle click observable even if Fisher-Yates picked identity.
        if (room.queue.every((track, index) => track.id === currentOrder[index])) [room.queue[start], room.queue[start + 1]] = [room.queue[start + 1], room.queue[start]];
      } else if (message.action === 'select') {
        requireValue(room.queue.some((track) => track.id === message.trackId), 'track_not_found', 'This track is no longer in the queue.');
        if (message.trackId !== room.currentTrackId) {
          // Queue repeat retains the old current track at the back; other modes
          // consume it when the host jumps to another track.
          if (currentIndex >= 0) {
            const [previous] = room.queue.splice(currentIndex, 1);
            if (room.repeatMode === 'queue') room.queue.push(previous);
          }
          const index = room.queue.findIndex((track) => track.id === message.trackId);
          const [selected] = room.queue.splice(index, 1);
          room.queue.unshift(selected);
        }
        select(room, message.trackId);
      } else if (message.action === 'reorder') {
        const ids = message.trackIds;
        const expected = new Set(room.queue.map((track) => track.id));
        requireValue(Array.isArray(ids) && ids.length === room.queue.length && new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && expected.has(id)), 'invalid_order', 'Reorder the current queue without adding or removing tracks.');
        requireValue(!room.currentTrackId || ids[0] === room.currentTrackId, 'current_track_locked', 'The playing track stays first. Reorder the upcoming tracks.');
        if (ids.every((id, index) => room.queue[index].id === id)) return;
        const tracks = new Map(room.queue.map((track) => [track.id, track]));
        room.queue = ids.map((id) => tracks.get(id));
      } else if (message.action === 'remove') {
        const index = room.queue.findIndex((track) => track.id === message.trackId);
        requireValue(index >= 0, 'track_not_found', 'This track is no longer in the queue.');
        const removingCurrent = message.trackId === room.currentTrackId;
        room.queue.splice(index, 1);
        if (removingCurrent) select(room, room.queue[0]?.id ?? null);
      } else if (message.action === 'skip' || message.action === 'vote_skip' || message.action === 'finish') {
        // Iframe callbacks can arrive twice or after a track switch. Never let
        // an old completion consume the new current track.
        if (message.action === 'finish' && (message.trackId !== room.currentTrackId || !room.playback.playing)) return;
        if (message.action !== 'finish' && message.trackId !== undefined && message.trackId !== room.currentTrackId) return;
        if (message.generation !== undefined && message.generation !== room.playback.generation) return;
        requireValue(currentIndex >= 0, 'empty_queue', 'Add a track to start listening.');
        if (message.action === 'finish') advance(room, { natural: true });
        else if (!requestSkip(room, member, { voteOnly: message.action === 'vote_skip' })) return;
      } else {
        requireValue(currentIndex >= 0, 'empty_queue', 'Add a track to start listening.');
        const current = room.queue[currentIndex];
        const nextPosition = message.positionMs === undefined ? getPosition(room, now()) : position(message.positionMs);
        requireValue(message.action === 'seek', 'invalid_action', 'Choose a valid playback action.');
        room.playback = { ...room.playback, playing: room.playback.playing,
          positionMs: Math.min(nextPosition, current.duration || MAX_DURATION), updatedAt: now() };
      }
    } else throw new RoomError('unknown_message', 'This room message is not supported.');
    changed(room);
  }

  function cleanup() {
    for (const room of rooms.values()) if (!expire(room)) pruneIdentities(room);
  }

  function close() {
    rooms.clear();
  }

  return { rooms, create, get, snapshot, join, leave, apply, cleanup, close };
}
