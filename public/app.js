const $ = (id) => document.getElementById(id);
const storage = {
  get(key) { try { return localStorage.getItem(`sc-jams:${key}`) ?? localStorage.getItem(`sidecar:${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`sc-jams:${key}`, value); } catch {} },
};
// Session identity keeps separate tabs independent while allowing a refresh to reconnect.
function sessionValue(key) {
  try {
    let value = sessionStorage.getItem(`sc-jams:${key}`);
    if (!value) sessionStorage.setItem(`sc-jams:${key}`, value = crypto.randomUUID());
    return value;
  } catch { return crypto.randomUUID(); }
}
const clientId = sessionValue('id');
const token = sessionValue('token');
const rememberedName = storage.get('name') || '';
const initialName = /^Listener [0-9a-f]{4}$/i.test(rememberedName) ? '' : rememberedName;
$('create-name').value = initialName;
$('join-name').value = initialName;
let socket, room, roomId, displayName, reconnectTimer, pingTimer, heartbeatTimer;
let reconnectDelay = 600, stopped = false, connected = false;
let clockOffset = 0, clockSamples = [], lastRevision = -1, joinedOnce = false;
let widget, loadedTrackId, playerReady = false, loadGeneration = 0;
let audioEnabled = false, syncing = false, lastCorrection = 0;
let pendingForce = false, syncAttempt = 0;
let pendingIntent = null, intentSerial = 0, widgetEchoes = [];
let nativeCheck = null;
let lastPosition = 0, lastPositionAt = 0, knownDuration = 0, lastWidgetPlaying = false;
let lastHostReport = 0, playerUnavailable = false;
let toastTimer, firstTrack;
let volume = Number(storage.get('volume') ?? 70);
if (!Number.isFinite(volume)) volume = 70;
volume = Math.max(0, Math.min(100, volume));
let unmutedVolume = volume || 70;
let playlistWidget, playlistGeneration = 0, playlistTracks = [], playlistTimer;
let waitingLocally = false;
let localAdPlaying = false, pendingHold = null, finishingTrackId = null, endPauseTimer;
const isHost = () => room?.hostId === clientId;
const serverNow = () => Date.now() + clockOffset;
const currentTrack = () => room?.queue.find((track) => track.id === room.currentTrackId);
const playbackState = () => pendingHold && pendingHold.trackId === room?.currentTrackId ? pendingHold : pendingIntent?.trackId === room?.currentTrackId ? pendingIntent : room?.playback;
const isHeld = () => Boolean(pendingHold || room?.hold) && !pendingIntent?.playing;
const unreadyWaiters = () => room?.hold?.waiters?.filter((member) => !member.ready) || [];
const targetPosition = () => {
  if (!room) return 0;
  const state = playbackState();
  let position = state.positionMs + (state.playing ? Math.max(0, serverNow() - state.updatedAt) : 0);
  const duration = currentTrack()?.duration || knownDuration;
  return Math.max(0, duration ? Math.min(position, duration) : position);
};
function icon(name) {
  if (window.SCJamsIcons?.svg) return window.SCJamsIcons.svg(name);
  const paths = { play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>', pause: '<path d="M8 5v14M16 5v14"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>', moon: '<path d="M20 13a8 8 0 0 1-9-9 8 8 0 1 0 9 9Z"/>', 'volume-2': '<path d="m11 5-6 4H2v6h3l6 4Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>', 'volume-x': '<path d="m11 5-6 4H2v6h3l6 4Zm5 4 5 6m0-6-5 6"/>', 'audio-lines': '<path d="M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4"/>', x: '<path d="m6 6 12 12M6 18 18 6"/>' };
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}
function invalidateReconcile() {
  syncing = false;
  pendingForce = false;
  syncAttempt++;
}
function clearIntent() { pendingIntent = null; intentSerial++; invalidateReconcile(); }
function expectWidgetEvent(type, positionMs) {
  widgetEchoes = widgetEchoes.filter((entry) => entry.until > performance.now());
  widgetEchoes.push({ type, positionMs, until: performance.now() + 4000 });
}
function consumeWidgetEvent(type, positionMs) {
  widgetEchoes = widgetEchoes.filter((entry) => entry.until > performance.now());
  const index = widgetEchoes.findIndex((entry) => entry.type === type && (type !== 'SEEK' || Math.abs(entry.positionMs - positionMs) < 300));
  if (index < 0) return false;
  widgetEchoes.splice(index, 1);
  return true;
}
function handleNativePlayback(playing, event = {}) {
  const position = Number.isFinite(event.currentPosition) ? event.currentPosition : lastPosition;
  const echoed = consumeWidgetEvent(playing ? 'PLAY' : 'PAUSE');
  if (finishingTrackId === room?.currentTrackId) return;
  if (isHeld()) {
    lastWidgetPlaying = playing;
    if (playing && !localAdPlaying) commandPlayback(false);
    return;
  }
  // A player may emit PAUSE just before FINISH. Give FINISH a brief chance to
  // consume the track instead of broadcasting a pause that stops the next one.
  if (!playing && !echoed && isHost() && playbackState()?.playing && knownDuration > 0 && position >= knownDuration - 350) {
    clearTimeout(endPauseTimer);
    invalidateReconcile();
    nativeCheck = null;
    const trackId = loadedTrackId;
    endPauseTimer = setTimeout(() => {
      endPauseTimer = null;
      if (room?.currentTrackId === trackId && !finishingTrackId && !isHeld()) hostIntent('pause', position, false);
    }, 180);
    return;
  }
  const commit = (actualPlaying) => {
    lastWidgetPlaying = actualPlaying;
    if (actualPlaying) { audioEnabled = true; $('enable-audio').hidden = true; }
    if (eventsAllowed() && playbackState().playing !== actualPlaying) hostIntent(actualPlaying ? 'play' : 'pause', position, false);
    else if (!isHost() && room?.playback.playing !== actualPlaying) setTimeout(() => reconcile(true), 50);
  };
  if (echoed && playing === playbackState()?.playing) {
    if (!nativeCheck) lastWidgetPlaying = playing;
    return;
  }
  if (!echoed) { nativeCheck = null; commit(playing); return; }
  // An event matching an older command may instead be a fresh native click.
  // Ask for actual play state only in this ambiguous case, while preventing a
  // sync loop from undoing the click. Never guess from a time suppression window.
  invalidateReconcile();
  const check = { instance: widget, generation: loadGeneration };
  nativeCheck = check;
  const valid = () => nativeCheck === check && check.instance === widget && check.generation === loadGeneration && connected;
  widget.isPaused((paused) => {
    if (!valid()) return;
    nativeCheck = null;
    if (!paused === playing) commit(playing);
    else {
      lastWidgetPlaying = !paused;
      if (!paused !== playbackState()?.playing) reconcile(true);
    }
  });
  setTimeout(() => {
    if (!valid()) return;
    nativeCheck = null;
    commit(playing);
  }, 1500);
}
function commandPlayback(playing) {
  if (!widget || !playerReady) return;
  if (lastWidgetPlaying !== playing) expectWidgetEvent(playing ? 'PLAY' : 'PAUSE');
  lastWidgetPlaying = playing;
  if (playing) widget.play(); else widget.pause();
}
function commandSeek(positionMs) {
  if (!widget || !playerReady) return;
  expectWidgetEvent('SEEK', positionMs);
  lastPosition = positionMs;
  lastPositionAt = performance.now();
  widget.seekTo(positionMs);
}
function hostIntent(action, positionMs, commandPlayer = true) {
  if (!isHost() || !connected || !playerReady || !currentTrack() || waitingLocally) return;
  if (action === 'play' && (pendingHold || unreadyWaiters().length)) return;
  const previous = playbackState();
  nativeCheck = null;
  const playing = action === 'play' ? true : action === 'pause' ? false : previous.playing;
  const position = Math.max(0, Math.min(knownDuration || 86400000, Number(positionMs) || 0));
  pendingIntent = { trackId: room.currentTrackId, playing, positionMs: position, updatedAt: serverNow(), baseRevision: room.revision, serial: ++intentSerial };
  const serial = pendingIntent.serial;
  invalidateReconcile();
  if (!send({ type: 'control', action, positionMs: position })) { clearIntent(); return; }
  if (commandPlayer) {
    if (action === 'seek') commandSeek(position);
    else commandPlayback(playing);
  }
  renderControls();
  // A slow or rejected command cannot leave the UI indefinitely optimistic.
  setTimeout(() => {
    if (pendingIntent?.serial !== serial) return;
    clearIntent();
    invalidateReconcile();
    renderControls();
    reconcile(true);
  }, 5000);
}
function finishCurrentTrack() {
  const trackId = room?.currentTrackId;
  if (!trackId || !isHost() || !connected || isHeld() || !playbackState()?.playing || finishingTrackId === trackId) return;
  clearTimeout(endPauseTimer);
  endPauseTimer = null;
  nativeCheck = null;
  clearIntent();
  finishingTrackId = trackId;
  lastWidgetPlaying = false;
  send({ type: 'control', action: 'finish', trackId });
  setSync('Playing the next track');
  setTimeout(() => {
    if (finishingTrackId !== trackId || room?.currentTrackId !== trackId) return;
    finishingTrackId = null;
    reconcile(true);
  }, 5000);
}
function send(message) {
  if (socket?.readyState !== WebSocket.OPEN || !connected) return false;
  socket.send(JSON.stringify(message));
  return true;
}
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, 4200);
}
function errorAt(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}
function connectionLabel(label, online = false) {
  $('connection').classList.toggle('online', online);
  $('connection').replaceChildren(Object.assign(document.createElement('i'), {}), document.createTextNode(label));
}
function setSync(label, warning = false) {
  $('sync-indicator').classList.toggle('warning', warning);
  $('sync-indicator').replaceChildren(document.createElement('i'), document.createTextNode(label));
}
function canonicalTrack(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Paste a full SoundCloud track link.'); }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || !['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password || parts.length !== 2 || ['sets', 'likes', 'tracks', 'reposts', 'albums', 'popular-tracks'].includes(parts[1]) || parts[0] === 'discover') {
    throw new Error('Use a public track link: https://soundcloud.com/artist/track. Open short share links on SoundCloud first.');
  }
  if (url.searchParams.has('secret_token') || !parts.every((part) => /^[a-zA-Z0-9_-]+$/.test(part))) throw new Error('This prototype supports public SoundCloud tracks. Choose a public track link.');
  return `https://soundcloud.com/${parts.join('/')}`;
}
function musicLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Paste a full SoundCloud track or playlist link.'); }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol === 'https:' && ['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) && !url.port && !url.username && !url.password && parts.length === 3 && parts[1] === 'sets' && parts.every((part) => /^[a-zA-Z0-9_-]+$/.test(part)) && !url.searchParams.has('secret_token')) {
    return { playlist: true, url: `https://soundcloud.com/${parts.join('/')}` };
  }
  return { playlist: false, url: canonicalTrack(value) };
}
function applyVolume() {
  $('volume').value = volume;
  $('volume-value').textContent = `${volume}%`;
  $('mute-button').innerHTML = icon(volume === 0 ? 'volume-x' : 'volume-2');
  $('mute-button').setAttribute('aria-label', volume === 0 ? 'Unmute your audio' : 'Mute your audio');
  $('mute-button').setAttribute('aria-pressed', String(volume === 0));
  if (widget && playerReady) widget.setVolume(volume);
  storage.set('volume', String(volume));
}
function applyTheme(theme) {
  document.documentElement?.setAttribute('data-theme', theme);
  $('theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  $('theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
  storage.set('theme', theme);
}
function closePlaylist() {
  playlistGeneration++;
  clearTimeout(playlistTimer);
  playlistWidget?.pause();
  playlistWidget = null;
  playlistTracks = [];
  $('playlist-preview').replaceChildren();
  $('playlist-import').hidden = true;
}
function previewPlaylist(url) {
  closePlaylist();
  const generation = playlistGeneration;
  $('playlist-import').hidden = false;
  $('import-status').textContent = 'Loading playlist…';
  $('import-playlist-button').disabled = true;
  if (!window.SC?.Widget) { errorAt('queue-error', 'SoundCloud is still loading. Try again in a moment.'); return; }
  const iframe = document.createElement('iframe');
  iframe.title = 'SoundCloud playlist import preview';
  iframe.height = '166';
  iframe.scrolling = 'no';
  iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&color=%23f5613c&show_comments=false&visual=false`;
  $('playlist-preview').replaceChildren(iframe);
  const instance = window.SC.Widget(iframe);
  playlistWidget = instance;
  instance.bind(window.SC.Widget.Events.READY, () => {
    if (generation !== playlistGeneration) return;
    instance.setVolume(0);
    instance.getSounds((sounds) => {
      if (generation !== playlistGeneration) return;
      clearTimeout(playlistTimer);
      const seen = new Set(room?.queue.map((track) => track.url) || []);
      const available = Math.max(0, 100 - (room?.queue.length || 0));
      playlistTracks = [];
      for (const sound of Array.isArray(sounds) ? sounds : []) {
        try {
          const trackUrl = canonicalTrack(sound.permalink_url || '');
          if (seen.has(trackUrl) || sound.access === 'blocked') continue;
          seen.add(trackUrl);
          if (playlistTracks.length >= available) break;
          playlistTracks.push({ url: trackUrl, title: String(sound.title || '').slice(0, 200), artist: String(sound.user?.username || '').slice(0, 100), duration: Math.min(86400000, Math.max(0, Number(sound.duration) || 0)) });
        } catch { /* Only public canonical track URLs can enter the shared queue. */ }
      }
      $('import-status').textContent = playlistTracks.length ? `${playlistTracks.length} tracks ready · queue limit 100` : 'No new playable tracks to add, or the queue is full.';
      $('import-playlist-button').textContent = `Add ${playlistTracks.length} tracks`;
      $('import-playlist-button').disabled = !playlistTracks.length || !connected;
    });
  });
  instance.bind(window.SC.Widget.Events.ERROR, () => {
    if (generation !== playlistGeneration) return;
    clearTimeout(playlistTimer);
    $('import-status').textContent = 'This playlist is unavailable. Try a public, embeddable playlist.';
  });
  playlistTimer = setTimeout(() => {
    if (generation === playlistGeneration) $('import-status').textContent = 'SoundCloud did not load this playlist. Check your connection or try another link.';
  }, 18000);
}
function roomCode(value) {
  let input = value.trim();
  try { const url = new URL(input); input = url.pathname.split('/').filter(Boolean).at(-1); } catch {}
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(input)) throw new Error('Paste a room invite link or a valid room code.');
  return input;
}
function showJoin(id) {
  roomId = id;
  history.replaceState(null, '', `/room/${encodeURIComponent(id)}`);
  $('landing').hidden = true;
  $('room-view').hidden = true;
  $('join-overlay').hidden = false;
  $('join-name').focus();
}
function openRoom(id, name) {
  roomId = id;
  displayName = name.trim().slice(0, 24) || 'User';
  storage.set('name', displayName);
  history.replaceState(null, '', `/room/${encodeURIComponent(id)}`);
  $('landing').hidden = true;
  $('join-overlay').hidden = true;
  $('room-view').hidden = false;
  document.title = 'sc jams';
  stopped = false;
  connect();
}
function connect() {
  clearTimeout(reconnectTimer);
  connectionLabel(joinedOnce ? 'Reconnecting' : 'Connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const next = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = next;
  next.addEventListener('open', () => {
    if (socket !== next) return;
    next.send(JSON.stringify({ type: 'join', roomId, clientId, token, name: displayName }));
  });
  next.addEventListener('message', ({ data }) => {
    if (socket !== next) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'pong') {
      const rtt = Date.now() - message.sentAt;
      if (rtt >= 0 && rtt < 5000) {
        clockSamples.push({ offset: message.serverTime - (message.sentAt + rtt / 2), rtt });
        clockSamples = clockSamples.slice(-12);
        clockOffset = [...clockSamples].sort((a, b) => a.rtt - b.rtt)[0].offset;
      }
      return;
    }
    if (message.type === 'error') {
      if (pendingHold) {
        pendingHold = null;
        waitingLocally = false;
        localAdPlaying = false;
        renderControls();
        reconcile(true);
      }
      if (pendingIntent) { clearIntent(); invalidateReconcile(); renderControls(); reconcile(true); }
      errorAt('queue-error', message.message);
      if (!joinedOnce || !connected) toast(message.message);
      // Join failures must not reconnect forever or silently claim to be connected.
      if (!connected) {
        stopped = true;
        connectionLabel('Unable to join');
        $('join-overlay').hidden = false;
        errorAt('join-error', message.message);
      }
      return;
    }
    if (message.type !== 'state' || !message.room) return;
    if (message.room.revision < lastRevision) return;
    const previousTrack = room?.currentTrackId;
    const previousHost = room?.hostId;
    const previousPlaying = room?.playback.playing;
    const timelineChanged = room?.playback.updatedAt !== message.room.playback.updatedAt || room?.playback.positionMs !== message.room.playback.positionMs;
    const firstState = !connected;
    if (message.room.hold || (pendingHold && message.room.currentTrackId !== pendingHold.trackId)) pendingHold = null;
    if (message.room.hold) { nativeCheck = null; clearIntent(); }
    if (pendingIntent) {
      const state = message.room;
      const expected = pendingIntent.positionMs + (pendingIntent.playing ? state.playback.updatedAt - pendingIntent.updatedAt : 0);
      const acknowledged = state.revision > pendingIntent.baseRevision && state.playback.playing === pendingIntent.playing && Math.abs(state.playback.positionMs - expected) < 2000;
      if (acknowledged || state.currentTrackId !== pendingIntent.trackId || state.hostId !== clientId || state.hold) clearIntent();
    }
    if (!clockSamples.length) clockOffset = message.serverTime - Date.now();
    room = message.room;
    lastRevision = room.revision;
    connected = true;
    reconnectDelay = 600;
    connectionLabel('Connected', true);
    renderRoom();
    if (isHeld() && !localAdPlaying) {
      nativeCheck = null;
      invalidateReconcile();
      commandPlayback(false);
    }
    if (firstState) {
      clearInterval(pingTimer);
      const ping = () => send({ type: 'ping', sentAt: Date.now() });
      ping();
      setTimeout(ping, 250);
      setTimeout(ping, 750);
      pingTimer = setInterval(ping, 10000);
      joinedOnce = true;
      if (firstTrack) {
        if (firstTrack.playlist) previewPlaylist(firstTrack.url);
        else send({ type: 'add', url: firstTrack.url });
        firstTrack = null;
      }
    }
    if (previousHost && previousHost !== room.hostId) toast(isHost() ? 'You’re hosting now.' : 'The room has a new host.');
    const track = currentTrack();
    if (track && (previousTrack !== track.id || loadedTrackId !== track.id)) loadTrack(track);
    else if (!track) clearPlayer();
    else if (playerReady) reconcile(timelineChanged || previousPlaying !== room.playback.playing || firstState);
  });
  next.addEventListener('close', (event) => {
    if (socket !== next) return;
    connected = false;
    pendingHold = null;
    localAdPlaying = false;
    finishingTrackId = null;
    nativeCheck = null;
    clearIntent();
    widgetEchoes = [];
    syncing = false;
    pendingForce = false;
    syncAttempt++;
    clearInterval(pingTimer);
    if (widget && playerReady) {
      commandPlayback(false);
      lastWidgetPlaying = false;
    }
    renderControls();
    if (stopped) return;
    // A newer connection owns this identity, so this tab should stop competing.
    if (event.code === 4001 || event.code === 4009) {
      stopped = true;
      connectionLabel('Session replaced');
      setSync('This session moved to another connection', true);
      return;
    }
    connectionLabel('Reconnecting');
    setSync('Connection lost · playback paused', true);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(10000, reconnectDelay * 1.7);
  });
  next.addEventListener('error', () => connectionLabel('Connection interrupted'));
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderRoom() {
  $('room-subtitle').textContent = isHost() ? 'You’re hosting' : 'Listening together';
  const waiter = room.hold?.waiters?.find((member) => member.memberId === clientId);
  if ((!room.hold && !pendingHold) || waiter?.ready) { waitingLocally = false; localAdPlaying = false; }
  else if (waiter || room.hold?.memberId === clientId) waitingLocally = true;
  $('people-count').textContent = room.members.filter((member) => member.connected).length;
  $('people').replaceChildren(...room.members.map((member, index) => {
    const item = el('li', `person${member.connected ? '' : ' away'}`);
    const avatar = el('span', `avatar avatar-${index % 4}`, member.name.slice(0, 1).toUpperCase());
    item.append(avatar, el('span', 'person-name', member.name + (member.id === clientId ? ' (you)' : '')));
    if (member.id === room.hostId) item.append(el('span', 'host-tag', 'HOST'));
    if (!member.connected) item.append(el('span', 'host-tag', 'AWAY'));
    return item;
  }));
  $('queue-count').textContent = room.queue.length;
  $('empty-queue').hidden = room.queue.length > 0;
  if (window.SCJamsQueue?.render) {
    window.SCJamsQueue.render({ queue: room.queue, currentTrackId: room.currentTrackId, isHost: isHost(), connected, members: room.members,
      onSelect: (trackId) => send({ type: 'control', action: 'select', trackId }),
      onRemove: (trackId) => send({ type: 'control', action: 'remove', trackId }),
      onReorder: (trackIds) => send({ type: 'control', action: 'reorder', trackIds }),
    });
  } else $('queue').replaceChildren(...room.queue.map((track, index) => {
    const active = track.id === room.currentTrackId;
    const item = el('li', `queue-item${active ? ' current' : ''}`);
    const select = el('button', 'queue-track');
    select.type = 'button';
    select.disabled = !isHost() || !connected;
    select.title = isHost() ? 'Select this track' : 'The host selects tracks';
    const number = el('span', 'queue-number', active ? '' : String(index + 1).padStart(2, '0'));
    if (active) number.innerHTML = icon('audio-lines');
    select.append(number);
    const info = el('span', 'queue-track-info');
    const contributor = room.members.find((member) => member.id === track.addedBy)?.name || 'a friend';
    info.append(el('strong', '', track.title || track.url.split('/').at(-1).replaceAll('-', ' ')), el('span', '', active ? 'Now playing' : `Added by ${contributor}`));
    select.append(info);
    select.addEventListener('click', () => send({ type: 'control', action: 'select', trackId: track.id }));
    item.append(select);
    if (isHost()) {
      const remove = el('button', 'remove-track');
      remove.innerHTML = icon('x');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${track.title || 'track'} from queue`);
      remove.disabled = !connected;
      remove.addEventListener('click', () => send({ type: 'control', action: 'remove', trackId: track.id }));
      item.append(remove);
    }
    return item;
  }));
  const track = currentTrack();
  $('track-link').hidden = !track;
  if (track) {
    $('track-title').textContent = track.title || track.url.split('/').at(-1).replaceAll('-', ' ');
    $('track-artist').textContent = track.artist || 'SoundCloud';
    $('track-link').href = track.url;
    if (track.duration) knownDuration = track.duration;
  }
  renderControls();
}
function renderControls() {
  const track = currentTrack();
  const controls = Boolean(isHost() && track && connected && playerReady && !playerUnavailable && !waitingLocally && !pendingHold && !unreadyWaiters().length);
  $('play-button').disabled = !controls;
  const nextIndex = room?.queue.findIndex((entry) => entry.id === room.currentTrackId) ?? -1;
  $('skip-button').disabled = !isHost() || !connected || nextIndex < 0 || nextIndex >= (room?.queue.length || 0) - 1;
  $('seek').disabled = !controls || !knownDuration;
  $('add-button').disabled = !connected;
  $('import-playlist-button').disabled = !connected || !playlistTracks.length;
  const playing = playbackState()?.playing;
  $('play-icon').innerHTML = icon(playing ? 'pause' : 'play');
  $('play-button').setAttribute('aria-label', playing ? 'Pause shared track' : 'Play shared track');
  $('playback-label').textContent = track ? !playerReady ? 'Loading player' : playerUnavailable ? 'Unavailable' : playing ? 'Playing' : 'Paused' : '';
  const waiting = room?.hold?.waiters?.filter((member) => !member.ready).map((member) => member.name) || (room?.hold ? [room.hold.name] : []);
  const ownWaiter = room?.hold?.waiters?.find((member) => member.memberId === clientId);
  $('role-hint').textContent = pendingHold ? 'Pausing the room…' : room?.hold ? waiting.length ? `Paused · waiting for ${waiting.join(', ')}` : 'Everyone is ready. Host can resume.' : isHost() ? 'You control playback.' : 'Following the host.';
  $('wait-button').textContent = waitingLocally ? 'I’m ready' : ownWaiter?.ready ? 'Ready' : 'Wait for me';
  $('wait-button').disabled = !track || !connected || Boolean(ownWaiter?.ready) || Boolean(pendingHold);
  $('local-ad-button').hidden = !waitingLocally || !isHeld();
  $('local-ad-button').disabled = !connected || !playerReady || playerUnavailable;
  $('local-ad-button').textContent = localAdPlaying ? 'Pause my audio' : 'Let my ad finish';
  $('local-ad-button').setAttribute('aria-pressed', String(localAdPlaying));
  $('volume').disabled = false;
  $('resync-button').hidden = !track;
  $('resync-button').disabled = waitingLocally || !playerReady || !connected || playerUnavailable;
  $('enable-audio').hidden = !track || audioEnabled;
  $('enable-audio').disabled = !playerReady || !connected || playerUnavailable;
}
function eventsAllowed() { return isHost() && connected && playerReady && !isHeld() && !finishingTrackId; }
function clearPlayer() {
  loadGeneration++;
  nativeCheck = null;
  clearIntent();
  widgetEchoes = [];
  syncing = false;
  pendingForce = false;
  syncAttempt++;
  playerReady = false;
  loadedTrackId = null;
  finishingTrackId = null;
  clearTimeout(endPauseTimer);
  endPauseTimer = null;
  if (widget) widget.pause();
  widget = null;
  knownDuration = 0;
  lastPosition = 0;
  $('embed-container').replaceChildren();
  $('empty-player').hidden = false;
  $('active-player').hidden = true;
  setSync('Ready when you are');
}
function loadTrack(track) {
  if (loadedTrackId === track.id) return;
  const generation = ++loadGeneration;
  finishingTrackId = null;
  clearTimeout(endPauseTimer);
  endPauseTimer = null;
  nativeCheck = null;
  clearIntent();
  widgetEchoes = [];
  syncing = false;
  pendingForce = false;
  syncAttempt++;
  loadedTrackId = track.id;
  playerReady = false;
  playerUnavailable = false;
  knownDuration = track.duration || 0;
  lastPosition = 0;
  lastWidgetPlaying = false;
  if (widget) widget.pause();
  widget = null;
  $('empty-player').hidden = true;
  $('active-player').hidden = false;
  renderControls();
  errorAt('player-error');
  setSync('Getting the track ready');
  const iframe = document.createElement('iframe');
  iframe.title = 'SoundCloud track player';
  iframe.allow = 'autoplay';
  iframe.height = '166';
  iframe.scrolling = 'no';
  const continuePlaying = audioEnabled && room?.playback.playing && !isHeld();
  iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(track.url)}&auto_play=${continuePlaying}&single_active=false&color=%23f5613c&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=false`;
  $('embed-container').replaceChildren(iframe);
  function bindWidget(attempt = 0) {
    if (generation !== loadGeneration) return;
    if (!window.SC?.Widget) {
      if (attempt < 40) { setTimeout(() => bindWidget(attempt + 1), 250); return; }
      errorAt('player-error', 'The SoundCloud player could not load. Check your connection or allow SoundCloud in your browser’s privacy settings.');
      setSync('Player unavailable', true);
      playerUnavailable = true;
      renderControls();
      return;
    }
    const instance = window.SC.Widget(iframe);
    widget = instance;
    const events = window.SC.Widget.Events;
    const valid = () => generation === loadGeneration && widget === instance;
    instance.bind(events.READY, () => {
      if (!valid()) return;
      playerReady = true;
      renderControls();
      applyVolume();
      if (audioEnabled && playbackState()?.playing && !isHeld()) commandPlayback(true);
      instance.getDuration((duration) => { if (valid()) { knownDuration = duration || 0; renderControls(); } });
      instance.getCurrentSound((sound) => {
        if (!valid() || !sound) return;
        $('track-title').textContent = sound.title || 'SoundCloud track';
        $('track-artist').textContent = sound.user?.username || 'SoundCloud';
        if (isHost()) send({ type: 'metadata', trackId: track.id, title: sound.title, artist: sound.user?.username, artwork: sound.artwork_url, duration: sound.duration });
      });
      reconcile(true);
    });
    instance.bind(events.PLAY_PROGRESS, (event) => {
      if (!valid()) return;
      lastPosition = event.currentPosition || 0;
      lastPositionAt = performance.now();
      if (lastPosition > 0 && room?.playback.playing) {
        audioEnabled = true;
        $('enable-audio').hidden = true;
      }
    });
    instance.bind(events.PLAY, (event = {}) => {
      if (!valid()) return;
      handleNativePlayback(true, event);
    });
    instance.bind(events.PAUSE, (event = {}) => {
      if (!valid()) return;
      // Native controls are user input too. Publish immediately: waiting for a
      // getter here let a periodic sync restart a genuinely paused host player.
      handleNativePlayback(false, event);
    });
    instance.bind(events.SEEK, (event) => {
      if (!valid()) return;
      lastPosition = event.currentPosition || 0;
      lastPositionAt = performance.now();
      if (consumeWidgetEvent('SEEK', lastPosition)) return;
      if (eventsAllowed() && Math.abs(lastPosition - targetPosition()) > 250) hostIntent('seek', lastPosition, false);
      else if (!isHost()) setTimeout(() => reconcile(true), 100);
    });
    instance.bind(events.FINISH, () => {
      if (valid()) finishCurrentTrack();
    });
    instance.bind(events.ERROR, () => {
      if (!valid()) return;
      playerUnavailable = true;
      invalidateReconcile();
      renderControls();
      errorAt('player-error', 'SoundCloud couldn’t play this track here. It may be restricted or embedding may be disabled. The host can skip it.');
      setSync('Track unavailable on this device', true);
    });
  }
  bindWidget();
  setTimeout(() => {
    if (generation === loadGeneration && !playerReady) {
      errorAt('player-error', 'Still waiting for SoundCloud. Try another track, or check that your browser allows the embedded player.');
      setSync('Waiting for SoundCloud', true);
      renderControls();
    }
  }, 18000);
}
function reconcile(force = false) {
  if (finishingTrackId === room?.currentTrackId || endPauseTimer) return;
  if (isHeld()) {
    if (localAdPlaying) { setSync('Only your audio is playing · the room is paused', true); return; }
    commandPlayback(false);
    setSync('Room paused while listeners get ready', true);
    return;
  }
  if (nativeCheck) return;
  if (!widget || !playerReady || !connected || !currentTrack() || playerUnavailable) return;
  if (syncing) { pendingForce ||= force; return; }
  const instance = widget, generation = loadGeneration, attempt = ++syncAttempt, serial = intentSerial;
  let active = true;
  syncing = true;
  const valid = () => active && connected && !isHeld() && generation === loadGeneration && instance === widget && attempt === syncAttempt && serial === intentSerial;
  const finish = () => {
    if (!valid()) return;
    active = false;
    clearTimeout(release);
    syncing = false;
    if (pendingForce) { pendingForce = false; reconcile(true); }
  };
  // Every asynchronous getter is scoped to this track to avoid stale corrections.
  const release = setTimeout(finish, 2000);
  instance.getPosition((position) => {
    if (!valid()) return;
    instance.isPaused((paused) => {
      if (!valid()) return;
      lastPosition = position;
      lastPositionAt = performance.now();
      lastWidgetPlaying = !paused;
      const drift = targetPosition() - position;
      if ((force && Math.abs(drift) > 250) || (Math.abs(drift) > 1100 && performance.now() - lastCorrection > 4500)) {
        commandSeek(targetPosition());
        lastCorrection = performance.now();
      }
      const playing = playbackState().playing;
      if (playing && audioEnabled && paused) commandPlayback(true);
      else if (!playing && !paused) commandPlayback(false);
      if (!audioEnabled) setSync('Tap “Enable listening” to hear the room', true);
      else if (playing && paused) setSync('Starting playback');
      else setSync(playing ? 'Listening together' : 'Paused');
      finish();
    });
  });
}
function time(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
setInterval(() => {
  if (!room) return;
  const duration = knownDuration || currentTrack()?.duration || 0;
  const estimate = playbackState().playing && lastWidgetPlaying ? lastPosition + Math.max(0, performance.now() - lastPositionAt) : lastPosition;
  $('elapsed').textContent = time(Math.min(duration || Infinity, estimate));
  $('duration').textContent = time(duration);
  if (document.activeElement !== $('seek')) $('seek').value = duration ? Math.round(estimate / duration * 1000) : 0;
}, 250);
setInterval(() => reconcile(), 2500);
// Server time remains authoritative. Host reports are deliberately infrequent and
// only correct real buffering stalls, rather than moving the room every frame.
heartbeatTimer = setInterval(() => {
  if (!isHost() || !connected || !playerReady || !audioEnabled || waitingLocally || syncing || pendingIntent || playerUnavailable || !room.playback.playing || !lastWidgetPlaying) return;
  const instance = widget, trackId = loadedTrackId, baseRevision = room.revision;
  instance.getPosition((position) => {
    if (instance !== widget || trackId !== room?.currentTrackId || baseRevision !== room?.revision) return;
    if (Math.abs(targetPosition() - position) > 1500 && Date.now() - lastHostReport > 8000) {
      lastHostReport = Date.now();
      send({ type: 'position', trackId, positionMs: position, playing: true, baseRevision });
    }
  });
}, 5000);

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  errorAt('create-error');
  const button = $('create-button');
  button.disabled = true;
  try {
    firstTrack = $('first-track').value.trim() ? musicLink($('first-track').value) : null;
    const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || result.error || 'Couldn’t create the room. Try again.');
    audioEnabled = false;
    openRoom(result.roomId, $('create-name').value);
  } catch (error) { errorAt('create-error', error.message); }
  finally { button.disabled = false; }
});
$('show-join').addEventListener('click', () => { $('join-code-form').hidden = !$('join-code-form').hidden; if (!$('join-code-form').hidden) $('room-link').focus(); });
$('join-code-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try { showJoin(roomCode($('room-link').value)); }
  catch (error) { errorAt('create-error', error.message); }
});
$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  errorAt('join-error');
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (!response.ok) throw new Error('This room has ended or doesn’t exist. Start a new one from the home page.');
    audioEnabled = false;
    openRoom(roomId, $('join-name').value);
  } catch (error) { errorAt('join-error', error.message); }
});
$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  errorAt('queue-error');
  try {
    const link = musicLink($('track-url').value);
    if (!connected) throw new Error('Wait for the room to reconnect, then try again.');
    if (link.playlist) previewPlaylist(link.url);
    else if (!send({ type: 'add', url: link.url })) throw new Error('Wait for the room to reconnect, then try again.');
    $('track-url').value = '';
  } catch (error) { errorAt('queue-error', error.message); }
});
$('invite-button').addEventListener('click', async () => {
  const invite = `${location.origin}/room/${roomId}`;
  try { await navigator.clipboard.writeText(invite); toast('Invite copied.'); }
  catch { window.prompt('Copy this room link:', invite); }
});
$('play-button').addEventListener('click', () => {
  if (!isHost() || !currentTrack() || !playerReady || !connected || playerUnavailable || waitingLocally) return;
  audioEnabled = true;
  $('enable-audio').hidden = true;
  const playing = playbackState().playing;
  hostIntent(playing ? 'pause' : 'play', playing ? lastPosition : targetPosition());
});
$('skip-button').addEventListener('click', () => {
  if ($('skip-button').disabled) return;
  clearIntent();
  invalidateReconcile();
  send({ type: 'control', action: 'skip', trackId: room.currentTrackId });
});
$('seek').addEventListener('change', () => {
  if ($('seek').disabled) return;
  hostIntent('seek', Number($('seek').value) / 1000 * knownDuration);
});
$('enable-audio').addEventListener('click', () => {
  if (!playerReady || !widget || !connected || playerUnavailable) return;
  audioEnabled = true;
  $('enable-audio').hidden = true;
  if (playbackState().playing) { commandSeek(targetPosition()); commandPlayback(true); }
  else if (isHost()) hostIntent('play', targetPosition());
  else toast('You’re ready. Playback starts when the host presses play.');
  reconcile(true);
});
$('resync-button').addEventListener('click', () => {
  if ($('resync-button').disabled || $('resync-button').hidden) return;
  lastCorrection = 0;
  reconcile(true);
  toast('Catching up to the room.');
});
$('volume').addEventListener('input', () => {
  volume = Math.max(0, Math.min(100, Number($('volume').value) || 0));
  if (volume > 0) unmutedVolume = volume;
  applyVolume();
});
$('mute-button').addEventListener('click', () => {
  if (volume > 0) { unmutedVolume = volume; volume = 0; }
  else volume = unmutedVolume;
  applyVolume();
});
$('theme-toggle').addEventListener('click', () => applyTheme(storage.get('theme') === 'dark' ? 'light' : 'dark'));
$('wait-button').addEventListener('click', () => {
  if (!connected || !currentTrack()) return;
  if (waitingLocally) {
    waitingLocally = false;
    localAdPlaying = false;
    nativeCheck = null;
    clearIntent();
    commandPlayback(false);
    send({ type: 'hold_ready' });
    reconcile(true);
  } else {
    waitingLocally = true;
    localAdPlaying = false;
    nativeCheck = null;
    clearIntent();
    pendingHold = { trackId: room.currentTrackId, playing: false, positionMs: lastPosition, updatedAt: serverNow() };
    commandPlayback(false);
    if (!send({ type: 'hold' })) { pendingHold = null; waitingLocally = false; }
    else {
      const request = pendingHold;
      setTimeout(() => {
        if (pendingHold !== request) return;
        pendingHold = null;
        waitingLocally = false;
        localAdPlaying = false;
        renderControls();
        reconcile(true);
        toast('The pause request was not confirmed. Try again.');
      }, 5000);
    }
    setSync('Pausing the room', true);
  }
  renderControls();
});
$('local-ad-button').addEventListener('click', () => {
  if (!waitingLocally || !isHeld() || !connected || !playerReady || playerUnavailable) return;
  nativeCheck = null;
  invalidateReconcile();
  localAdPlaying = !localAdPlaying;
  audioEnabled = true;
  commandPlayback(localAdPlaying);
  renderControls();
});
$('import-playlist-button').addEventListener('click', () => {
  if (!playlistTracks.length) return;
  if (send({ type: 'add_many', tracks: playlistTracks })) { closePlaylist(); toast('Playlist sent to the queue.'); }
  else toast('Reconnect to the room before importing.');
});
$('cancel-playlist-button').addEventListener('click', closePlaylist);
function leaveRoom() {
  stopped = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  const previous = socket;
  socket = null;
  previous?.close();
  connected = false;
  waitingLocally = false;
  pendingHold = null;
  localAdPlaying = false;
  window.SCJamsQueue?.clear();
  closePlaylist();
  clearPlayer();
  room = null;
  roomId = null;
  lastRevision = -1;
  joinedOnce = false;
  clockSamples = [];
  history.replaceState(null, '', '/');
  $('room-view').hidden = true;
  $('join-overlay').hidden = true;
  $('landing').hidden = false;
  document.title = 'sc jams';
}
$('leave-room').addEventListener('click', leaveRoom);
$('join-back').addEventListener('click', leaveRoom);
applyVolume();
applyTheme(storage.get('theme') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
document.addEventListener('visibilitychange', () => { if (!document.hidden) { send({ type: 'ping', sentAt: Date.now() }); reconcile(true); } });
window.addEventListener('beforeunload', () => { stopped = true; clearInterval(heartbeatTimer); socket?.close(); });

const path = location.pathname.match(/^\/room\/([A-Za-z0-9_-]{6,64})\/?$/);
if (path) {
  showJoin(path[1]);
}
