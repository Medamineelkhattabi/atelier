// Applies the chosen screen theme before the page draws, so it never flashes the other one.
// The choice is made in Settings › Appearance (or the sidebar switch) and kept in this browser.
// Default: light. A separate file (not inline) so the Content-Security-Policy stays strict.
(function () {
  var choice = 'light';
  try {
    choice = window.localStorage.getItem('pae.theme') || 'light';
  } catch (e) {
    choice = 'light';
  }
  var dark =
    choice === 'dark' ||
    (choice === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
