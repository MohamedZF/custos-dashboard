// Shared password lock for the Custos pages. The update job encrypts every data file with one site-wide key
// (PBKDF2-SHA256 -> AES-256-GCM); this file derives the same key from the visitor's password and decrypts.
// The derived key (never the password) is kept in sessionStorage, and in localStorage when "Remember" is ticked,
// so moving between the homepage and tag pages does not ask again.
window.CustosLock = (() => {
  const KEY_NAME = 'custos-dashboard-key';
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  let key = null;

  async function fetchBundle(path) {
    const r = await fetch(path + '?v=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  async function deriveKey(password, bundle) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(bundle.salt), iterations: bundle.iterations }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }
  async function decryptWith(bundle, k) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(bundle.iv) }, k, b64(bundle.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function storedKey() {
    let raw = null;
    try { raw = sessionStorage.getItem(KEY_NAME) || localStorage.getItem(KEY_NAME); } catch (e) {}
    if (!raw) return null;
    try { return await crypto.subtle.importKey('raw', b64(raw), 'AES-GCM', true, ['decrypt']); } catch (e) { return null; }
  }
  async function remember(k, persist) {
    const raw = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', k))));
    try { sessionStorage.setItem(KEY_NAME, raw); } catch (e) {}
    try { if (persist) localStorage.setItem(KEY_NAME, raw); else localStorage.removeItem(KEY_NAME); } catch (e) {}
  }
  function forget() { key = null; try { sessionStorage.removeItem(KEY_NAME); localStorage.removeItem(KEY_NAME); } catch (e) {} }

  // Decrypt with the remembered key. Returns the payload, or null when no key is stored or it no longer fits.
  async function open(bundle) {
    if (!key) key = await storedKey();
    if (!key) return null;
    try { return await decryptWith(bundle, key); } catch (e) { forget(); return null; }
  }
  // Decrypt with a typed password; remembers the key on success. Throws on a wrong password.
  async function unlock(bundle, password, persist) {
    const k = await deriveKey(password, bundle);
    const payload = await decryptWith(bundle, k);
    key = k; await remember(k, persist);
    return payload;
  }

  // Wires up the lock screen markup (#lock, #lock-form, #lock-password, #lock-remember, #lock-submit, #lock-error)
  // and the page content element. getBundle() returns the bundle to test the password against; onOpen(payload) shows it.
  function mount({ content, getBundle, onOpen }) {
    const lockEl = document.getElementById('lock'), err = document.getElementById('lock-error');
    const pw = document.getElementById('lock-password'), btn = document.getElementById('lock-submit');
    const ui = {
      show(msg) {
        content.hidden = true; lockEl.hidden = false;
        err.textContent = msg || ''; err.hidden = !msg;
        if (document.activeElement !== pw) pw.focus();
      },
      hide() { lockEl.hidden = true; content.hidden = false; },
    };
    document.getElementById('lock-form').addEventListener('submit', async e => {
      e.preventDefault();
      btn.disabled = true; btn.textContent = 'Unlocking…'; err.hidden = true;
      let msg = null;
      try {
        const bundle = await getBundle();
        if (!bundle) msg = 'The dashboard data could not be loaded. Try again in a few minutes.';
        else {
          let payload = null;
          try { payload = await unlock(bundle, pw.value, document.getElementById('lock-remember').checked); } catch (x) { msg = 'That password didn’t unlock the dashboard.'; }
          if (payload) { pw.value = ''; ui.hide(); onOpen(payload, bundle); }
        }
      } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
      if (msg) { err.textContent = msg; err.hidden = false; pw.select(); }
    });
    document.querySelectorAll('[data-lock-now]').forEach(b => b.addEventListener('click', () => { forget(); location.reload(); }));
    return ui;
  }

  return { fetchBundle, open, unlock, forget, mount };
})();
