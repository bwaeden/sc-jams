import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const EVENTS = Object.fromEntries(['READY', 'PLAY_PROGRESS', 'PLAY', 'PAUSE', 'SEEK', 'FINISH', 'ERROR'].map((event) => [event, event]));

// This deliberately leaves widget getters pending. SoundCloud's iframe API is
// asynchronous, so track changes and server updates can arrive before a getter.
function browser({ saved = {}, asyncEvents = false, responses = {} } = {}) {
  let timestamp = 1_800_000_000_000, monotonic = 10_000, timerId = 0;
  const intervals = [], timeouts = new Map(), elements = new Map(), widgets = [], sockets = [], messages = [], widgetEvents = [], requests = [], clipboard = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.value = '';
      this.hidden = false;
      this.children = [];
      this.listeners = new Map();
      this.classList = { toggle() {} };
    }
    addEventListener(event, listener) { this.listeners.set(event, listener); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    focus() {}
  }
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const storage = (initial = {}) => {
    const values = new Map(Object.entries(initial));
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), snapshot: () => Object.fromEntries(values) };
  };
  const localStorage = storage(saved);
  const root = new Element('html');
  function Widget(iframe) {
    const callbacks = new Map();
    const instance = {
      iframe, callbacks, pendingPositions: [], pendingPaused: [], pendingSounds: [], calls: [], paused: true, volume: 100, deferPaused: false,
      bind(event, callback) { callbacks.set(event, callback); },
      emit(event, payload = {}) { callbacks.get(event)?.(payload); },
      getPosition(callback) { this.pendingPositions.push(callback); },
      resolvePosition(position) {
        const callback = this.pendingPositions.shift();
        assert.ok(callback, 'the client must have requested the widget position');
        callback(position);
      },
      isPaused(callback) { if (this.deferPaused) this.pendingPaused.push(callback); else callback(this.paused); },
      resolvePaused(paused = this.paused) { const callback = this.pendingPaused.shift(); assert.ok(callback); callback(paused); },
      getDuration(callback) { callback(240000); },
      getCurrentSound(callback) { callback({ title: 'Test track', user: { username: 'Test artist' }, duration: 240000 }); },
      getSounds(callback) { this.pendingSounds.push(callback); },
      resolveSounds(sounds) {
        const callback = this.pendingSounds.shift();
        assert.ok(callback, 'the client must have requested playlist sounds');
        callback(sounds);
      },
      setVolume(value) { this.volume = value; this.calls.push({ method: 'setVolume', volume: value }); },
      dispatch(event, payload = {}) { if (asyncEvents) widgetEvents.push(() => this.emit(event, payload)); else this.emit(event, payload); },
      seekTo(position) { this.calls.push({ method: 'seekTo', position }); this.dispatch(EVENTS.SEEK, { currentPosition: position }); },
      play() { this.calls.push({ method: 'play' }); this.paused = false; this.dispatch(EVENTS.PLAY); },
      pause() { this.calls.push({ method: 'pause' }); this.paused = true; this.dispatch(EVENTS.PAUSE); },
    };
    widgets.push(instance);
    return instance;
  }
  Widget.Events = EVENTS;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = new Map(); sockets.push(this); }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    send(raw) { messages.push(JSON.parse(raw)); }
    emit(event, payload) { if (event === 'close') this.readyState = 3; this.listeners.get(event)?.(payload); }
    close() { this.emit('close', { code: 1000 }); }
  }
  const context = vm.createContext({
    URL, console,
    crypto: { randomUUID },
    Date: class extends Date { static now() { return timestamp; } },
    performance: { now: () => monotonic },
    document: {
      getElementById: element, createElement: (tag) => new Element(tag),
      createTextNode: (text) => ({ textContent: text }), addEventListener() {},
      activeElement: null, hidden: false, documentElement: root,
    },
    localStorage, sessionStorage: storage(),
    location: { protocol: 'http:', origin: 'http://localhost:3000', host: 'localhost:3000', pathname: '/' },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async (value) => clipboard.push(value) } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const result = responses[url];
      if (!result) return { ok: false, json: async () => ({}) };
      return { ok: result.ok ?? true, json: async () => result.body ?? result };
    },
    window: { SC: { Widget }, addEventListener() {} },
    WebSocket: Socket,
    setTimeout(callback, ms) { const id = ++timerId; timeouts.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback, ms) { const id = ++timerId; intervals.push({ id, callback, ms }); return id; },
    clearInterval() {},
  });
  vm.runInContext(source + `
    globalThis.__appTest = {
      clientId, connect, loadTrack, clearPlayer, reconcile, targetPosition, previewPlaylist, closePlaylist,
      configure(next) {
        if ('room' in next) room = next.room;
        if ('connected' in next) connected = next.connected;
        if ('audioEnabled' in next) audioEnabled = next.audioEnabled;
        if ('clockOffset' in next) clockOffset = next.clockOffset;
        if ('socket' in next) socket = next.socket;
      },
      status() { return { syncing, loadedTrackId, loadGeneration, playerReady, pendingIntent, volume, waitingLocally, playlistTracks }; }
    };
  `, context, { filename: 'app.js' });
  const app = context.__appTest;
  app.configure({ connected: true, audioEnabled: true,
    socket: { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)) } });
  return {
    app, widgets, sockets, messages, element, localStorage, root, requests, clipboard,
    flushWidgetEvents() { while (widgetEvents.length) widgetEvents.shift()(); },
    discardWidgetEvents() { widgetEvents.length = 0; },
    event(id, type, payload = { preventDefault() {} }) {
      const callback = element(id).listeners.get(type);
      assert.ok(callback, `expected ${type} handler for ${id}`);
      return callback(payload);
    },
    now: () => timestamp,
    advance(ms) { timestamp += ms; monotonic += ms; },
    interval(ms) {
      const interval = intervals.find((timer) => timer.ms === ms);
      assert.ok(interval, `expected a ${ms}ms interval`);
      interval.callback();
    },
    timeout(ms) {
      const entry = [...timeouts].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `expected a pending ${ms}ms timeout`);
      timeouts.delete(entry[0]);
      entry[1].callback();
    },
  };
}

function track(id = 'track-a') {
  return { id, url: `https://soundcloud.com/artist/${id}`, title: id, artist: 'Artist', duration: 240000, addedBy: 'friend' };
}

function room(browser, { host = false, id = 'track-a', playing = true, position = 10000, updatedAt = browser.now(), revision = 1, generation } = {}) {
  return { id: 'AbCdEf123_-Z', revision, hostId: host ? browser.app.clientId : 'another-listener',
    queue: [track(id)], currentTrackId: id, members: [],
    playback: { playing, positionMs: position, updatedAt, ...(generation === undefined ? {} : { generation }) } };
}
function lobby(browser, { host = false, count = 3, ...options } = {}) {
  const state = room(browser, { host, ...options });
  state.members = [{ id: browser.app.clientId, name: 'Me', connected: true }];
  if (!host && count > 1) state.members.push({ id: state.hostId, name: 'Host', connected: true });
  while (state.members.length < count) state.members.push({ id: `friend-${state.members.length}`, name: 'Friend', connected: true });
  return state;
}

function load(browser, state) {
  browser.app.configure({ room: state });
  browser.app.loadTrack(state.queue[0]);
  const widget = browser.widgets.at(-1);
  widget.emit(EVENTS.READY);
  return widget;
}

function resolvePositions(widget, position = 10000) {
  let count = 0;
  while (widget.pendingPositions.length) {
    assert.ok(count++ < 20, 'position reconciliation must settle');
    widget.resolvePosition(position);
  }
}

function heldRoom(browser, { host = false, requester = browser.app.clientId, ready = false, revision = 2 } = {}) {
  const state = room(browser, { host, playing: false, position: 10000, revision });
  state.hold = { memberId: requester, name: 'User', wasPlaying: true, waiters: [{ memberId: requester, name: 'User', ready }] };
  return state;
}

function receive(browser, state) {
  browser.sockets[0].emit('message', { data: JSON.stringify({ type: 'state', serverTime: browser.now(), room: state }) });
}

test('a late join seeks to the server timeline using the estimated clock offset', () => {
  const b = browser();
  b.app.configure({ clockOffset: 450 });
  const state = room(b, { position: 10000, updatedAt: b.now() - 5000 });
  const widget = load(b, state);
  widget.resolvePosition(0);
  const correction = widget.calls.find((call) => call.method === 'seekTo');
  assert.equal(correction?.position, 15450);
  assert.ok(widget.calls.some((call) => call.method === 'play'));
  assert.equal(b.messages.filter((message) => message.type === 'control').length, 0);
  assert.equal(b.app.status().syncing, false);
});

test('programmatic seek and pause events do not become new host commands', () => {
  const b = browser();
  const state = room(b, { host: true, playing: false, position: 40000 });
  const widget = load(b, state);
  widget.paused = false;
  widget.resolvePosition(0);
  assert.ok(widget.calls.some((call) => call.method === 'seekTo' && call.position === 40000));
  assert.ok(widget.calls.some((call) => call.method === 'pause'));
  // Iframe messages can arrive after reconciliation releases its getter lock.
  widget.emit(EVENTS.SEEK, { currentPosition: 40000 });
  widget.emit(EVENTS.PAUSE);
  assert.equal(b.messages.filter((message) => message.type === 'control').length, 0);
});

test('switching tracks during a pending getter cannot freeze the next player', () => {
  const b = browser();
  const oldWidget = load(b, room(b, { id: 'track-a' }));
  assert.equal(b.app.status().syncing, true);
  const nextState = room(b, { id: 'track-b', position: 60000, revision: 2 });
  const nextWidget = load(b, nextState);
  assert.equal(nextWidget.pendingPositions.length, 1, 'the new player must reconcile despite the previous getter');
  oldWidget.resolvePosition(5);
  assert.equal(oldWidget.calls.filter((call) => call.method === 'seekTo').length, 0);
  nextWidget.resolvePosition(0);
  assert.ok(nextWidget.calls.some((call) => call.method === 'seekTo' && call.position === 60000));
  assert.equal(b.app.status().syncing, false);
});

test('clearing a player with an outstanding getter releases reconciliation for the next track', () => {
  const b = browser();
  const oldWidget = load(b, room(b));
  b.app.clearPlayer();
  assert.equal(b.app.status().syncing, false);
  const nextWidget = load(b, room(b, { id: 'new-track', revision: 2 }));
  assert.equal(nextWidget.pendingPositions.length, 1);
  oldWidget.resolvePosition(1);
  nextWidget.resolvePosition(0);
  assert.equal(b.app.status().syncing, false);
});

test('a host sample collected before a newer seek cannot rewind the room', () => {
  const b = browser();
  const initial = room(b, { host: true, revision: 10 });
  const widget = load(b, initial);
  widget.paused = false;
  widget.resolvePosition(10000);
  b.advance(2000);
  b.interval(5000); // Starts an asynchronous getPosition at revision 10.
  b.app.configure({ room: room(b, { host: true, revision: 11, position: 80000 }) });
  widget.resolvePosition(12000);
  const sample = b.messages.find((message) => message.type === 'position');
  assert.ok(!sample || sample.baseRevision === 10, 'drop the stale sample or preserve its old revision for server rejection');
});

test('a host sample from an old track is discarded after a track switch', () => {
  const b = browser();
  const widget = load(b, room(b, { host: true }));
  widget.paused = false;
  widget.resolvePosition(10000);
  b.advance(2000);
  b.interval(5000);
  load(b, room(b, { host: true, id: 'track-b', revision: 2 }));
  widget.resolvePosition(0);
  assert.equal(b.messages.filter((message) => message.type === 'position').length, 0);
});

test('a forced correction requested during an existing getter is retained', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, room(b, { playing: false, position: 10000 }));
  widget.resolvePosition(10000);
  b.advance(2000);
  b.app.reconcile(false);
  // A seek changes the timeline while preserving play/pause state. The real
  // socket handler must request force, rather than treating it as a queue edit.
  b.sockets[0].emit('message', { data: JSON.stringify({ type: 'state', serverTime: b.now(),
    room: room(b, { playing: false, position: 10600, revision: 2 }) }) });
  widget.resolvePosition(10000);
  assert.equal(widget.pendingPositions.length, 1, 'a newer forced correction should run after the previous getter finishes');
  widget.resolvePosition(10000);
  assert.ok(widget.calls.some((call) => call.method === 'seekTo' && call.position === 10600));
  assert.equal(b.app.status().syncing, false);
});

test('native host pause publishes immediately without waiting for a position getter', () => {
  const b = browser();
  const widget = load(b, room(b, { host: true, revision: 10 }));
  widget.paused = false;
  widget.resolvePosition(10000);
  b.advance(2000);
  widget.paused = true;
  widget.emit(EVENTS.PAUSE, { currentPosition: 12000 });
  assert.equal(widget.pendingPositions.length, 0, 'native pause must not await another iframe getter');
  const pause = b.messages.find((message) => message.type === 'control' && message.action === 'pause');
  assert.equal(pause?.positionMs, 12000);
  assert.equal(b.element('play-button')['aria-label'], 'Play shared track');
});

test('a pending widget getter cannot restart playback after the socket closes', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, room(b, { playing: true, position: 60000 }));
  widget.calls.length = 0; // READY may legitimately have started the track already.
  assert.equal(b.app.status().syncing, true);
  b.sockets[0].emit('close', { code: 1006 });
  assert.equal(b.app.status().syncing, false);
  widget.resolvePosition(0);
  assert.equal(widget.calls.filter((call) => call.method === 'play' || call.method === 'seekTo').length, 0);
  assert.equal(widget.paused, true);
});

test('a getter arriving after its timeout is invalid even before another attempt starts', () => {
  const b = browser();
  const widget = load(b, room(b, { position: 60000 }));
  widget.calls.length = 0;
  b.advance(2000);
  b.timeout(2000);
  assert.equal(b.app.status().syncing, false);
  widget.resolvePosition(0);
  assert.equal(widget.calls.filter((call) => call.method === 'play' || call.method === 'seekTo').length, 0);
});

test('guest volume is personal, persists, and never sends room controls', () => {
  const b = browser();
  const widget = load(b, room(b));
  widget.resolvePosition(10000);
  b.messages.length = 0;
  b.element('volume').value = '31';
  b.event('volume', 'input');
  assert.equal(widget.volume, 31);
  assert.equal(b.element('volume-value').textContent, '31%');
  assert.equal(b.localStorage.getItem('sc-jams:volume'), '31');
  assert.equal(b.messages.length, 0, 'changing a guest volume must not affect anyone else');
  const refreshed = browser({ saved: b.localStorage.snapshot() });
  assert.equal(refreshed.element('volume').value, 31);
});

test('mute restores the previous volume and a replacement player inherits it', () => {
  const b = browser();
  const widget = load(b, room(b));
  widget.resolvePosition(10000);
  b.messages.length = 0;
  b.element('volume').value = '42';
  b.event('volume', 'input');
  b.event('mute-button', 'click');
  assert.equal(widget.volume, 0);
  assert.equal(b.element('mute-button')['aria-pressed'], 'true');
  b.event('mute-button', 'click');
  assert.equal(widget.volume, 42);
  assert.equal(b.element('mute-button')['aria-pressed'], 'false');
  const next = load(b, room(b, { id: 'track-b', revision: 2 }));
  assert.equal(next.volume, 42, 'switching songs must not reset personal volume');
  assert.equal(b.messages.length, 0);
});

test('light and dark preference survives refresh and the switch describes its action', () => {
  const b = browser({ saved: { 'sc-jams:theme': 'dark' } });
  assert.equal(b.root['data-theme'], 'dark');
  assert.equal(b.element('theme-toggle')['aria-label'], 'Switch to light mode');
  b.event('theme-toggle', 'click');
  assert.equal(b.root['data-theme'], 'light');
  assert.equal(b.localStorage.getItem('sc-jams:theme'), 'light');
  const refreshed = browser({ saved: b.localStorage.snapshot() });
  assert.equal(refreshed.root['data-theme'], 'light');
  refreshed.event('theme-toggle', 'click');
  assert.equal(refreshed.root['data-theme'], 'dark');
  assert.equal(refreshed.element('theme-toggle')['aria-label'], 'Switch to light mode');
});

test('playlist import validates and deduplicates tracks and respects remaining queue capacity', () => {
  const b = browser();
  b.app.configure({ room: room(b) });
  b.app.previewPlaylist('https://soundcloud.com/artist/sets/a-playlist');
  const preview = b.widgets.at(-1);
  preview.emit(EVENTS.READY);
  const sound = (url, extra = {}) => ({ permalink_url: url, title: 'Example', user: { username: 'Artist' }, duration: 30000, ...extra });
  preview.resolveSounds([
    sound('https://www.soundcloud.com/artist/track-a?utm_source=share'), // Already queued.
    sound('https://www.soundcloud.com/artist/new-track?utm_source=share'),
    sound('https://soundcloud.com/artist/new-track'), // Same canonical URL.
    sound('https://soundcloud.com/artist/blocked-track', { access: 'blocked' }),
    sound('https://soundcloud.com/artist/private-track?secret_token=s-secret'),
    sound('https://example.com/artist/fake-track'),
    ...Array.from({ length: 105 }, (_, i) => sound(`https://soundcloud.com/artist/import-${i}`)),
  ]);
  assert.equal(b.app.status().playlistTracks.length, 99, 'one existing track leaves 99 spaces');
  assert.equal(b.element('import-playlist-button').disabled, false);
  b.event('import-playlist-button', 'click');
  const batch = b.messages.find((message) => message.type === 'add_many');
  assert.ok(batch, 'import must send one batch rather than one message for every song');
  assert.equal(batch.tracks.length, 99);
  assert.equal(batch.tracks[0].url, 'https://soundcloud.com/artist/new-track');
  assert.equal(new Set(batch.tracks.map((item) => item.url)).size, 99);
  assert.ok(!batch.tracks.some((item) => /track-a|blocked|private|example\.com/.test(item.url)));
  assert.equal(b.element('playlist-import').hidden, true);
});

test('playlist import becomes unavailable when the room disconnects', () => {
  const b = browser();
  b.app.connect();
  b.app.configure({ room: room(b) });
  b.app.previewPlaylist('https://soundcloud.com/artist/sets/a-playlist');
  const preview = b.widgets.at(-1);
  preview.emit(EVENTS.READY);
  preview.resolveSounds([{ permalink_url: 'https://soundcloud.com/artist/new-track', title: 'New track' }]);
  assert.equal(b.element('import-playlist-button').disabled, false);
  b.sockets[0].emit('close', { code: 1006 });
  assert.equal(b.element('import-playlist-button').disabled, true);
  assert.equal(b.messages.filter((message) => message.type === 'add_many').length, 0);
});

test('canceling a playlist ignores its late metadata callback and cannot import it', () => {
  const b = browser();
  b.app.configure({ room: room(b) });
  b.app.previewPlaylist('https://soundcloud.com/artist/sets/a-playlist');
  const preview = b.widgets.at(-1);
  preview.emit(EVENTS.READY);
  b.event('cancel-playlist-button', 'click');
  preview.resolveSounds([{ permalink_url: 'https://soundcloud.com/artist/new-track', title: 'Late track' }]);
  b.event('import-playlist-button', 'click');
  assert.equal(b.app.status().playlistTracks.length, 0);
  assert.equal(b.messages.filter((message) => message.type === 'add_many').length, 0);
  assert.equal(b.element('playlist-import').hidden, true);
});

test('Wait for me pauses the requester immediately and stale getters cannot restart it before acknowledgment', () => {
  const b = browser({ asyncEvents: true });
  b.app.connect();
  const widget = load(b, room(b, { host: true }));
  widget.paused = false;
  resolvePositions(widget);
  b.flushWidgetEvents();
  widget.calls.length = 0;
  b.messages.length = 0;
  b.app.reconcile(); // This asynchronous getter belongs to the old playing state.
  assert.equal(widget.pendingPositions.length, 1);
  b.event('wait-button', 'click');
  assert.equal(b.app.status().waitingLocally, true);
  assert.equal(b.messages.at(-1).type, 'hold');
  assert.equal(widget.paused, true, 'Wait must pause local music before the server responds');
  widget.resolvePosition(10000);
  b.advance(2500);
  b.interval(2500);
  resolvePositions(widget);
  b.flushWidgetEvents();
  assert.equal(widget.paused, true, 'optimistic waiting must survive periodic sync before hold acknowledgment');
  assert.equal(widget.calls.filter((call) => call.method === 'play').length, 0);
  assert.equal(b.messages.filter((message) => message.type === 'control' && message.action === 'play').length, 0);
});

test('a hold from another listener pauses audio before outstanding widget getters return', () => {
  const b = browser({ asyncEvents: true });
  b.app.connect();
  const widget = load(b, room(b));
  resolvePositions(widget);
  b.flushWidgetEvents();
  widget.calls.length = 0;
  b.app.reconcile();
  assert.equal(widget.pendingPositions.length, 1);
  receive(b, heldRoom(b, { requester: 'a-friend' }));
  assert.equal(widget.paused, true);
  assert.ok(widget.calls.some((call) => call.method === 'pause'));
  resolvePositions(widget);
  b.flushWidgetEvents();
  assert.equal(widget.paused, true);
  assert.equal(widget.calls.filter((call) => call.method === 'play').length, 0);
});

test('ad playback is local and explicit; readiness pauses it until the host resumes', () => {
  const b = browser({ asyncEvents: true });
  b.app.connect();
  const widget = load(b, room(b));
  resolvePositions(widget);
  b.flushWidgetEvents();
  b.messages.length = 0;
  b.event('wait-button', 'click');
  receive(b, heldRoom(b));
  resolvePositions(widget);
  b.flushWidgetEvents();
  assert.equal(widget.paused, true);
  assert.equal(b.element('local-ad-button').hidden, false);
  b.event('local-ad-button', 'click');
  assert.equal(widget.paused, false, 'only the explicit local ad action can play during the wait');
  widget.calls.length = 0;
  b.interval(2500);
  resolvePositions(widget);
  b.flushWidgetEvents();
  assert.equal(widget.calls.filter((call) => call.method === 'pause' || call.method === 'seekTo').length, 0);
  b.event('wait-button', 'click');
  assert.equal(b.messages.at(-1).type, 'hold_ready');
  assert.equal(widget.paused, true, 'marking ready must stop local ad playback');
  receive(b, heldRoom(b, { ready: true, revision: 3 }));
  resolvePositions(widget);
  b.flushWidgetEvents();
  assert.equal(widget.paused, true, 'personal readiness cannot start the shared track');
  const resumed = room(b, { playing: true, position: 10000, revision: 3 });
  resumed.hold = null;
  resumed.revision = 4;
  receive(b, resumed);
  resolvePositions(widget);
  b.flushWidgetEvents();
  assert.equal(widget.paused, false, 'host resume starts the ready listener');
  assert.equal(b.messages.filter((message) => message.type === 'control').length, 0);
});

test('the host cannot resume from site controls while a listener is not ready', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, room(b, { host: true }));
  resolvePositions(widget);
  receive(b, heldRoom(b, { host: true, requester: 'a-friend' }));
  resolvePositions(widget);
  assert.equal(widget.paused, true);
  assert.equal(b.element('play-button').disabled, true);
  b.messages.length = 0;
  b.event('play-button', 'click');
  assert.equal(b.messages.filter((message) => message.action === 'play').length, 0);
  receive(b, heldRoom(b, { host: true, requester: 'a-friend', ready: true, revision: 3 }));
  resolvePositions(widget);
  assert.equal(b.element('play-button').disabled, false);
  b.event('play-button', 'click');
  assert.equal(b.messages.filter((message) => message.action === 'play').length, 1);
});

test('natural finish advances once and the next track starts at READY without waiting for a getter', () => {
  const b = browser({ asyncEvents: true });
  b.app.connect();
  const state = room(b, { host: true });
  state.queue.push(track('track-b'));
  const widget = load(b, state);
  resolvePositions(widget);
  b.flushWidgetEvents();
  b.messages.length = 0;
  widget.emit(EVENTS.FINISH);
  widget.emit(EVENTS.FINISH);
  widget.paused = true;
  widget.emit(EVENTS.PAUSE, { currentPosition: 240000 });
  const finishes = b.messages.filter((message) => message.action === 'finish');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].trackId, 'track-a');
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 0, 'a final pause event must not stop the next song');
  const next = room(b, { host: true, id: 'track-b', playing: true, position: 0, revision: 2 });
  receive(b, next);
  const nextWidget = b.widgets.at(-1);
  assert.notEqual(nextWidget, widget);
  nextWidget.emit(EVENTS.READY);
  assert.equal(nextWidget.paused, false, 'the next track starts before its delayed position getter resolves');
  assert.ok(nextWidget.calls.some((call) => call.method === 'play'));
  assert.equal(nextWidget.pendingPositions.length, 1);
  widget.emit(EVENTS.FINISH);
  assert.equal(b.messages.filter((message) => message.action === 'finish').length, 1);
});

test('an empty authoritative queue clears the player and does not restart removed audio', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, room(b, { host: true }));
  resolvePositions(widget);
  b.messages.length = 0;
  widget.emit(EVENTS.FINISH);
  const ended = room(b, { host: true, playing: false, position: 0, revision: 2 });
  ended.queue = [];
  ended.currentTrackId = null;
  receive(b, ended);
  assert.equal(b.app.status().loadedTrackId, null);
  assert.equal(b.element('empty-player').hidden, false);
  assert.equal(b.element('active-player').hidden, true);
  assert.equal(b.element('play-button').disabled, true);
  widget.emit(EVENTS.FINISH);
  assert.equal(b.messages.filter((message) => message.action === 'finish').length, 1);
});

test('an end-of-track PAUSE followed by FINISH advances without pausing the next song', () => {
  const b = browser({ asyncEvents: true });
  b.app.connect();
  const initial = room(b, { host: true, position: 239900 });
  initial.queue.push(track('track-b'));
  const widget = load(b, initial);
  resolvePositions(widget, 239900);
  b.flushWidgetEvents();
  b.messages.length = 0;
  widget.paused = true;
  widget.emit(EVENTS.PAUSE, { currentPosition: 240000 });
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 0);
  widget.emit(EVENTS.FINISH);
  assert.equal(b.messages.filter((message) => message.action === 'finish').length, 1);
  receive(b, room(b, { host: true, id: 'track-b', playing: true, position: 0, revision: 2 }));
  const next = b.widgets.at(-1);
  next.emit(EVENTS.READY);
  assert.equal(next.paused, false);
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 0);
});

test('a deliberate native pause near the end still pauses when no FINISH follows', () => {
  const b = browser();
  const widget = load(b, room(b, { host: true, position: 239900 }));
  resolvePositions(widget, 239900);
  b.messages.length = 0;
  widget.paused = true;
  widget.emit(EVENTS.PAUSE, { currentPosition: 239950 });
  b.interval(2500);
  assert.equal(widget.pendingPositions.length, 0, 'sync cannot restart the track while its end-state is being resolved');
  b.timeout(180);
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 1);
  assert.equal(b.app.status().pendingIntent.playing, false);
});

test('a late finish event cannot advance a host who just paused or asked the room to wait', () => {
  for (const action of ['play-button', 'wait-button']) {
    const b = browser({ asyncEvents: true });
    const widget = load(b, room(b, { host: true }));
    resolvePositions(widget);
    b.flushWidgetEvents();
    b.messages.length = 0;
    b.event(action, 'click');
    widget.emit(EVENTS.FINISH);
    assert.equal(b.messages.filter((message) => message.action === 'finish').length, 0, `late finish after ${action} must not consume the current track`);
  }
});

test('blank create and join names become User instead of an identity fragment', async () => {
  const created = browser({ responses: { '/api/rooms': { body: { roomId: 'newRoom123456' } } } });
  created.element('create-name').value = '   ';
  await created.event('create-form', 'submit');
  created.sockets[0].emit('open');
  assert.equal(created.messages.find((message) => message.type === 'join').name, 'User');
  const joined = browser({ responses: { '/api/rooms/joinRoom1234': { body: {} } } });
  joined.element('room-link').value = 'http://localhost:3000/room/joinRoom1234';
  joined.event('join-code-form', 'submit');
  joined.element('join-name').value = '';
  await joined.event('join-form', 'submit');
  joined.sockets[0].emit('open');
  assert.equal(joined.messages.find((message) => message.type === 'join').name, 'User');
});

test('a previously generated Listener name is no longer shown as a chosen nickname', () => {
  const b = browser({ saved: { 'sc-jams:name': 'Listener 52e5' } });
  assert.equal(b.element('create-name').value, '');
  assert.equal(b.element('join-name').value, '');
});

test('a rejected wait request restores the room controls instead of leaving them stuck', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, room(b, { host: true }));
  widget.resolvePosition(10000);
  b.event('wait-button', 'click');
  assert.equal(b.element('play-button').disabled, true);
  b.sockets[0].emit('message', { data: JSON.stringify({ type: 'error', code: 'rejected_hold', message: 'Try again.' }) });
  assert.equal(b.element('play-button').disabled, false);
  assert.equal(b.element('wait-button').disabled, false);
});

test('site pause stops the widget immediately and invalidates an older sync getter', () => {
  const b = browser({ asyncEvents: true });
  const widget = load(b, room(b, { host: true }));
  widget.paused = false;
  widget.resolvePosition(10000);
  widget.calls.length = 0;
  b.app.reconcile();
  assert.equal(widget.pendingPositions.length, 1);
  b.messages.length = 0;
  b.event('play-button', 'click');
  assert.equal(widget.paused, true, 'the pause button must stop local audio before the server round trip');
  assert.equal(b.element('play-button')['aria-label'], 'Play shared track');
  widget.resolvePosition(5000); // Old getter must not restart playback.
  b.flushWidgetEvents();
  assert.equal(widget.calls.filter((call) => call.method === 'play').length, 0);
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 1);
  assert.equal(b.messages.filter((message) => message.action === 'play').length, 0);
});

test('a real embed pause immediately after programmatic play is not swallowed', () => {
  const b = browser({ asyncEvents: true });
  const widget = load(b, room(b, { host: true }));
  widget.resolvePosition(0); // Issues seek and play; their echoes are still queued.
  assert.equal(widget.paused, false);
  b.messages.length = 0;
  widget.paused = true;
  widget.emit(EVENTS.PAUSE, { currentPosition: 10300 });
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 1);
  assert.equal(b.app.status().pendingIntent.playing, false);
  b.flushWidgetEvents(); // Delayed old PLAY must not overturn the user's pause.
  assert.equal(b.messages.filter((message) => message.action === 'play').length, 0);
  b.app.reconcile();
  widget.resolvePosition(10300);
  assert.equal(widget.paused, true);
  assert.equal(b.element('play-button')['aria-label'], 'Play shared track');
});

test('rapid site play then pause keeps the latest intent through out-of-order acknowledgments', () => {
  const b = browser({ asyncEvents: true });
  b.app.connect();
  const widget = load(b, room(b, { host: true, playing: false }));
  widget.resolvePosition(10000);
  b.messages.length = 0;
  b.event('play-button', 'click');
  b.event('play-button', 'click');
  assert.deepEqual(b.messages.filter((message) => message.type === 'control').map((message) => message.action), ['play', 'pause']);
  assert.equal(widget.paused, true);
  b.sockets[0].emit('message', { data: JSON.stringify({ type: 'state', serverTime: b.now(), room: room(b, { host: true, playing: true, revision: 2 }) }) });
  widget.resolvePosition(10000);
  assert.equal(widget.paused, true, 'an older play acknowledgment cannot restart the paused widget');
  assert.equal(b.app.status().pendingIntent.playing, false);
  b.sockets[0].emit('message', { data: JSON.stringify({ type: 'state', serverTime: b.now(), room: room(b, { host: true, playing: false, revision: 3 }) }) });
  widget.resolvePosition(10000);
  b.flushWidgetEvents();
  assert.equal(b.app.status().pendingIntent, null);
  assert.equal(b.app.status().syncing, false);
  assert.equal(widget.paused, true);
});

test('native embed play updates the site immediately and old pause echoes stay local', () => {
  const b = browser({ asyncEvents: true });
  const widget = load(b, room(b, { host: true, playing: false }));
  widget.paused = false;
  widget.resolvePosition(10000); // Server state requests pause, echo pending.
  assert.equal(widget.paused, true);
  b.messages.length = 0;
  widget.paused = false;
  widget.emit(EVENTS.PLAY, { currentPosition: 10000 });
  assert.equal(b.messages.filter((message) => message.action === 'play').length, 1);
  assert.equal(b.element('play-button')['aria-label'], 'Pause shared track');
  b.flushWidgetEvents();
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 0);
});

test('shared playback controls wait for widget READY and unavailable widgets remain disabled', () => {
  const b = browser();
  const state = room(b, { host: true });
  b.app.configure({ room: state });
  b.app.loadTrack(state.queue[0]);
  assert.equal(b.element('play-button').disabled, true);
  b.event('play-button', 'click');
  assert.equal(b.messages.filter((message) => message.type === 'control').length, 0);
  const widget = b.widgets.at(-1);
  widget.emit(EVENTS.READY);
  widget.resolvePosition(10000);
  assert.equal(b.element('play-button').disabled, false);
  widget.emit(EVENTS.ERROR);
  assert.equal(b.element('play-button').disabled, true);
  assert.equal(b.element('resync-button').disabled, true);
});

test('create, invite copy and leave execute their visible actions', async () => {
  const b = browser({ responses: { '/api/rooms': { body: { roomId: 'newRoom123456' } } } });
  b.element('create-name').value = 'Alex';
  await b.event('create-form', 'submit');
  assert.equal(b.requests.find((request) => request.url === '/api/rooms').options.method, 'POST');
  b.sockets[0].emit('open');
  const join = b.messages.find((message) => message.type === 'join');
  assert.equal(join.roomId, 'newRoom123456');
  assert.equal(join.name, 'Alex');
  await b.event('invite-button', 'click');
  assert.equal(b.clipboard[0], 'http://localhost:3000/room/newRoom123456');
  b.event('leave-room', 'click');
  assert.equal(b.sockets[0].readyState, 3);
  assert.equal(b.element('landing').hidden, false);
  assert.equal(b.element('room-view').hidden, true);
});

test('join link, back, queue add, select, remove, skip and seek have functional handlers', async () => {
  const b = browser({ responses: { '/api/rooms/joinRoom1234': { body: { roomId: 'joinRoom1234' } } } });
  b.element('join-code-form').hidden = true;
  b.event('show-join', 'click');
  assert.equal(b.element('join-code-form').hidden, false);
  b.element('room-link').value = 'http://localhost:3000/room/joinRoom1234';
  b.event('join-code-form', 'submit');
  assert.equal(b.element('join-overlay').hidden, false);
  await b.event('join-form', 'submit');
  b.sockets[0].emit('open');
  assert.equal(b.messages.find((message) => message.type === 'join').roomId, 'joinRoom1234');
  const state = room(b, { host: true, playing: false });
  state.queue.push(track('track-b'));
  b.sockets[0].emit('message', { data: JSON.stringify({ type: 'state', serverTime: b.now(), room: state }) });
  const widget = b.widgets.at(-1);
  widget.emit(EVENTS.READY);
  widget.resolvePosition(10000);
  b.element('track-url').value = 'https://soundcloud.com/artist/next-track';
  b.event('add-form', 'submit');
  assert.equal(b.messages.find((message) => message.type === 'add').url, 'https://soundcloud.com/artist/next-track');
  b.element('seek').value = '500';
  b.event('seek', 'change');
  assert.equal(b.messages.find((message) => message.action === 'seek').positionMs, 120000);
  const secondQueueItem = b.element('queue').children[1];
  secondQueueItem.children[0].listeners.get('click')();
  secondQueueItem.children[1].listeners.get('click')();
  assert.ok(b.messages.some((message) => message.action === 'select' && message.trackId === 'track-b'));
  assert.ok(b.messages.some((message) => message.action === 'remove' && message.trackId === 'track-b'));
  b.event('skip-button', 'click');
  assert.ok(b.messages.some((message) => message.action === 'skip'));
  b.event('join-back', 'click');
  assert.equal(b.element('landing').hidden, false);
});

test('a missing programmatic pause echo cannot swallow a later native play then pause', () => {
  const b = browser({ asyncEvents: true });
  const widget = load(b, room(b, { host: true, playing: false }));
  widget.paused = false;
  widget.resolvePosition(10000); // Pause issued; deliberately lose its echo.
  b.discardWidgetEvents();
  b.messages.length = 0;
  widget.paused = false;
  widget.emit(EVENTS.PLAY, { currentPosition: 10000 });
  widget.deferPaused = true;
  widget.paused = true;
  widget.emit(EVENTS.PAUSE, { currentPosition: 10100 });
  b.interval(2500);
  assert.equal(widget.pendingPositions.length, 0, 'reconciliation waits for the ambiguous native event confirmation');
  widget.resolvePaused(true);
  assert.deepEqual(b.messages.filter((message) => message.type === 'control').map((message) => message.action), ['play', 'pause']);
  assert.equal(b.app.status().pendingIntent.playing, false);
  assert.equal(b.element('play-button')['aria-label'], 'Play shared track');
});

test('server acknowledgment during an intent getter cannot leave the sync lock stuck', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, room(b, { host: true, playing: false }));
  widget.resolvePosition(10000);
  b.event('play-button', 'click');
  b.app.reconcile();
  assert.equal(widget.pendingPositions.length, 1);
  b.sockets[0].emit('message', { data: JSON.stringify({ type: 'state', serverTime: b.now(), room: room(b, { host: true, playing: true, revision: 2 }) }) });
  assert.equal(b.app.status().pendingIntent, null);
  assert.equal(widget.pendingPositions.length, 2, 'acknowledgment starts a fresh reconciliation');
  widget.resolvePosition(10000); // Invalidated intent getter.
  widget.resolvePosition(10000); // New authoritative getter.
  assert.equal(b.app.status().syncing, false);
  b.app.reconcile();
  assert.equal(widget.pendingPositions.length, 1, 'future reconciliations are not locked out');
  widget.resolvePosition(10000);
  assert.equal(b.app.status().syncing, false);
});

test('a guest can pause and the authoritative server position acknowledgment cannot restart it', () => {
  const b = browser({ asyncEvents: true });
  b.app.connect();
  const widget = load(b, lobby(b, { generation: 1 }));
  resolvePositions(widget);
  b.flushWidgetEvents();
  b.messages.length = 0;
  assert.equal(b.element('play-button').disabled, false);
  b.app.reconcile();
  b.event('play-button', 'click');
  assert.equal(widget.paused, true);
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 1);
  receive(b, lobby(b, { playing: false, position: 18000, revision: 2, generation: 1 }));
  resolvePositions(widget, 18000);
  b.flushWidgetEvents();
  assert.equal(b.app.status().pendingIntent, null);
  assert.equal(widget.paused, true);
  assert.equal(b.element('play-button').disabled, true);
  assert.equal(b.element('play-button')['aria-label'], 'Waiting for host to resume');
  b.event('play-button', 'click');
  assert.equal(b.messages.filter((message) => message.action === 'play').length, 0);
});

test('native guest pause publishes, while natural completion cannot pause the next track', () => {
  const b = browser({ asyncEvents: true });
  const widget = load(b, lobby(b));
  resolvePositions(widget);
  b.flushWidgetEvents();
  b.messages.length = 0;
  widget.paused = true;
  widget.emit(EVENTS.PAUSE, { currentPosition: 12000 });
  b.flushWidgetEvents();
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 1);
  const ended = browser({ asyncEvents: true });
  const endedWidget = load(ended, lobby(ended, { position: 239900 }));
  resolvePositions(endedWidget, 239900);
  ended.flushWidgetEvents();
  ended.messages.length = 0;
  endedWidget.paused = true;
  endedWidget.emit(EVENTS.PAUSE, { currentPosition: 240000 });
  endedWidget.emit(EVENTS.FINISH);
  assert.equal(ended.messages.filter((message) => message.type === 'control').length, 0);
});

test('skip voting shows counts and own vote state, and the host can vote separately', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, lobby(b));
  resolvePositions(widget);
  b.messages.length = 0;
  assert.equal(b.element('skip-button')['aria-label'], 'Vote to skip track');
  b.event('skip-button', 'click');
  assert.equal(b.messages.at(-1).action, 'skip');
  assert.equal(widget.paused, false);
  const voted = lobby(b, { revision: 2 });
  voted.skipVote = { trackId: 'track-a', voterIds: [b.app.clientId], required: 2, eligibleCount: 3 };
  receive(b, voted);
  assert.equal(b.element('skip-vote-panel').hidden, false);
  assert.equal(b.element('skip-vote-status').textContent, '1 / 2');
  assert.equal(b.element('skip-button').disabled, true);
  assert.equal(b.element('vote-skip-button').disabled, true);
  b.event('skip-button', 'click');
  assert.equal(b.messages.filter((message) => message.action === 'skip').length, 1);
  const host = browser();
  host.app.connect();
  const hostWidget = load(host, lobby(host, { host: true }));
  resolvePositions(hostWidget);
  const pending = lobby(host, { host: true, revision: 2 });
  pending.skipVote = { trackId: 'track-a', voterIds: ['friend-1'], required: 2, eligibleCount: 3 };
  receive(host, pending);
  resolvePositions(hostWidget);
  host.messages.length = 0;
  host.event('vote-skip-button', 'click');
  assert.equal(host.messages.at(-1).action, 'vote_skip');
  assert.equal(host.element('skip-button').disabled, false);
});

test('two-person guests can skip directly and a new song clears the vote display', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, lobby(b, { count: 2 }));
  resolvePositions(widget);
  b.messages.length = 0;
  assert.equal(b.element('skip-button')['aria-label'], 'Skip track');
  assert.equal(b.element('skip-button').disabled, false);
  b.event('skip-button', 'click');
  assert.equal(b.messages.at(-1).action, 'skip');
  receive(b, lobby(b, { count: 2, id: 'track-b', revision: 2 }));
  assert.equal(b.element('skip-vote-panel').hidden, true);
});

test('pause cooldown leaves other controls available and a solo host is exempt', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, lobby(b, { host: true }));
  resolvePositions(widget);
  b.sockets[0].emit('message', { data: JSON.stringify({ type: 'error', code: 'pause_rate_limited', message: 'Please wait.', retryAfterMs: 10000 }) });
  assert.equal(b.element('play-button').disabled, true);
  assert.equal(b.element('skip-button').disabled, false);
  assert.equal(b.element('volume').disabled, false);
  receive(b, lobby(b, { host: true, count: 1, revision: 2 }));
  resolvePositions(widget);
  assert.equal(b.element('play-button').disabled, false);
  b.messages.length = 0;
  b.event('play-button', 'click');
  assert.equal(b.messages.filter((message) => message.action === 'pause').length, 1);
});

test('repeat and shuffle are host-only controls with authoritative room actions', () => {
  const b = browser();
  b.app.connect();
  const state = lobby(b, { host: true });
  state.queue.push(track('track-b'), track('track-c'));
  const widget = load(b, state);
  resolvePositions(widget);
  assert.equal(b.element('repeat-button').hidden, false);
  assert.equal(b.element('shuffle-button').hidden, false);
  b.messages.length = 0;
  b.event('repeat-button', 'click');
  assert.equal(b.messages.at(-1).mode, 'track');
  receive(b, { ...state, revision: 2, repeatMode: 'track' });
  resolvePositions(widget);
  assert.equal(b.element('repeat-button')['aria-pressed'], 'true');
  b.event('repeat-button', 'click');
  assert.equal(b.messages.at(-1).mode, 'queue');
  b.event('shuffle-button', 'click');
  assert.equal(b.messages.at(-1).action, 'shuffle');
  const guest = browser();
  const guestWidget = load(guest, lobby(guest));
  resolvePositions(guestWidget);
  assert.equal(guest.element('repeat-button').hidden, true);
  assert.equal(guest.element('shuffle-button').hidden, true);
  guest.messages.length = 0;
  guest.event('repeat-button', 'click');
  guest.event('shuffle-button', 'click');
  assert.equal(guest.messages.filter((message) => message.type === 'control').length, 0);
});

test('same-track generations restart a looping song and reject old completion callbacks', () => {
  const b = browser({ asyncEvents: true });
  b.app.connect();
  const first = load(b, lobby(b, { host: true, generation: 10 }));
  resolvePositions(first);
  b.flushWidgetEvents();
  b.messages.length = 0;
  first.emit(EVENTS.FINISH);
  first.emit(EVENTS.FINISH);
  assert.equal(b.messages.filter((message) => message.action === 'finish').length, 1);
  assert.equal(b.messages.find((message) => message.action === 'finish').generation, 10);
  receive(b, lobby(b, { host: true, position: 0, revision: 2, generation: 11 }));
  const restarted = b.widgets.at(-1);
  assert.notEqual(restarted, first);
  restarted.emit(EVENTS.READY);
  assert.equal(restarted.paused, false);
  first.emit(EVENTS.FINISH);
  assert.equal(b.messages.filter((message) => message.action === 'finish').length, 1);
  resolvePositions(restarted, 0);
  b.flushWidgetEvents();
  restarted.emit(EVENTS.FINISH);
  restarted.emit(EVENTS.FINISH);
  assert.equal(b.messages.filter((message) => message.action === 'finish').length, 2);
  assert.equal(b.messages.filter((message) => message.action === 'finish').at(-1).generation, 11);
});
