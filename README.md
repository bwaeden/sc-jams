# sc jams

Minimal, desktop-first listening rooms for SoundCloud. Create a room, copy the invite, and listen with friends on one page.

The host controls playback. Everyone can add tracks or import a public playlist. Each listener streams through SoundCloud's official embedded player; the server exchanges room state over WebSockets and never downloads, stores, or relays audio.

This is an experimental prototype. Real browser playback and audible synchronization are still unverified; there is no measured latency guarantee.

## Run locally

Install [Node.js](https://nodejs.org/) 22 or newer:

```sh
npm ci
npm start
```

Open <http://localhost:3000>. In Windows PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

No SoundCloud API key or account connection is required. A nickname is optional. `localhost` only works on your computer; friends elsewhere need one shared server at an address everyone can reach.

## Use it

1. Create a room and copy its invite link.
2. Paste a public SoundCloud track or playlist link into the queue.
3. For a playlist, review its embedded preview and choose **Add tracks**.
4. Friends open the invite, join, and enable listening if their browser requires a click.

Use full URLs such as `https://soundcloud.com/artist/track` or `https://soundcloud.com/artist/sets/playlist`. Open shortened share links in SoundCloud first, then copy the full address. Private tracks, profile pages, and likes pages cannot be pasted as playlists.

Playlist import uses the Widget API's `getSounds` result and adds individual public tracks. Duplicate tracks are omitted, and the shared queue holds at most 100 tracks. The preview may expose only part of a large playlist; restricted or unavailable tracks can still fail during playback.

Volume and mute affect only your audio. Volume and the light/dark preference are saved in your browser. The page also keeps creation, invites, listeners, the queue, and help together. Optional source/social links stay hidden until configured. Add HTTPS links to `public/links.json` as an array of objects with `label` and `url` fields; they expand within the same page.

If the host disconnects, their role is reserved for 15 seconds before passing to a connected listener. Invite links have no password: anyone with the link can join and add music.

## Ads and waiting

Ads are independent for each listener. sc jams cannot detect ad start/end through the documented Widget API, make everyone receive the same ad, or guarantee that connecting a paid account would change embedded-player advertising.

If you get an ad or need time to catch up, choose **Wait for me**. The room pauses for the other listeners, while sc jams leaves your local player alone so your ad can finish. Choose **I'm ready** afterward; the host resumes playback. Several listeners can ask the room to wait and mark themselves ready independently.

This is a manual fallback, not automatic ad synchronization. Buffering, ads, browser restrictions, and track availability can still interrupt alignment. sc jams does not skip or remove SoundCloud advertising.

## Hosting

```sh
docker compose up --build -d
```

The Compose service `sc-jams` binds to <http://localhost:3000>. Stop it with `docker compose down`. To build the image directly:

```sh
docker build -t sc-jams .
docker run --rm -p 127.0.0.1:3000:3000 sc-jams
```

For internet access, use one server behind an HTTPS reverse proxy that supports WebSocket upgrades and forwards `/ws` as well as ordinary HTTP requests. HTTPS also enables the browser features needed for session identities and clipboard access.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listening interface; Docker sets `0.0.0.0` inside the container. |
| `PORT` | `3000` | HTTP and WebSocket port. |
| `PUBLIC_ORIGIN` | unset | Optional full public origin, such as `https://jam.example.com`, for validating browser requests behind a reverse proxy. |

Rooms, queues, and reconnect credentials live in process memory. A restart removes every room. There is no database, persistence, or coordination between multiple server instances. Nicknames are stored locally; browser-tab identities support reconnection after refresh.

SoundCloud controls embedding, regional and subscription restrictions, advertising, and track availability. Use headphones when testing nearby listeners. Mobile, background-tab, and locked-screen playback are unverified.

## Account integration and future direction

OAuth account linking is not implemented. SoundCloud's [API guide](https://developers.soundcloud.com/docs/api/guide) documents user authentication, and its [API specification](https://developers.soundcloud.com/docs/api/explorer/api.json) includes liked tracks and related tracks. A future integration could import a listener's likes or build a queue from related tracks without repeated pasting. Developer access currently requires a registered application and Artist Pro; app credentials must remain on the server.

These API features do not provide remote control of SoundCloud's native website/app queue or reproduce its personalized autoplay. The [Widget API](https://developers.soundcloud.com/docs/api/html5-widget) is the current playback interface. Account linking alone would not solve ad synchronization.

## SoundCloud permissions

SoundCloud's [player/widget terms](https://pages.soundcloud.com/geo/uk_us_ie/legal/terms-of-use.html#use-of-soundcloud-players-and-widget) restrict aggregating its content into a separate content service without prior written consent. Its [API terms](https://developers.soundcloud.com/docs/api/terms-of-use) also restrict alternative on-demand services and access to subscription-only content. Using the official player does not by itself establish permission to operate a listening-party service; clarify the intended use with SoundCloud before public hosting.

sc jams is independent of SoundCloud. Its MIT license covers the project code, not SoundCloud's music, artwork, trademarks, or service access.

## Development

```sh
npm run check
npm test
```

Tests use real HTTP/WebSocket clients for room behavior and a simulated SoundCloud widget for delayed playback callbacks. They do not establish audible synchronization or replace real browser testing. Docker execution has not been verified in this environment.

For manual checks, join the same room from two desktop browser profiles and try volume, mute, themes, playlist import, play/pause/seek, late joining, waiting, and reconnection. Check free and paid listeners separately when validating ad behavior.

The source is small: `src/server.js` handles HTTP and WebSockets, `src/rooms.js` holds room behavior, `public/` contains the one-page interface, and `test/` covers protocol and client logic. Contributions should preserve the short primary flow. Report playback issues with browser/OS details and reproduction steps; do not post private invite links or reconnect credentials.

## License

[MIT](LICENSE), copyright 2026 sc jams contributors.
