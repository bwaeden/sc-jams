import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const EVENTS = Object.fromEntries(['READY', 'PLAY_PROGRESS', 'PLAY', 'PAUSE', 'SEEK', 'FINISH', 'ERROR'].map((event) => [event, event]));

// This deliberately leaves widget getters pending. SoundCloud's iframe API is
// asynchronous, so track changes and server updates can arrive before a getter.
function browser() {
  let timestamp = 1_800_000_000_000, monotonic = 10_000, timerId = 0;
  const intervals = [], timeouts = new Map(), elements = new Map(), widgets = [], sockets = [], messages = [];
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
  const storage = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  };
  function Widget(iframe) {
    const callbacks = new Map();
    const instance = {
      iframe, callbacks, pendingPositions: [], calls: [], paused: true,
      bind(event, callback) { callbacks.set(event, callback); },
      emit(event, payload = {}) { callbacks.get(event)?.(payload); },
      getPosition(callback) { this.pendingPositions.push(callback); },
      resolvePosition(position) {
        const callback = this.pendingPositions.shift();
        assert.ok(callback, 'the client must have requested the widget position');
        callback(position);
      },
      isPaused(callback) { callback(this.paused); },
      getDuration(callback) { callback(240000); },
      getCurrentSound(callback) { callback({ title: 'Test track', user: { username: 'Test artist' }, duration: 240000 }); },
      seekTo(position) { this.calls.push({ method: 'seekTo', position }); this.emit(EVENTS.SEEK, { currentPosition: position }); },
      play() { this.calls.push({ method: 'play' }); this.paused = false; this.emit(EVENTS.PLAY); },
      pause() { this.calls.push({ method: 'pause' }); this.paused = true; this.emit(EVENTS.PAUSE); },
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
      activeElement: null, hidden: false,
    },
    localStorage: storage(), sessionStorage: storage(),
    location: { protocol: 'http:', origin: 'http://localhost:3000', host: 'localhost:3000', pathname: '/' },
    history: { replaceState() {} },
    navigator: {},
    window: { SC: { Widget }, addEventListener() {} },
    WebSocket: Socket,
    setTimeout(callback, ms) { const id = ++timerId; timeouts.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback, ms) { const id = ++timerId; intervals.push({ id, callback, ms }); return id; },
    clearInterval() {},
  });
  vm.runInContext(source + `
    globalThis.__appTest = {
      clientId, connect, loadTrack, clearPlayer, reconcile, targetPosition,
      configure(next) {
        if ('room' in next) room = next.room;
        if ('connected' in next) connected = next.connected;
        if ('audioEnabled' in next) audioEnabled = next.audioEnabled;
        if ('clockOffset' in next) clockOffset = next.clockOffset;
        if ('socket' in next) socket = next.socket;
      },
      status() { return { syncing, loadedTrackId, loadGeneration, playerReady, ignoreEventsUntil }; }
    };
  `, context, { filename: 'app.js' });
  const app = context.__appTest;
  app.configure({ connected: true, audioEnabled: true,
    socket: { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)) } });
  return {
    app, widgets, sockets, messages, element,
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

function room(browser, { host = false, id = 'track-a', playing = true, position = 10000, updatedAt = browser.now(), revision = 1 } = {}) {
  return { id: 'AbCdEf123_-Z', revision, hostId: host ? browser.app.clientId : 'another-listener',
    queue: [track(id)], currentTrackId: id, members: [],
    playback: { playing, positionMs: position, updatedAt } };
}

function load(browser, state) {
  browser.app.configure({ room: state });
  browser.app.loadTrack(state.queue[0]);
  const widget = browser.widgets.at(-1);
  widget.emit(EVENTS.READY);
  return widget;
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

test('a delayed native pause sample cannot pause a newer host timeline', () => {
  const b = browser();
  const widget = load(b, room(b, { host: true, revision: 10 }));
  widget.paused = false;
  widget.resolvePosition(10000);
  b.advance(2000);
  widget.emit(EVENTS.PAUSE);
  assert.equal(widget.pendingPositions.length, 1);
  b.app.configure({ room: room(b, { host: true, revision: 11, position: 80000 }) });
  b.advance(2000);
  widget.resolvePosition(12000);
  assert.equal(b.messages.filter((message) => message.type === 'control' && message.action === 'pause').length, 0);
});

test('a pending widget getter cannot restart playback after the socket closes', () => {
  const b = browser();
  b.app.connect();
  const widget = load(b, room(b, { playing: true, position: 60000 }));
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
  b.advance(2000);
  b.timeout(2000);
  assert.equal(b.app.status().syncing, false);
  widget.resolvePosition(0);
  assert.equal(widget.calls.filter((call) => call.method === 'play' || call.method === 'seekTo').length, 0);
});
