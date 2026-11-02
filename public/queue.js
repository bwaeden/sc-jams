// Keep queue rows stable across room updates so controls, focus and motion agree.
(() => {
  const rows = new Map();
  let state = null, list = null, draggedId = null;
  const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const svg = (name) => window.SCJamsIcons?.svg(name) || '';
  const make = (tag, className) => {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  };
  function text(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  function canReorder(id) {
    return Boolean(state?.isHost && state.connected && id !== state.currentTrackId && state.queue.some((track) => track.id === id));
  }
  function orderedIds() { return state?.queue.map((track) => track.id) || []; }
  function publishOrder(ids) {
    const original = orderedIds();
    if (!state?.isHost || !state.connected || ids.length !== original.length) return;
    if (state.currentTrackId && ids[0] !== state.currentTrackId) return;
    if (ids.every((id, index) => original[index] === id)) return;
    state.onReorder?.(ids);
  }
  function move(id, direction) {
    if (!canReorder(id)) return;
    const ids = orderedIds();
    const index = ids.indexOf(id), target = index + direction;
    const firstUpcoming = state.currentTrackId ? 1 : 0;
    if (target < firstUpcoming || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    publishOrder(ids);
  }
  function clearDrag() {
    draggedId = null;
    for (const row of rows.values()) {
      row.node.classList.remove('queue-dragging', 'queue-drop-before', 'queue-drop-after');
    }
  }
  function dropBefore(event, row) {
    const bounds = row.node.getBoundingClientRect();
    return !Number.isFinite(event.clientY) || event.clientY < bounds.top + bounds.height / 2;
  }
  function createRow(track) {
    const node = make('li', 'queue-item');
    node.setAttribute('data-track-id', track.id);
    const select = make('button', 'queue-track');
    select.type = 'button';
    const number = make('span', 'queue-number');
    number.setAttribute('aria-hidden', 'true');
    const info = make('span', 'queue-track-info');
    const title = make('strong', ''), contributor = make('span', '');
    info.append(title, contributor);
    select.append(number, info);
    const grip = make('span', 'queue-drag-handle');
    grip.innerHTML = svg('grip-vertical');
    grip.draggable = true;
    grip.title = 'Drag to reorder';
    grip.setAttribute('aria-hidden', 'true');
    const actions = make('div', 'queue-row-actions');
    const up = make('button', 'queue-move-button');
    up.type = 'button';
    up.innerHTML = svg('chevron-up');
    const down = make('button', 'queue-move-button');
    down.type = 'button';
    down.innerHTML = svg('chevron-down');
    const remove = make('button', 'remove-track');
    remove.type = 'button';
    remove.innerHTML = svg('x');
    actions.append(up, down, remove);
    node.append(grip, select, actions);
    const row = { id: track.id, node, select, number, title, contributor, grip, actions, up, down, remove, active: null, leaving: false, exitVersion: 0, animation: null, timer: null };
    select.addEventListener('click', () => {
      if (state?.isHost && state.connected && !row.leaving && row.id !== state.currentTrackId) state.onSelect?.(row.id);
    });
    remove.addEventListener('click', () => {
      if (state?.isHost && state.connected && !row.leaving) state.onRemove?.(row.id);
    });
    up.addEventListener('click', () => { if (!row.up.disabled) move(row.id, -1); });
    down.addEventListener('click', () => { if (!row.down.disabled) move(row.id, 1); });
    node.addEventListener('dragstart', (event) => {
      if (!canReorder(row.id) || row.leaving || (event.target !== grip && !grip.contains(event.target))) { event.preventDefault(); return; }
      draggedId = row.id;
      event.dataTransfer?.setData('text/plain', row.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      row.node.classList.add('queue-dragging');
    });
    node.addEventListener('dragover', (event) => {
      if (!draggedId || draggedId === row.id || !canReorder(draggedId) || row.id === state.currentTrackId || row.leaving) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      row.node.classList.toggle('queue-drop-before', dropBefore(event, row));
      row.node.classList.toggle('queue-drop-after', !dropBefore(event, row));
    });
    node.addEventListener('dragleave', (event) => {
      if (!event.relatedTarget || !node.contains(event.relatedTarget)) node.classList.remove('queue-drop-before', 'queue-drop-after');
    });
    node.addEventListener('drop', (event) => {
      if (!draggedId || draggedId === row.id || !canReorder(draggedId) || row.id === state.currentTrackId || row.leaving) return;
      event.preventDefault();
      const ids = orderedIds().filter((id) => id !== draggedId);
      const index = ids.indexOf(row.id) + (dropBefore(event, row) ? 0 : 1);
      ids.splice(index, 0, draggedId);
      publishOrder(ids);
      clearDrag();
    });
    node.addEventListener('dragend', clearDrag);
    return row;
  }
  function updateRow(row, track, index) {
    const active = track.id === state.currentTrackId;
    row.node.classList.toggle('current', active);
    row.node.setAttribute('aria-current', active ? 'true' : 'false');
    if (row.active !== active) {
      row.number.innerHTML = active ? svg('audio-lines') : '';
      row.active = active;
    }
    if (!active) text(row.number, String(index + 1).padStart(2, '0'));
    const title = track.title || track.url.split('/').at(-1).replaceAll('-', ' ');
    const contributor = track.addedByName || state.members?.find((member) => member.id === track.addedBy)?.name || 'User';
    text(row.title, title);
    text(row.contributor, active ? `Now playing · Added by ${contributor}` : `Added by ${contributor}`);
    row.select.disabled = !state.isHost || !state.connected || active;
    row.select.title = active ? 'Currently playing' : state.isHost ? 'Play this track next' : 'The host selects tracks';
    row.grip.hidden = !state.isHost || active;
    row.grip.draggable = canReorder(row.id);
    row.actions.hidden = !state.isHost;
    row.up.hidden = active;
    row.down.hidden = active;
    row.up.disabled = !state.connected || index <= (state.currentTrackId ? 1 : 0);
    row.down.disabled = !state.connected || index >= state.queue.length - 1;
    row.remove.disabled = !state.connected;
    row.up.setAttribute('aria-label', `Move ${title} up`);
    row.down.setAttribute('aria-label', `Move ${title} down`);
    row.remove.setAttribute('aria-label', `Remove ${title} from queue`);
    row.up.title = 'Move up';
    row.down.title = 'Move down';
    row.remove.title = 'Remove track';
  }
  function removeRow(row, exitVersion) {
    if (!rows.has(row.id) || rows.get(row.id) !== row || !row.leaving || row.exitVersion !== exitVersion) return;
    clearTimeout(row.timer);
    row.animation?.cancel();
    row.node.remove();
    rows.delete(row.id);
    if (row.hadFocus) {
      const target = [...rows.values()].find((item) => !item.leaving && !item.select.disabled)?.select || document.getElementById('track-url');
      target?.focus({ preventScroll: true });
    }
  }
  function exitRow(row) {
    row.leaving = true;
    const exitVersion = ++row.exitVersion;
    row.hadFocus = row.node.contains(document.activeElement);
    row.select.disabled = row.up.disabled = row.down.disabled = row.remove.disabled = true;
    row.grip.draggable = false;
    row.node.setAttribute('aria-hidden', 'true');
    row.node.classList.add('queue-leaving');
    if (reducedMotion()) { removeRow(row, exitVersion); return; }
    const height = row.node.getBoundingClientRect().height || 60;
    row.node.style.setProperty('--queue-row-height', `${height}px`);
    if (typeof row.node.animate === 'function') {
      row.animation = row.node.animate([
        { opacity: 1, transform: 'translateY(0)', height: `${height}px`, minHeight: `${height}px`, paddingTop: '9px', paddingBottom: '9px', marginBottom: '3px' },
        { opacity: 0, transform: 'translateY(-12px)', height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px' },
      ], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
      row.animation.onfinish = () => removeRow(row, exitVersion);
    } else row.node.addEventListener('animationend', () => removeRow(row, exitVersion), { once: true });
    row.timer = setTimeout(() => removeRow(row, exitVersion), 250);
  }
  function render(options) {
    list = document.getElementById('queue');
    if (!list) return;
    state = options;
    if (draggedId && !canReorder(draggedId)) clearDrag();
    const wanted = new Set(state.queue.map((track) => track.id));
    const previousRects = new Map([...rows.values()].filter((row) => !row.leaving).map((row) => [row.id, row.node.getBoundingClientRect()]));
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    for (const row of rows.values()) if (!wanted.has(row.id) && !row.leaving) exitRow(row);
    for (const [index, track] of state.queue.entries()) {
      let row = rows.get(track.id);
      if (!row) { row = createRow(track); rows.set(track.id, row); }
      if (row.leaving) {
        row.exitVersion++;
        clearTimeout(row.timer);
        row.animation?.cancel();
        row.leaving = false;
        row.node.classList.remove('queue-leaving');
        row.node.removeAttribute('aria-hidden');
      }
      updateRow(row, track, index);
    }
    // Order only live rows. Leaving rows retain their place while they collapse.
    let cursor = list.firstElementChild;
    for (const track of state.queue) {
      const row = rows.get(track.id);
      while (cursor?.classList.contains('queue-leaving')) cursor = cursor.nextElementSibling;
      if (row.node !== cursor) list.insertBefore(row.node, cursor || null);
      cursor = row.node.nextElementSibling;
    }
    if (focused && list.contains(focused) && document.activeElement !== focused && !focused.disabled) focused.focus({ preventScroll: true });
    if (!reducedMotion()) {
      for (const track of state.queue) {
        const row = rows.get(track.id), previous = previousRects.get(track.id);
        if (!previous || typeof row.node.animate !== 'function') continue;
        const distance = previous.top - row.node.getBoundingClientRect().top;
        if (Math.abs(distance) > 1) row.node.animate([{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
      }
    }
  }
  function clear() {
    for (const row of rows.values()) { clearTimeout(row.timer); row.animation?.cancel(); }
    rows.clear();
    (list || document.getElementById('queue'))?.replaceChildren();
    state = null;
    draggedId = null;
  }
  window.SCJamsQueue = Object.freeze({ render, clear });
})();
