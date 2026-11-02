(() => {
  const toggle = document.getElementById('theme-toggle');
  function updateTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('sc-jams:theme', theme); } catch {}
    const dark = theme === 'dark';
    toggle.innerHTML = window.SCJamsIcons.svg(dark ? 'sun' : 'moon');
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }
  updateTheme(document.documentElement.getAttribute('data-theme') || 'light');
  toggle.addEventListener('click', () => updateTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  async function loadDonation() {
    try {
      const response = await fetch('/support.json');
      if (!response.ok) return;
      const config = await response.json();
      if (!config.url) return;
      const url = new URL(config.url);
      if (url.protocol !== 'https:' || url.username || url.password) return;
      const link = document.getElementById('donation-link');
      link.href = url.href;
      link.hidden = false;
      document.getElementById('donation-status').textContent = 'Thank you for supporting sc jams. Donations are optional.';
    } catch { /* GitHub support remains available if donations are not configured. */ }
  }
  loadDonation();
})();
