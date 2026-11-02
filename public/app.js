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
const initialName = storage.get('name') || '';
$('create-name').value = initialName;
$('join-name').value = initialName;
let socket, room, roomId, displayName, reconnectTimer, pingTimer, heartbeatTimer;
let reconnectDelay = 600, stopped = false, connected = false;
let clockOffset = 0, clockSamples = [], lastRevision = -1, joinedOnce = false;
let widget, loadedTrackId, playerReady = false, loadGeneration = 0;
let audioEnabled = false, syncing = false, ignoreEventsUntil = 0, lastCorrection = 0;
let pendingForce = false, syncAttempt = 0;
let lastPosition = 0, lastPositionAt = 0, knownDuration = 0, lastWidgetPlaying = false;
let lastHostReport = 0, playerUnavailable = false;
let toastTimer, firstTrack;
let volume = Number(storage.get('volume') ?? 70);
if (!Number.isFinite(volume)) volume = 70;
volume = Math.max(0, Math.min(100, volume));
let unmutedVolume = volume || 70;
let playlistWidget, playlistGeneration = 0, playlistTracks = [], playlistTimer;
let waitingLocally = false;
const isHost = () => room?.hostId === clientId;
const serverNow = () => Date.now() + clockOffset;
const currentTrack = () => room?.queue.find((track) => track.id === room.currentTrackId);
const targetPosition = () => {
  if (!room) return 0;
  const state = room.playback;
  let position = state.positionMs + (state.playing ? Math.max(0, serverNow() - state.updatedAt) : 0);
  const duration = currentTrack()?.duration || knownDuration;
  return Math.max(0, duration ? Math.min(position, duration) : position);
};
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
  $('mute-button').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/>${volume === 0 ? '<path d="m16 9 5 6m0-6-5 6"/>' : '<path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>'}</svg>`;
  $('mute-button').setAttribute('aria-label', volume === 0 ? 'Unmute your audio' : 'Mute your audio');
  $('mute-button').setAttribute('aria-pressed', String(volume === 0));
  if (widget && playerReady) widget.setVolume(volume);
  storage.set('volume', String(volume));
}
function applyTheme(theme) {
  document.documentElement?.setAttribute('data-theme', theme);
  $('theme-toggle').textContent = theme === 'dark' ? '☀' : '◐';
  $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  $('theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
  storage.set('theme', theme);
}
async function loadLinks() {
  $('links-toggle').hidden = true;
  try {
    const response = await fetch('/links.json');
    if (!response.ok) return;
    const configured = await response.json();
    if (!Array.isArray(configured)) return;
    const links = [];
    for (const link of configured.slice(0, 8)) {
      try {
        const url = new URL(link.url);
        if (url.protocol !== 'https:' || url.username || url.password || typeof link.label !== 'string' || !link.label.trim()) continue;
        const anchor = document.createElement('a');
        anchor.textContent = link.label.trim().slice(0, 40);
        anchor.href = url.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        links.push(anchor);
      } catch { /* Ignore incomplete optional links. */ }
    }
    if (!links.length) return;
    $('links-panel').replaceChildren(...links);
    $('links-toggle').hidden = false;
  } catch { /* Optional social links never block creating a room. */ }
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
  displayName = name.trim().slice(0, 24) || `Listener ${clientId.slice(0, 4)}`;
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
    if (!clockSamples.length) clockOffset = message.serverTime - Date.now();
    room = message.room;
    lastRevision = room.revision;
    connected = true;
    reconnectDelay = 600;
    connectionLabel('Connected', true);
    renderRoom();
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
    syncing = false;
    pendingForce = false;
    syncAttempt++;
    clearInterval(pingTimer);
    if (widget && playerReady) {
      suppressEvents();
      widget.pause();
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
  if (!room.hold || waiter?.ready) waitingLocally = false;
  else if (waiter || room.hold.memberId === clientId) waitingLocally = true;
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
  $('queue').replaceChildren(...room.queue.map((track, index) => {
    const active = track.id === room.currentTrackId;
    const item = el('li', `queue-item${active ? ' current' : ''}`);
    const select = el('button', 'queue-track');
    select.type = 'button';
    select.disabled = !isHost() || !connected;
    select.title = isHost() ? 'Select this track' : 'The host selects tracks';
    select.append(el('span', 'queue-number', active ? '♫' : String(index + 1).padStart(2, '0')));
    const info = el('span', 'queue-track-info');
    const contributor = room.members.find((member) => member.id === track.addedBy)?.name || 'a friend';
    info.append(el('strong', '', track.title || track.url.split('/').at(-1).replaceAll('-', ' ')), el('span', '', active ? 'Now playing' : `Added by ${contributor}`));
    select.append(info);
    select.addEventListener('click', () => send({ type: 'control', action: 'select', trackId: track.id }));
    item.append(select);
    if (isHost()) {
      const remove = el('button', 'remove-track', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${track.title || 'track'} from queue`);
      remove.disabled = !connected;
      remove.addEventListener('click', () => send({ type: 'control', action: 'remove', trackId: track.id }));
      item.append(remove);
    }
    return item;
  }));
  const track = currentTrack();
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
  const controls = Boolean(isHost() && track && connected);
  $('play-button').disabled = !controls;
  $('skip-button').disabled = !controls || !room?.queue.length;
  $('seek').disabled = !controls || !knownDuration;
  $('add-button').disabled = !connected;
  $('play-icon').textContent = room?.playback.playing ? 'Ⅱ' : '▶';
  $('play-button').setAttribute('aria-label', room?.playback.playing ? 'Pause shared track' : 'Play shared track');
  $('playback-label').textContent = track ? room.playback.playing ? 'Playing' : 'Paused' : '';
  const waiting = room?.hold?.waiters?.filter((member) => !member.ready).map((member) => member.name) || (room?.hold ? [room.hold.name] : []);
  $('role-hint').textContent = room?.hold ? waiting.length ? `Waiting for ${waiting.join(', ')}` : 'Everyone is ready. Host can resume.' : isHost() ? 'You control playback.' : 'Following the host.';
  $('wait-button').textContent = waitingLocally ? 'I’m ready' : 'Wait for me';
  $('wait-button').disabled = !track || !connected;
  $('volume').disabled = false;
  $('resync-button').hidden = !track;
  $('resync-button').disabled = waitingLocally;
  $('enable-audio').hidden = !track || audioEnabled;
}
function suppressEvents() { ignoreEventsUntil = performance.now() + 1100; }
function eventsAllowed() { return isHost() && connected && playerReady && !waitingLocally && !syncing && performance.now() > ignoreEventsUntil; }
function clearPlayer() {
  loadGeneration++;
  syncing = false;
  pendingForce = false;
  syncAttempt++;
  playerReady = false;
  loadedTrackId = null;
  if (widget) { suppressEvents(); widget.pause(); }
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
  syncing = false;
  pendingForce = false;
  syncAttempt++;
  loadedTrackId = track.id;
  playerReady = false;
  playerUnavailable = false;
  knownDuration = track.duration || 0;
  lastPosition = 0;
  lastWidgetPlaying = false;
  if (widget) { suppressEvents(); widget.pause(); }
  widget = null;
  $('empty-player').hidden = true;
  $('active-player').hidden = false;
  errorAt('player-error');
  setSync('Getting the track ready');
  const iframe = document.createElement('iframe');
  iframe.title = 'SoundCloud track player';
  iframe.allow = 'autoplay';
  iframe.height = '166';
  iframe.scrolling = 'no';
  iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(track.url)}&auto_play=false&color=%23f5613c&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=false`;
  $('embed-container').replaceChildren(iframe);
  function bindWidget(attempt = 0) {
    if (generation !== loadGeneration) return;
    if (!window.SC?.Widget) {
      if (attempt < 40) { setTimeout(() => bindWidget(attempt + 1), 250); return; }
      errorAt('player-error', 'The SoundCloud player could not load. Check your connection or allow SoundCloud in your browser’s privacy settings.');
      setSync('Player unavailable', true);
      return;
    }
    const instance = window.SC.Widget(iframe);
    widget = instance;
    const events = window.SC.Widget.Events;
    const valid = () => generation === loadGeneration && widget === instance;
    instance.bind(events.READY, () => {
      if (!valid()) return;
      playerReady = true;
      applyVolume();
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
    instance.bind(events.PLAY, () => {
      if (!valid()) return;
      lastWidgetPlaying = true;
      audioEnabled = true;
      $('enable-audio').hidden = true;
      if (eventsAllowed() && !room.playback.playing) send({ type: 'control', action: 'play', positionMs: lastPosition });
      else if (!isHost() && !room?.playback.playing) setTimeout(() => reconcile(true), 50);
    });
    instance.bind(events.PAUSE, () => {
      if (!valid()) return;
      lastWidgetPlaying = false;
      if (eventsAllowed() && room.playback.playing) {
        const revision = room.revision;
        instance.getPosition((position) => { if (valid() && eventsAllowed() && room.revision === revision && room.playback.playing) send({ type: 'control', action: 'pause', positionMs: position }); });
      } else if (!isHost() && room?.playback.playing && audioEnabled) setTimeout(() => reconcile(true), 100);
    });
    instance.bind(events.SEEK, (event) => {
      if (!valid()) return;
      lastPosition = event.currentPosition || 0;
      lastPositionAt = performance.now();
      if (eventsAllowed()) send({ type: 'control', action: 'seek', positionMs: lastPosition });
      else if (!isHost() && performance.now() > ignoreEventsUntil) setTimeout(() => reconcile(true), 100);
    });
    instance.bind(events.FINISH, () => {
      if (valid() && isHost() && connected && !waitingLocally && room?.playback.playing) send({ type: 'control', action: 'skip' });
    });
    instance.bind(events.ERROR, () => {
      if (!valid()) return;
      playerUnavailable = true;
      errorAt('player-error', 'SoundCloud couldn’t play this track here. It may be restricted or embedding may be disabled. The host can skip it.');
      setSync('Track unavailable on this device', true);
    });
  }
  bindWidget();
  setTimeout(() => {
    if (generation === loadGeneration && !playerReady) {
      errorAt('player-error', 'Still waiting for SoundCloud. Try another track, or check that your browser allows the embedded player.');
      setSync('Waiting for SoundCloud', true);
    }
  }, 18000);
}
function reconcile(force = false) {
  // The requester finishes their ad locally. Widget events cannot identify ads,
  // so no seek/pause/play commands are sent until they explicitly mark ready.
  if (waitingLocally) { setSync('Finish your ad, then choose “I’m ready”', true); return; }
  if (!widget || !playerReady || !connected || !currentTrack() || playerUnavailable) return;
  if (syncing) { pendingForce ||= force; return; }
  const instance = widget, generation = loadGeneration, attempt = ++syncAttempt;
  let active = true;
  syncing = true;
  const valid = () => active && connected && !waitingLocally && generation === loadGeneration && instance === widget && attempt === syncAttempt;
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
      const drift = targetPosition() - position;
      if ((force && Math.abs(drift) > 250) || (Math.abs(drift) > 1100 && performance.now() - lastCorrection > 4500)) {
        suppressEvents();
        instance.seekTo(targetPosition());
        lastCorrection = performance.now();
      }
      if (room.playback.playing && audioEnabled && paused) { suppressEvents(); instance.play(); }
      else if (!room.playback.playing && !paused) { suppressEvents(); instance.pause(); }
      lastPosition = position;
      lastPositionAt = performance.now();
      lastWidgetPlaying = !paused;
      if (!audioEnabled) setSync('Tap “Enable listening” to hear the room', true);
      else if (room.playback.playing && paused) setSync('Starting playback');
      else setSync(room.playback.playing ? 'Following the room' : 'Together, on pause');
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
  const estimate = room.playback.playing && lastWidgetPlaying ? lastPosition + Math.max(0, performance.now() - lastPositionAt) : lastPosition;
  $('elapsed').textContent = time(Math.min(duration || Infinity, estimate));
  $('duration').textContent = time(duration);
  if (document.activeElement !== $('seek')) $('seek').value = duration ? Math.round(estimate / duration * 1000) : 0;
}, 250);
setInterval(() => reconcile(), 2500);
// Server time remains authoritative. Host reports are deliberately infrequent and
// only correct real buffering stalls, rather than moving the room every frame.
heartbeatTimer = setInterval(() => {
  if (!isHost() || !connected || !playerReady || !audioEnabled || waitingLocally || syncing || playerUnavailable || !room.playback.playing || !lastWidgetPlaying || performance.now() < ignoreEventsUntil) return;
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
  if (!isHost() || !currentTrack()) return;
  audioEnabled = true;
  $('enable-audio').hidden = true;
  if (widget && playerReady) {
    suppressEvents();
    if (!room.playback.playing) widget.play(); else widget.pause();
  }
  send({ type: 'control', action: room.playback.playing ? 'pause' : 'play', positionMs: room.playback.playing ? lastPosition : targetPosition() });
});
$('skip-button').addEventListener('click', () => send({ type: 'control', action: 'skip' }));
$('seek').addEventListener('change', () => send({ type: 'control', action: 'seek', positionMs: Number($('seek').value) / 1000 * knownDuration }));
$('enable-audio').addEventListener('click', () => {
  audioEnabled = true;
  $('enable-audio').hidden = true;
  if (!playerReady || !widget) { toast('The player is still loading. Playback will follow when it’s ready.'); return; }
  suppressEvents();
  if (room.playback.playing) { widget.seekTo(targetPosition()); widget.play(); }
  else if (isHost()) { widget.play(); send({ type: 'control', action: 'play', positionMs: targetPosition() }); }
  else toast('You’re ready. Playback starts when the host presses play.');
  reconcile(true);
});
$('resync-button').addEventListener('click', () => { lastCorrection = 0; reconcile(true); toast('Catching up to the room.'); });
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
    send({ type: 'hold_ready' });
    reconcile(true);
  } else {
    waitingLocally = true;
    syncing = false;
    pendingForce = false;
    syncAttempt++;
    send({ type: 'hold' });
    setSync('Finish your ad, then choose “I’m ready”', true);
  }
  renderControls();
});
$('import-playlist-button').addEventListener('click', () => {
  if (!playlistTracks.length) return;
  if (send({ type: 'add_many', tracks: playlistTracks })) { closePlaylist(); toast('Playlist sent to the queue.'); }
});
$('cancel-playlist-button').addEventListener('click', closePlaylist);
$('links-toggle').addEventListener('click', () => {
  $('links-panel').hidden = !$('links-panel').hidden;
  $('links-toggle').setAttribute('aria-expanded', String(!$('links-panel').hidden));
});
function leaveRoom() {
  stopped = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  const previous = socket;
  socket = null;
  previous?.close();
  connected = false;
  waitingLocally = false;
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
loadLinks();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { send({ type: 'ping', sentAt: Date.now() }); reconcile(true); } });
window.addEventListener('beforeunload', () => { stopped = true; clearInterval(heartbeatTimer); socket?.close(); });

const path = location.pathname.match(/^\/room\/([A-Za-z0-9_-]{6,64})\/?$/);
if (path) {
  showJoin(path[1]);
}
