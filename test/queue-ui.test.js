import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/queue.js', import.meta.url), 'utf8');

function fixture({ reducedMotion = false, webAnimations = true } = {}) {
  let timerId = 0;
  const timers = new Map(), animations = [], calls = [];
  const document = { activeElement: null };
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.listeners = new Map();
      this.attributes = new Map();
      this.classes = new Set();
      this.style = { setProperty() {} };
      this.classList = {
        add: (...names) => names.forEach((name) => this.classes.add(name)),
        remove: (...names) => names.forEach((name) => this.classes.delete(name)),
        contains: (name) => this.classes.has(name),
        toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
      };
      if (!webAnimations) this.animate = undefined;
    }
    set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    set textContent(value) { this.valueText = String(value); this.children = []; }
    get textContent() { return this.valueText || this.children.map((node) => node.textContent).join(''); }
    set innerHTML(value) { this.valueHtml = value; this.valueText = ''; this.children = []; }
    get innerHTML() { return this.valueHtml || ''; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    append(...nodes) { nodes.forEach((node) => this.insertBefore(node, null)); }
    replaceChildren(...nodes) { this.children.forEach((node) => node.parentNode = null); this.children = []; this.append(...nodes); }
    insertBefore(node, reference) {
      node.remove();
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      assert.ok(index >= 0, 'a DOM insertion must reference an existing child');
      this.children.splice(index, 0, node);
      node.parentNode = this;
      return node;
    }
    remove() {
      if (!this.parentNode) return;
      if (this.contains(document.activeElement)) document.activeElement = null;
      const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentNode = null;
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    getBoundingClientRect() { return { top: (this.parentNode?.children.indexOf(this) || 0) * 60, height: 60 }; }
    focus() { document.activeElement = this; }
    animate(keyframes, options) {
      const animation = { node: this, keyframes, options, canceled: false,
        cancel() { this.canceled = true; }, finish() { this.onfinish?.(); } };
      animations.push(animation);
      return animation;
    }
  }
  const list = new Element('ol'), input = new Element('input');
  document.createElement = (tag) => new Element(tag);
  document.getElementById = (id) => id === 'queue' ? list : input;
  const window = { matchMedia: () => ({ matches: reducedMotion }), SCJamsIcons: { svg: (name) => `<svg>${name}</svg>` } };
  vm.runInNewContext(source, { document, window,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const tracks = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: `Track ${id}`, url: `https://soundcloud.com/artist/track-${id}`, addedBy: 'user' }));
  const base = { queue: tracks.slice(0, 3), currentTrackId: 'a', isHost: true, connected: true,
    members: [{ id: 'user', name: 'User' }],
    onSelect: (id) => calls.push({ action: 'select', id }), onRemove: (id) => calls.push({ action: 'remove', id }),
    onReorder: (ids) => calls.push({ action: 'reorder', ids: Array.from(ids) }) };
  const render = (changes = {}) => window.SCJamsQueue.render({ ...base, ...changes });
  const row = (id) => list.children.find((node) => node.getAttribute('data-track-id') === id);
  const controls = (id) => {
    const node = row(id), [grip, select, actions] = node.children;
    const [up, down, remove] = actions.children;
    return { node, grip, select, actions, up, down, remove };
  };
  return { list, input, tracks, base, calls, animations, document, render, row, controls, api: window.SCJamsQueue,
    click: (node) => node.listeners.get('click')(),
    timers(ms) {
      for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); }
    },
  };
}

test('host queue controls emit whole orders while keeping the playing track first', () => {
  const q = fixture();
  q.render();
  assert.equal(q.controls('a').grip.hidden, true);
  assert.equal(q.controls('b').up.disabled, true);
  q.click(q.controls('b').up);
  assert.equal(q.calls.length, 0, 'the first upcoming track cannot move above the playing track');
  q.click(q.controls('c').up);
  q.click(q.controls('b').down);
  assert.deepEqual(q.calls, [
    { action: 'reorder', ids: ['a', 'c', 'b'] },
    { action: 'reorder', ids: ['a', 'c', 'b'] },
  ]);
  q.click(q.controls('c').select);
  q.click(q.controls('b').remove);
  assert.deepEqual(q.calls.slice(-2), [{ action: 'select', id: 'c' }, { action: 'remove', id: 'b' }]);
  q.render({ isHost: false });
  assert.equal(q.controls('b').grip.hidden, true);
  assert.equal(q.controls('b').actions.hidden, true);
  q.click(q.controls('b').remove);
  q.click(q.controls('c').up);
  assert.equal(q.calls.length, 4, 'guests cannot invoke host queue actions');
});

test('dragging rejects the playing track and produces a valid upcoming order', () => {
  const q = fixture();
  q.render();
  let prevented = 0;
  const transfer = { setData() {} };
  const start = (id) => {
    const row = q.controls(id);
    row.node.listeners.get('dragstart')({ target: row.grip, dataTransfer: transfer, preventDefault() { prevented++; } });
  };
  start('a');
  assert.equal(prevented, 1);
  assert.equal(q.calls.length, 0);
  start('c');
  q.controls('b').node.listeners.get('drop')({ clientY: 61, dataTransfer: transfer, preventDefault() { prevented++; } });
  assert.deepEqual(q.calls, [{ action: 'reorder', ids: ['a', 'c', 'b'] }]);
  assert.equal(q.controls('c').node.classList.contains('queue-dragging'), false);
  start('c');
  q.controls('a').node.listeners.get('drop')({ clientY: 1, dataTransfer: transfer, preventDefault() { prevented++; } });
  assert.equal(q.calls.length, 1, 'a drop cannot place a pending track before the playing track');
});

test('room revisions reuse row controls and preserve focus through metadata and order changes', () => {
  const q = fixture();
  q.render();
  const b = q.controls('b'), c = q.controls('c');
  b.select.focus();
  q.render({ queue: [q.tracks[0], { ...q.tracks[1], title: 'Updated title' }, q.tracks[2]] });
  assert.equal(q.controls('b').node, b.node);
  assert.equal(q.controls('b').select, b.select);
  assert.equal(q.document.activeElement, b.select);
  assert.equal(b.select.children[1].children[0].textContent, 'Updated title');
  c.select.focus();
  q.render({ queue: [q.tracks[0], q.tracks[2], q.tracks[1]] });
  assert.equal(q.list.children[1], c.node);
  assert.equal(q.document.activeElement, c.select, 'moving a row restores its focused control');
});

test('consumed rows animate upward and collapse, then are removed with a cleanup fallback', () => {
  const q = fixture();
  q.render();
  const old = q.row('a');
  q.render({ queue: q.tracks.slice(1, 3), currentTrackId: 'b' });
  const exit = q.animations.find((animation) => animation.node === old && 'opacity' in animation.keyframes[0]);
  assert.equal(exit.options.duration, 200);
  assert.equal(exit.keyframes.at(-1).transform, 'translateY(-12px)');
  assert.equal(exit.keyframes.at(-1).height, '0px');
  assert.ok(q.row('b').classList.contains('current'), 'the next track becomes current before the old visual exits');
  exit.finish();
  assert.equal(q.row('a'), undefined);
  assert.deepEqual(q.list.children.map((node) => node.getAttribute('data-track-id')), ['b', 'c']);
  const fallback = fixture({ webAnimations: false });
  fallback.render();
  fallback.render({ queue: fallback.tracks.slice(1, 3), currentTrackId: 'b' });
  assert.ok(fallback.row('a').classList.contains('queue-leaving'));
  fallback.timers(250);
  assert.equal(fallback.row('a'), undefined);
});

test('reduced motion removes consumed tracks immediately and overlapping revisions keep the right rows', () => {
  const reduced = fixture({ reducedMotion: true });
  reduced.render();
  reduced.render({ queue: reduced.tracks.slice(1, 3), currentTrackId: 'b' });
  assert.equal(reduced.row('a'), undefined);
  assert.equal(reduced.animations.length, 0);
  const q = fixture();
  q.render();
  const b = q.row('b');
  q.render({ queue: q.tracks.slice(1, 3), currentTrackId: 'b' });
  q.render({ queue: [q.tracks[1], q.tracks[3]], currentTrackId: 'b' });
  q.timers(250);
  assert.equal(q.row('b'), b);
  assert.deepEqual(q.list.children.map((node) => node.getAttribute('data-track-id')), ['b', 'd']);
  assert.equal(new Set(q.list.children).size, 2);
  q.api.clear();
  assert.equal(q.list.children.length, 0);
});

test('a canceled old exit callback cannot remove a row retained by a newer revision', () => {
  const q = fixture();
  q.render();
  const original = q.row('b');
  q.render({ queue: [q.tracks[0], q.tracks[2]] });
  const exit = q.animations.find((animation) => animation.node === original && 'opacity' in animation.keyframes[0]);
  q.render(); // A newer authoritative revision retains b before its old exit ends.
  assert.equal(q.row('b'), original);
  exit.finish();
  assert.equal(q.row('b'), original);
  assert.equal(q.list.children.length, 3);
});

test('every track keeps its queued-by attribution after its listener leaves', () => {
  const q = fixture();
  const queue = [
    { ...q.tracks[0], addedBy: 'alex', addedByName: 'Alex' },
    { ...q.tracks[1], addedBy: 'bea', addedByName: 'Bea' },
  ];
  q.render({ queue, members: [] });
  const subtitle = (id) => q.controls(id).select.children[1].children[1].textContent;
  assert.equal(subtitle('a'), 'Now playing · Added by Alex');
  assert.equal(subtitle('b'), 'Added by Bea');
  q.render({ queue, members: [{ id: 'alex', name: 'Renamed listener' }] });
  assert.equal(subtitle('a'), 'Now playing · Added by Alex', 'the saved attribution identifies who queued the track');
});

test('legacy attribution and metadata update without replacing queue controls', () => {
  const q = fixture();
  q.render({ members: [{ id: 'user', name: 'Alex' }] });
  const original = q.controls('b');
  assert.equal(original.select.children[1].children[1].textContent, 'Added by Alex');
  q.render({ queue: [q.tracks[0], { ...q.tracks[1], title: 'New title' }, q.tracks[2]], members: [{ id: 'user', name: 'Bea' }] });
  assert.equal(q.controls('b').node, original.node);
  assert.equal(original.select.children[1].children[0].textContent, 'New title');
  assert.equal(original.select.children[1].children[1].textContent, 'Added by Bea');
  q.render({ members: [] });
  assert.equal(original.select.children[1].children[1].textContent, 'Added by User');
});

test('queue rotation and repeating a track retain rows without a false exit animation', () => {
  const q = fixture();
  q.render();
  const originals = new Map(q.list.children.map((node) => [node.getAttribute('data-track-id'), node]));
  const rotated = [q.tracks[1], q.tracks[2], q.tracks[0]];
  q.render({ queue: rotated, currentTrackId: 'b' });
  for (const track of rotated) assert.equal(q.row(track.id), originals.get(track.id));
  assert.deepEqual(q.list.children.map((node) => node.getAttribute('data-track-id')), ['b', 'c', 'a']);
  assert.ok(q.controls('b').node.classList.contains('current'));
  assert.ok(!q.controls('a').node.classList.contains('current'));
  q.render({ queue: rotated, currentTrackId: 'b' });
  assert.equal(q.row('b'), originals.get('b'), 'a repeated current track reuses its existing row');
  assert.ok(!q.animations.some((animation) => 'opacity' in animation.keyframes[0]), 'retained looping rows must not fade or collapse');
});
