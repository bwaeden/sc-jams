# Sidecar

A small, desktop-first listening room for friends who use SoundCloud.

Create a room, share its link, and add SoundCloud tracks to a shared queue. One host controls playback; everyone listens through SoundCloud's official embedded player. Sidecar exchanges playback state over WebSockets. It does not download, store, or relay audio.

This is an experimental prototype. Playback synchronization still needs testing across real devices and networks. There is no measured latency guarantee.

## Run locally

Install [Node.js](https://nodejs.org/) 22 or newer, then run:

```sh
npm install
npm start
```

Open <http://localhost:3000>. On Windows PowerShell, use `npm.cmd` if your execution policy blocks `npm.ps1`.

No SoundCloud API key or Sidecar account is required. Enter a nickname and use a public, embeddable track's full URL, such as `https://soundcloud.com/artist/track`. Profile pages, playlists, and shortened share links are outside this prototype's scope. Open a shortened link in SoundCloud and copy the full track URL from your browser.

`localhost` works only on your own computer. To invite someone elsewhere, run one shared server at a URL that both of you can reach.

## Use a room

1. Create a room and copy its invite link.
2. Ask friends to open the link and enter a nickname.
3. Paste a SoundCloud track link into the queue.
4. Enable listening when prompted by the browser.
5. The host plays, pauses, seeks, and skips. Everyone can add tracks.

New listeners catch up to the room's current playback position. If the host disconnects, Sidecar reserves their place for 15 seconds so they can reconnect, then hands control to a connected listener.

Keep invite links within your group. Rooms have no passwords, and anyone with the link can join and add tracks.

## Run with Docker

```sh
docker compose up --build -d
```

Open <http://localhost:3000>. To stop it:

```sh
docker compose down
```

The supplied Compose file binds the app to the local computer. For an internet-facing deployment, place it behind an HTTPS reverse proxy that supports WebSocket upgrades and forwards both HTTP requests and `/ws` to the app. Use one app instance. Share its public HTTPS URL; the browser will use secure WebSockets automatically.

You can also build and run the image directly:

```sh
docker build -t sidecar .
docker run --rm -p 127.0.0.1:3000:3000 sidecar
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface used by the Node server. The Docker image sets this to `0.0.0.0` inside the container. |
| `PORT` | `3000` | HTTP and WebSocket port. |
| `PUBLIC_ORIGIN` | unset | Optional full public origin, such as `https://jam.example.com`, used to verify browser requests behind a reverse proxy. |

Rooms, the queue, and reconnect credentials live in process memory. Restarting the server removes every room. There is no database, account system, persistence, or coordination between multiple app instances. Your browser stores your nickname locally and keeps a session identity for reconnection after a refresh. Separate tabs have separate identities.

## Playback limits

- Use headphones when testing two listeners nearby. Independently streamed audio can produce an audible echo through speakers.
- SoundCloud controls track availability, advertising, embedding, and regional or subscription restrictions. A track that works for one person may be unavailable to another.
- Browsers may require a click before they permit audio. Ad blockers and privacy extensions may block SoundCloud's player.
- Synchronization uses position corrections rather than sample-accurate audio scheduling. Buffering, advertisements, background tabs, and device performance can interrupt alignment.
- This version focuses on desktop browsers. It does not control playback in SoundCloud's native app. Mobile and locked-screen playback are unverified.

The official [Widget API](https://developers.soundcloud.com/docs/api/html5-widget) provides the player controls. Audio stays with SoundCloud; successful room-protocol tests do not establish playback quality or reliable synchronization.

## SoundCloud permissions

SoundCloud's [player and widget terms](https://pages.soundcloud.com/geo/uk_us_ie/legal/terms-of-use.html#use-of-soundcloud-players-and-widget) restrict aggregating its content into a separate content service without prior written consent. Its [API terms](https://developers.soundcloud.com/docs/api/terms-of-use) also restrict alternative on-demand services and access to subscription-only content. Using the official embed does not by itself establish permission to operate a listening-party service. Clarify the intended use with SoundCloud before public hosting.

Sidecar is independent and is not affiliated with or endorsed by SoundCloud. The MIT license covers Sidecar's code, not SoundCloud's music, artwork, trademarks, or service access.

## Development

```sh
npm test
```

The Node test runner exercises room behavior with real HTTP and WebSocket clients and tests browser synchronization logic against a simulated SoundCloud widget with delayed callbacks. These checks do not replace real browser or audio testing. For manual playback testing, open the same room in two desktop browser profiles, enable listening in each, and check play, pause, seeking, late joining, and reconnecting with a public track.

The source is intentionally small:

- `src/server.js`: HTTP server, static assets, and WebSocket transport.
- `src/rooms.js`: room membership, permissions, queue, and authoritative playback state.
- `public/`: browser interface and SoundCloud widget integration.
- `test/`: automated protocol tests.

Contributions should keep the primary flow short and the dependency list small. Include reproduction steps for playback bugs: browser and version, operating system, track URL, listener count, whether the tab was in the background, and what each listener heard. Avoid posting private room links or browser reconnect credentials.

## License

[MIT](LICENSE), copyright 2026 Sidecar contributors.
