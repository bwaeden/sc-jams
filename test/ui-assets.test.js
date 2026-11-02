import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const iconSource = read('icons.js');
const supportSource = read('support.js');
const supportHtml = read('support.html');

class Element {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.listeners = new Map();
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.classList = { values: new Set(), add(value) { this.values.add(value); } };
    this.innerHTML = '';
    this.textContent = '';
    if (attributes.href) this.href = attributes.href;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  click() { this.listeners.get('click')?.(); }
}

function parseAttributes(source) {
  return Object.fromEntries([...source.matchAll(/([a-zA-Z_:][\w:.-]*)(?:="([^"]*)")?/g)].map((match) => [match[1], match[2] ?? '']));
}

function pageElements(html) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="[^"]+"[^>]*)>/gi)) {
    const attributes = parseAttributes(match[2]);
    elements.set(attributes.id, new Element(match[1], attributes));
  }
  return elements;
}

async function supportPage(config = {}, { theme = 'light', responseOk = true } = {}) {
  const elements = pageElements(supportHtml);
  const root = new Element('html', { 'data-theme': theme });
  const values = new Map();
  const iconPlaceholders = [...supportHtml.matchAll(/<svg\b([^>]*\bdata-icon="[^"]+"[^>]*)>/g)]
    .map((match) => new Element('svg', parseAttributes(match[1])));
  const context = vm.createContext({
    URL,
    window: {},
    document: {
      readyState: 'complete', documentElement: root,
      querySelectorAll: () => iconPlaceholders,
      getElementById(id) { assert.ok(elements.has(id), `support.js requested missing HTML element ${id}`); return elements.get(id); },
    },
    localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    fetch: async (url) => {
      assert.equal(url, '/support.json');
      return { ok: responseOk, json: async () => config };
    },
  });
  vm.runInContext(iconSource, context, { filename: 'icons.js' });
  vm.runInContext(supportSource, context, { filename: 'support.js' });
  await new Promise(setImmediate);
  return { elements, root, values, icons: context.window.SCJamsIcons, iconPlaceholders };
}

test('support page theme switch updates its action, appearance, and saved preference', async () => {
  const page = await supportPage({}, { theme: 'dark' });
  const toggle = page.elements.get('theme-toggle');
  assert.equal(toggle.getAttribute('aria-label'), 'Switch to light mode');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.match(toggle.innerHTML, /<svg\b/);
  toggle.click();
  assert.equal(page.root.getAttribute('data-theme'), 'light');
  assert.equal(toggle.getAttribute('aria-label'), 'Switch to dark mode');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(page.values.get('sc-jams:theme'), 'light');
  toggle.click();
  assert.equal(page.root.getAttribute('data-theme'), 'dark');
  assert.equal(page.values.get('sc-jams:theme'), 'dark');
});

test('an unset donation recipient never exposes a fake checkout action', async () => {
  const page = await supportPage({ url: '' });
  const donation = page.elements.get('donation-link');
  assert.equal(donation.hidden, true);
  assert.equal(donation.href, undefined);
  assert.match(supportHtml, /Donations[^<]+open yet/);
});

test('a configured HTTPS donation recipient activates the actual checkout destination', async () => {
  const url = 'https://buymeacoffee.com/scjamstest';
  const page = await supportPage({ url });
  const donation = page.elements.get('donation-link');
  assert.equal(donation.hidden, false);
  assert.equal(donation.href, url);
  assert.match(page.elements.get('donation-status').textContent, /Donations are optional/);
  assert.equal(donation.getAttribute('target'), '_blank');
  assert.match(donation.getAttribute('rel'), /noopener/);
});

test('invalid or credential-bearing donation URLs remain inactive', async () => {
  for (const url of ['http://buymeacoffee.com/test', 'javascript:alert(1)', 'https://user:password@example.com/support', 'not a URL']) {
    const page = await supportPage({ url });
    const donation = page.elements.get('donation-link');
    assert.equal(donation.hidden, true, `should not activate ${new URL(url, 'https://invalid.example').protocol} destination`);
    assert.equal(donation.href, undefined);
  }
  const unavailable = await supportPage({ url: 'https://buymeacoffee.com/test' }, { responseOk: false });
  assert.equal(unavailable.elements.get('donation-link').hidden, true);
});

test('every local icon produces vector geometry with a consistent accessible SVG shell', async () => {
  const { icons } = await supportPage();
  assert.ok(icons.names.length > 10);
  for (const name of icons.names) {
    const svg = icons.svg(name);
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /focusable="false"/);
    assert.match(svg, /aria-hidden="true"/);
    assert.match(svg, /<(?:path|rect|circle|line|polyline|polygon)\b/);
    assert.doesNotMatch(svg, /[▶Ⅱ↦↗☀◐♪]/);
  }
  assert.equal(icons.svg('missing-icon'), '');
});

test('icon placeholders are replaced with the actual vector artwork', async () => {
  const { iconPlaceholders } = await supportPage();
  assert.ok(iconPlaceholders.length > 0);
  for (const node of iconPlaceholders) {
    assert.equal(node.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(node.getAttribute('focusable'), 'false');
    assert.equal(node.getAttribute('aria-hidden'), 'true');
    assert.equal(node.classList.values.has('icon'), true);
    assert.match(node.innerHTML, /<(?:path|rect|circle|line|polyline|polygon)\b/);
  }
});

test('both pages have unique IDs and use only supported SVG icon names', async () => {
  const { icons } = await supportPage();
  for (const name of ['index.html', 'support.html']) {
    const html = read(name);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${name} must not duplicate a DOM ID`);
    for (const match of html.matchAll(/\bdata-icon="([^"]+)"/g)) {
      assert.ok(icons.names.includes(match[1]), `${name} refers to unknown icon ${match[1]}`);
    }
    assert.doesNotMatch(html, />\s*[▶Ⅱ↦↗☀◐♪]\s*</);
  }
});

test('the app footer links directly to the real GitHub repo and support page', () => {
  const html = read('index.html');
  const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];
  assert.ok(footer, 'the app has a footer');
  const anchors = [...footer.matchAll(/<a\b([^>]+)>[\s\S]*?<\/a>/g)].map((match) => parseAttributes(match[1]));
  const github = anchors.find((anchor) => anchor.href === 'https://github.com/bwaeden/sc-jams');
  const support = anchors.find((anchor) => anchor.href === '/support.html');
  for (const anchor of [github, support]) {
    assert.ok(anchor, 'both project and support destinations are available');
    assert.equal(anchor.target, '_blank');
    assert.match(anchor.rel, /noopener/);
  }
  assert.match(read('support.html'), /id="donation-link"/);
});
