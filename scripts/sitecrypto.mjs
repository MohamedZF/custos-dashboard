// The site-wide encryption used for every published data file and for the stored Sigfox frames:
// PBKDF2-SHA256 (600k rounds, one fixed site salt) -> AES-256-GCM, random IV per file. The same
// scheme as update.mjs and site/lock.js, so one SITE_PASSWORD opens everything.
import { readFile } from 'node:fs/promises';
import { webcrypto as wc } from 'node:crypto';

const KDF_ITERATIONS = 600000;
const enc = new TextEncoder();
const b64 = u => Buffer.from(u).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
let keyP, saltB;

function siteKey(password) {
  if (!keyP) keyP = (async () => {
    saltB = new Uint8Array(await wc.subtle.digest('SHA-256', enc.encode('custos-dashboard/v2/site'))).slice(0, 16);
    const base = await wc.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return wc.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: saltB, iterations: KDF_ITERATIONS }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  })();
  return keyP;
}

export async function encrypt(obj, password) {
  const key = await siteKey(password);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return JSON.stringify({ v: 2, kdf: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: b64(saltB), iv: b64(iv), ct: b64(ct) }) + '\n';
}

export async function decrypt(text, password) {
  const bundle = JSON.parse(text);
  const key = await siteKey(password);
  const pt = await wc.subtle.decrypt({ name: 'AES-GCM', iv: unb64(bundle.iv) }, key, unb64(bundle.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// The Sigfox tag list (sigfox_tags.txt): [{ id, name }], IDs upper case without leading zeros.
export async function sigfoxTags(path = 'sigfox_tags.txt') {
  let text = '';
  try { text = await readFile(path, 'utf8'); } catch (e) { return []; }
  return text.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean).map(l => {
    const [id, ...n] = l.split('=');
    return { id: normId(id), name: n.join('=').trim() || normId(id) };
  });
}
export const normId = id => String(id).trim().toUpperCase().replace(/^0+(?=.)/, '');
