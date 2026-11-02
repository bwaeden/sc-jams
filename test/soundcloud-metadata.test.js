import assert from 'node:assert/strict';
import test from 'node:test';
import { createSoundCloudMetadataResolver } from '../src/soundcloud-metadata.js';

const apiTrack = (id) => `https://api.soundcloud.com/tracks/${id}`;
const response = (body, options = {}) => ({ ok: true, status: 200, json: async () => body, ...options });
const metadata = (title = 'A song by Artist') => ({ provider_name: 'SoundCloud', title, author_name: 'Artist' });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('public oEmbed resolves a playlist ID without fetching audio or requiring credentials', async () => {
  const requests = [];
  const resolve = createSoundCloudMetadataResolver({ fetch: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return response({
      provider_name: 'SoundCloud', title: 'soser - who u love (prod. tdf) by i love you', author_name: 'i love you',
      author_url: 'https://soundcloud.com/iloveyou888', thumbnail_url: 'https://i1.sndcdn.com/artworks-example.jpg',
      html: '<iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F1803239802"></iframe>',
    });
  } });
  assert.deepEqual(await resolve(apiTrack(1803239802)), {
    title: 'soser - who u love (prod. tdf)', artist: 'i love you', soundcloudId: '1803239802', artwork: 'https://i1.sndcdn.com/artworks-example.jpg',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.origin, 'https://soundcloud.com');
  assert.equal(requests[0].url.pathname, '/oembed');
  assert.equal(requests[0].url.searchParams.get('url'), apiTrack(1803239802));
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test('title cleanup removes only an exact trailing author suffix', async () => {
  const titles = ['Song by Another by Artist', 'Song by Another', 'Song by Artist remixed', 'Song BY Artist'];
  const resolve = createSoundCloudMetadataResolver({ fetch: async () => response(metadata(titles.shift())) });
  assert.equal((await resolve(apiTrack(1))).title, 'Song by Another');
  assert.equal((await resolve(apiTrack(2))).title, 'Song by Another');
  assert.equal((await resolve(apiTrack(3))).title, 'Song by Artist remixed');
  assert.equal((await resolve(apiTrack(4))).title, 'Song BY Artist');
});

test('a full public input remains its permalink and canonical references share their cache', async () => {
  let requests = 0;
  const resolve = createSoundCloudMetadataResolver({ fetch: async () => { requests++; return response(metadata()); } });
  const first = await resolve('https://www.soundcloud.com/artist/a-song?utm_source=share');
  assert.equal(first.permalinkUrl, 'https://soundcloud.com/artist/a-song');
  assert.equal(first.soundcloudId, undefined);
  first.title = 'Changed by a consumer';
  assert.equal((await resolve('https://soundcloud.com/artist/a-song')).title, 'A song');
  assert.equal(requests, 1, 'cached metadata is normalized and protected from consumer mutation');
});

test('optional artwork and HTML track links are constrained to public SoundCloud resources', async () => {
  const resolve = createSoundCloudMetadataResolver({ fetch: async () => response({
    ...metadata(), thumbnail_url: 'https://evil.example/art.jpg',
    html: '<a href="https://soundcloud.com/artist">Artist</a><a href="https://evil.example/artist/song">Fake</a><a href="https://soundcloud.com/artist/private?secret_token=s-test">Private</a><a href="https://api.soundcloud.com/tracks/2">API</a><a href="https://www.soundcloud.com/artist/a-song?utm_source=share&amp;x=1">Song</a>',
  }) });
  const track = await resolve(apiTrack(1));
  assert.equal(track.permalinkUrl, 'https://soundcloud.com/artist/a-song');
  assert.equal(track.artwork, undefined);
});

test('malformed and non-public track inputs never make outbound requests', async () => {
  let requests = 0;
  const resolve = createSoundCloudMetadataResolver({ fetch: async () => { requests++; return response(metadata()); } });
  for (const url of [
    null, {}, 'not a url', 'http://soundcloud.com/artist/song', 'https://evil.example/artist/song',
    'https://soundcloud.com/artist', 'https://soundcloud.com/artist/sets/playlist',
    'https://soundcloud.com/artist/song?secret_token=s-test', 'https://api.soundcloud.com/tracks/0',
    'https://api.soundcloud.com/tracks/1/streams', 'https://api.soundcloud.com:444/tracks/1',
    'https://user:password@api.soundcloud.com/tracks/1', 'https://api.soundcloud.com/tracks/1?secret_token=s-test',
  ]) assert.equal(await resolve(url), null);
  assert.equal(requests, 0);
});

test('bulk metadata requests obey the concurrency limit and deduplicate in-flight URLs', async () => {
  let active = 0, maximum = 0, requests = 0;
  const releases = [];
  const resolve = createSoundCloudMetadataResolver({ concurrency: 3, fetch: async () => {
    requests++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((release) => releases.push(release));
    active--;
    return response(metadata());
  } });
  const batch = Array.from({ length: 100 }, (_, index) => resolve(apiTrack(index + 1)));
  const duplicate = resolve(apiTrack(1));
  assert.equal(active, 3);
  while (releases.length) {
    releases.splice(0).forEach((release) => release());
    await tick();
  }
  const results = await Promise.all(batch);
  assert.equal(results.length, 100);
  assert.equal((await duplicate).soundcloudId, '1');
  assert.equal(requests, 100);
  assert.equal(maximum, 3);
});

test('successful cache entries expire and the bounded cache evicts the least recently used entry', async () => {
  let timestamp = 1000, requests = 0;
  const resolve = createSoundCloudMetadataResolver({ cacheMs: 100, maxCacheEntries: 2, now: () => timestamp, fetch: async () => { requests++; return response(metadata()); } });
  await resolve(apiTrack(1));
  await resolve(apiTrack(2));
  await resolve(apiTrack(1));
  assert.equal(requests, 2);
  await resolve(apiTrack(3));
  await resolve(apiTrack(1));
  assert.equal(requests, 3, 'reading entry one protects it from eviction');
  await resolve(apiTrack(2));
  assert.equal(requests, 4, 'entry two was evicted');
  timestamp += 100;
  await resolve(apiTrack(2));
  assert.equal(requests, 5, 'an entry expires at its exact TTL');
});

test('network failures and malformed metadata are cached briefly and can recover', async () => {
  let timestamp = 1000, requests = 0;
  const resolve = createSoundCloudMetadataResolver({ failureCacheMs: 50, now: () => timestamp, fetch: async () => {
    requests++;
    if (requests === 1) throw new Error('Network unavailable');
    if (requests === 2) return response({ title: '', author_name: 'Artist' });
    return response(metadata());
  } });
  assert.equal(await resolve(apiTrack(1)), null);
  assert.equal(await resolve(apiTrack(1)), null);
  assert.equal(requests, 1);
  timestamp += 50;
  assert.equal(await resolve(apiTrack(1)), null);
  timestamp += 50;
  assert.equal((await resolve(apiTrack(1))).title, 'A song');
  assert.equal(requests, 3);
});

test('429 responses back off queued lookups without breaking the caller', async () => {
  let timestamp = 1000, requests = 0;
  const resolve = createSoundCloudMetadataResolver({ concurrency: 1, failureCacheMs: 50, now: () => timestamp, fetch: async () => {
    requests++;
    if (requests === 1) return response(null, { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }) });
    return response(metadata());
  } });
  const result = await Promise.all([resolve(apiTrack(1)), resolve(apiTrack(2)), resolve(apiTrack(3))]);
  assert.deepEqual(result, [null, null, null]);
  assert.equal(requests, 1, 'the remainder of the queue respects upstream backoff');
  timestamp += 2000;
  assert.equal((await resolve(apiTrack(2))).title, 'A song');
  assert.equal(requests, 2);
});

test('HTML is never accepted as executable content and unsupported or incomplete provider responses fail safely', async () => {
  const values = [null, [], { provider_name: 'Other', title: 'Fake' }, { title: 123 }, { title: '\u0000\t', author_name: 'Artist' }];
  const resolve = createSoundCloudMetadataResolver({ fetch: async () => response(values.shift()) });
  for (let index = 0; index < 5; index++) assert.equal(await resolve(apiTrack(index + 1)), null);
});
