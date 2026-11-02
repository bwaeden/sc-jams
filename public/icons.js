/* Curated local SVGs using Lucide/Feather's 24px grid. License: /icons.LICENSE.txt. */
(() => {
  const shapes = {
    play: '<path fill="currentColor" stroke="none" d="M8 5.5a1 1 0 0 1 1.52-.85l10.3 6.5a1 1 0 0 1 0 1.7l-10.3 6.5A1 1 0 0 1 8 18.5z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
    'skip-forward': '<path d="m5 4 10 8-10 8zM19 4v16"/>',
    'volume-2': '<path d="m11 5-6 4H2v6h3l6 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    'volume-x': '<path d="m11 5-6 4H2v6h3l6 4zM17 9l5 6m0-6-5 6"/>',
    moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="m18 6-12 12M6 6l12 12"/>',
    'rotate-cw': '<path d="M21 3v6h-6M20.5 14a9 9 0 1 1-2.1-8.4L21 9"/>',
    'refresh-cw': '<path d="M21 3v6h-6M3 21v-6h6M3.5 10a9 9 0 0 1 14.9-6.4L21 9M3 15l2.6 5.4A9 9 0 0 0 20.5 14"/>',
    'external-link': '<path d="M15 3h6v6m0-6L10 14M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5M21 12H9"/>',
    headphones: '<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="3" y="12" width="4" height="9" rx="2"/><rect x="17" y="12" width="4" height="9" rx="2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
    github: '<path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7M15 22v-3.3a2.9 2.9 0 0 0-.8-2.3c2.7-.3 5.6-1.3 5.6-6.1a4.8 4.8 0 0 0-1.3-3.4 4.5 4.5 0 0 0-.1-3.4S17.4 3.2 15 4.8a11.7 11.7 0 0 0-6 0C6.6 3.2 5.6 3.5 5.6 3.5a4.5 4.5 0 0 0-.1 3.4 4.8 4.8 0 0 0-1.3 3.4c0 4.8 2.9 5.8 5.6 6.1a2.9 2.9 0 0 0-.8 2.3V22"/>',
    coffee: '<path d="M18 8h1a3 3 0 1 1 0 6h-1M3 8h15v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 2v2m4-2v2m4-2v2"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7M5 12h14"/>',
    loader: '<path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83"/>',
    'audio-lines': '<path d="M2 10v4m4-7v10m4-14v18m4-14v10m4-12v14m4-9v4"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
    'more-horizontal': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m6 15 6-6 6 6"/>',
    'grip-vertical': '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
  };
  function svg(name) {
    if (!shapes[name]) return '';
    return `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes[name]}</svg>`;
  }
  function render(root = document) {
    for (const node of root.querySelectorAll?.('[data-icon]') || []) {
      const name = node.getAttribute('data-icon');
      if (!shapes[name]) continue;
      if (node.tagName.toLowerCase() === 'svg') {
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) node.setAttribute(key, value);
        node.classList.add('icon');
        node.innerHTML = shapes[name];
      } else node.innerHTML = svg(name);
    }
  }
  window.SCJamsIcons = Object.freeze({ svg, render, names: Object.keys(shapes) });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => render());
  else render();
})();
