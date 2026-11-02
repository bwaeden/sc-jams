// Apply the saved theme before styles paint, so reloading a dark room stays dark.
try {
  const saved = localStorage.getItem('sc-jams:theme');
  const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', saved === 'dark' || saved === 'light' ? saved : preferred);
} catch { /* The default light theme also works when browser storage is disabled. */ }
