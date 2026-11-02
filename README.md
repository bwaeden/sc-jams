# sc jams

Minimal, desktop-first listening rooms for SoundCloud. Create a room, copy the invite, and listen with friends on one page.

[Source on GitHub](https://github.com/bwaeden/sc-jams)

Everyone can add music and pause shared playback. The host resumes, seeks, and manages the queue. Each listener streams through SoundCloud's official embedded player; the server exchanges room state over WebSockets and never downloads, stores, or relays audio.

This is an experimental prototype. Real browser playback and audible synchronization are still unverified; there is no measured latency guarantee.

## Run locally

Install [Node.js](https://nodejs.org/) 22 or newer:

```sh
npm ci
npm start
```

Open <http://localhost:3000>. In Windows PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

No SoundCloud API key or account connection is required. A nickname is optional. `localhost` only works on your computer; friends elsewhere need one shared server at an address everyone can reach.

Listeners who leave the name blank appear as **User**. Session IDs are never used as display names.

## Use it

1. Create a room and copy its invite link.
2. Paste a public SoundCloud track or playlist link into the queue.
3. For a playlist, review its embedded preview and choose **Add tracks**.
4. Friends open the invite, join, and enable listening if their browser requires a click.

Use full URLs such as `https://soundcloud.com/artist/track` or `https://soundcloud.com/artist/sets/playlist`. Open shortened share links in SoundCloud first, then copy the full address. Private tracks, profile pages, and likes pages cannot be pasted as playlists.

Playlist import uses the Widget API's `getSounds` result and adds individual public tracks. Duplicate tracks are omitted, and the shared queue holds at most 100 tracks. The preview may expose only part of a large playlist; restricted or unavailable tracks can still fail during playback.

After playback starts, finishing a track automatically starts the next queued track. With repeat off, finished or skipped tracks leave the queue instead of accumulating as history. Their rows slide upward and collapse briefly; reduced-motion preferences disable the animation. A single remaining track repeats until another is queued, then advances on its next completion.

The host can drag upcoming tracks by their handles or use the move-up/move-down buttons. The current track remains first, and reordering does not change playback position. Selecting another track plays it in place of the current one while preserving the other upcoming tracks. With queue repeat enabled, the previous track moves to the back; otherwise it leaves the queue.

The queue shows who added every track, including the current one. The name is captured when the track is queued, so it remains visible after that listener leaves.

## Shared controls and queue modes

In a two-person room, either listener can skip directly. With three or more connected listeners, a guest's skip request casts their vote and opens a compact voting control next to Skip on everyone's screen. Passing requires a strict majority of connected listeners: 2 of 3, 3 of 4, and so on. Each listener gets one vote; disconnected voters are removed and the threshold follows the connected room size. Passing advances immediately and starts the next track unless the room is explicitly waiting. The host can still skip directly or join a vote.

Anyone can pause, while resuming remains the host's action. In shared rooms, four pause/wait requests within ten seconds trigger a ten-second cooldown on the next request. The limit is per listener, persists through reconnects, and does not apply to a host alone in their room. Volume and other controls remain available during the cooldown.

Only the host sees loop and shuffle controls. Loop cycles through **Off**, **Current track**, and **Queue**. Track repeat restarts the same song; queue repeat rotates completed songs to the back. Manual skips bypass track repeat. Shuffle changes only upcoming tracks, leaves the playing track and its position intact, and is available when there are at least two upcoming tracks. Duplicate completion events cannot advance a repeated song twice.

Volume and mute affect only your audio. Volume and the light/dark preference are saved in your browser. The page keeps creation, invites, listeners, the queue, and help together. Footer links open GitHub and the support page in another tab so they do not interrupt a jam.

The support page reads its donation destination from `public/support.json`. Its current destination is [Buy Me a Coffee](https://buymeacoffee.com/bwaeden). Set `url` to another HTTPS recipient URL to change providers, or `null` to hide checkout while retaining the GitHub support option.

## Interface and playback controls

The layout follows the restrained hierarchy of [Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh) and the focused controls of [Apple Music MiniPlayer](https://support.apple.com/guide/music-web-review/use-music-miniplayer-apdm333a63ec/web). Icons use a consistent local SVG set based on [Lucide's design principles](https://lucide.dev/contribute/icons/design-principles); no icon fonts, external icon scripts, or text characters are used for transport controls. Lucide and Feather notices are included in `public/icons.LICENSE.txt`.

Shared playback controls are enabled after SoundCloud reports that the player is ready. Host playback actions and guest pauses from either the site's controls or the SoundCloud embed use the same synchronization flow. A local action takes effect immediately and remains pending until the server confirms it; older asynchronous position callbacks cannot undo a newer pause or seek. Guest volume remains personal. Guests cannot resume a room that is paused.

If the host disconnects, their role is reserved for 15 seconds before passing to a connected listener. Invite links have no password: anyone with the link can join and add music.

## Ads and waiting

Ads are independent for each listener. sc jams cannot detect ad start/end through the documented Widget API, make everyone receive the same ad, or guarantee that connecting a paid account would change embedded-player advertising.

Choose **Wait for me** to pause everyone's music immediately, including your own. Choose **I'm ready** afterward. The host can resume once every waiting listener is ready. Several listeners can wait independently, and a disconnected listener cannot leave the room blocked indefinitely.

If you need an ad to finish, choose **Let my ad finish** while waiting. This explicitly plays only your local audio while everyone else stays paused; it never resumes shared playback. Choosing **I'm ready** pauses local audio again until the host resumes. Waiting no longer assumes that the requester is hearing an ad.

This is a manual fallback, not automatic ad synchronization. SoundCloud's [advertising information](https://community.soundcloud.com/company/advertise) lists embedded players as an audio-ad channel, but this does not establish that every embedded session will receive ads. Buffering, ads, browser restrictions, and track availability can still interrupt alignment. sc jams does not skip or remove SoundCloud advertising.

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
