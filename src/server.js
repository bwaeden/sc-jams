import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createRoomStore, RoomError } from './rooms.js';
import { createSoundCloudMetadataResolver } from './soundcloud-metadata.js';

const PUBLIC_DIRECTORY = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://w.soundcloud.com; frame-src https://w.soundcloud.com; img-src 'self' data: https://*.sndcdn.com; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), autoplay=(self "https://w.soundcloud.com")',
};

export function createJamServer({
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '127.0.0.1',
  now = Date.now,
  roomIdleMs = 30 * 60 * 1000,
  cleanupIntervalMs = 30_000,
  maxRooms = 1000,
  random = Math.random,
  publicOrigin = process.env.PUBLIC_ORIGIN,
  lookupTrackMetadata = null,
} = {}) {
  const creationLimits = new Map();
  let closing = false;
  let publicRoot;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const metadataRequested = new WeakSet();
  const metadataBatches = new Map();

  function clearMetadataBatch(room) {
    clearTimeout(metadataBatches.get(room.id)?.timer);
    metadataBatches.delete(room.id);
  }

  function queueTrackMetadata(room) {
    if (closing || typeof lookupTrackMetadata !== 'function') return;
    for (const track of room.queue) {
      if (metadataRequested.has(track) || new URL(track.url).hostname !== 'api.soundcloud.com') continue;
      metadataRequested.add(track);
      const url = track.url;
      Promise.resolve().then(() => lookupTrackMetadata(url)).then((details) => {
        if (closing || !details || store.rooms.get(room.id) !== room || !room.queue.includes(track) || track.url !== url) return;
        let batch = metadataBatches.get(room.id);
        if (!batch) {
          batch = { updates: new Map(), timer: null };
          metadataBatches.set(room.id, batch);
          batch.timer = setTimeout(() => {
            metadataBatches.delete(room.id);
            if (!closing) store.hydrateTracks(room, [...batch.updates.values()]);
          }, 250);
          batch.timer.unref?.();
        }
        batch.updates.set(track.id, { trackId: track.id, url, metadata: details });
      }).catch(() => { /* Titles can still arrive from the playback widget. */ });
    }
  }

  function send(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024) { socket.close(4008, 'Connection too slow'); return; }
    socket.send(JSON.stringify(message));
  }

  const store = createRoomStore({ now, roomIdleMs, maxRooms, random, onClose: (room) => {
    clearMetadataBatch(room);
    for (const member of room.members.values()) {
      send(member.socket, { type: 'room_closed', reason: 'inactive', message: 'This room closed after 30 minutes without playback.' });
      member.socket.close(4004, 'Room inactive');
    }
  }, onChange: (room) => {
    const message = { type: 'state', serverTime: now(), room: store.snapshot(room) };
    for (const member of room.members.values()) if (member.connected) send(member.socket, message);
    queueTrackMetadata(room);
  } });

  function allowedOrigin(request) {
    if (!request.headers.origin) return true; // Non-browser clients and tests.
    try {
      const origin = new URL(request.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol)) return false;
      if (publicOrigin) return origin.origin === new URL(publicOrigin).origin;
      return origin.host === request.headers.host;
    } catch { return false; }
  }

  function json(response, status, data) {
    response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health' || url.pathname === '/api/health') {
        if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' });
        return json(response, 200, { ok: true });
      }
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        request.resume();
        if (!allowedOrigin(request)) return json(response, 403, { error: 'Create a room from this website.' });
        const ip = request.socket.remoteAddress || 'unknown';
        const timestamp = now();
        let limit = creationLimits.get(ip);
        if (!limit || timestamp - limit.since > 60_000) { limit = { since: timestamp, count: 0 }; creationLimits.set(ip, limit); }
        if (++limit.count > 10) return json(response, 429, { error: 'Too many new rooms. Wait a minute and try again.' });
        const room = store.create();
        return json(response, 201, { roomId: room.id });
      }
      const roomRoute = /^\/api\/rooms\/([a-zA-Z0-9_-]{12})$/.exec(url.pathname);
      if (roomRoute && request.method === 'GET') {
        try { const room = store.get(roomRoute[1]); return json(response, 200, { roomId: room.id }); }
        catch { return json(response, 404, { error: 'This room has expired. Start a new jam.' }); }
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found.' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed.' });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return json(response, 400, { error: 'Invalid path.' }); }
      const isRoomPage = /^\/(?:room|r)\/[a-zA-Z0-9_-]{12}\/?$/.test(pathname);
      const relative = pathname === '/' || isRoomPage ? 'index.html' : pathname.replace(/^\/+/, '');
      if (relative.includes('\0') || relative.split(/[\\/]/).some((part) => part.startsWith('.'))) return json(response, 404, { error: 'Not found.' });
      const candidate = path.resolve(PUBLIC_DIRECTORY, relative);
      if (!candidate.startsWith(PUBLIC_DIRECTORY + path.sep) && candidate !== PUBLIC_DIRECTORY) return json(response, 404, { error: 'Not found.' });
      const actual = await realpath(candidate);
      publicRoot ??= await realpath(PUBLIC_DIRECTORY);
      if (!actual.startsWith(publicRoot + path.sep)) return json(response, 404, { error: 'Not found.' });
      const data = await readFile(actual);
      response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME_TYPES[path.extname(actual)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (error instanceof RoomError) return json(response, 503, { error: error.message });
      if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return json(response, 404, { error: 'Not found.' });
      console.error('Request failed:', error.message);
      json(response, 500, { error: 'The server could not complete this request.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (closing || pathname !== '/ws' || !allowedOrigin(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request));
  });

  wss.on('connection', (socket) => {
    let session = null;
    let rateWindow = now();
    let count = 0;
    let lastPosition = -Infinity;
    socket.isAlive = true;
    const joinTimeout = setTimeout(() => { if (!session) socket.close(4000, 'Join a room first'); }, 10_000);
    joinTimeout.unref?.();
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('error', () => {});
    socket.on('message', (data, isBinary) => {
      try {
        if (now() - rateWindow > 10_000) { rateWindow = now(); count = 0; }
        if (++count > 120) { socket.close(4008, 'Too many room messages'); return; }
        if (isBinary) throw new RoomError('invalid_message', 'Room messages must be JSON text.');
        let message;
        try { message = JSON.parse(data.toString()); } catch { throw new RoomError('invalid_json', 'Room messages must be valid JSON.'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new RoomError('invalid_message', 'Send a valid room message.');
        if (message.type === 'ping') {
          send(socket, { type: 'pong', sentAt: typeof message.sentAt === 'number' && Number.isFinite(message.sentAt) ? message.sentAt : null, serverTime: now() });
          return;
        }
        if (message.type === 'join') {
          if (session) throw new RoomError('already_joined', 'You have already joined this room.');
          session = store.join(message.roomId, message, socket);
          clearTimeout(joinTimeout);
          return;
        }
        if (!session) throw new RoomError('not_joined', 'Join a room before sending controls.');
        if (session.member.socket !== socket || !session.member.connected) { socket.close(4001, 'Session replaced'); return; }
        if (message.type === 'position') {
          // Host sends samples every few seconds. Bound both work and broadcasts.
          if (now() - lastPosition < 500) return;
          lastPosition = now();
        }
        store.apply(session.room, session.member, message);
      } catch (error) {
        send(socket, { type: 'error', code: error instanceof RoomError ? error.code : 'server_error', message: error instanceof RoomError ? error.message : 'The server could not process this message.', ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: Math.max(0, error.retryAfterMs) } : {}) });
      }
    });
    socket.on('close', () => {
      clearTimeout(joinTimeout);
      if (session && !closing) store.leave(session.room, session.member, socket);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
    store.cleanup();
    for (const [key, limit] of creationLimits) if (now() - limit.since > 60_000) creationLimits.delete(key);
  }, cleanupIntervalMs);
  heartbeat.unref();

  return {
    server, wss, rooms: store.rooms,
    address: () => server.address(),
    listen: () => new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(server.address()); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    }),
    close: () => new Promise((resolve, reject) => {
      closing = true;
      clearInterval(heartbeat);
      for (const batch of metadataBatches.values()) clearTimeout(batch.timer);
      metadataBatches.clear();
      store.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close(() => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections?.();
      });
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createJamServer({ lookupTrackMetadata: createSoundCloudMetadataResolver() });
  app.listen().then((address) => {
    console.log(`sc jams is listening at http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    app.close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
