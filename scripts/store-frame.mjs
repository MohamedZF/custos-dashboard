#!/usr/bin/env node
// Adds one Sigfox frame (from the backend's callback, via a GitHub repository_dispatch) to the encrypted
// frame store: FRAMES_DIR/<ID>.enc.json = { device, frames: [{ time, seq, data, rssi, snr, station }] }.
// Env: PAYLOAD (the dispatch's client_payload as JSON), SITE_PASSWORD, FRAMES_DIR (default _frames/frames).
// Frames from devices not in sigfox_tags.txt are ignored; repeats of a frame are stored once.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encrypt, decrypt, sigfoxTags, normId } from './sitecrypto.mjs';

const KEEP_DAYS = 62;
const OUT = process.env.FRAMES_DIR || '_frames/frames';
const PASSWORD = process.env.SITE_PASSWORD || '';
function fail(msg) { console.error('ERROR: ' + msg); if (process.env.GITHUB_ACTIONS) console.log('::error::' + msg); process.exit(1); }
if (!PASSWORD) fail('SITE_PASSWORD is not set. Add it as a repository secret.');

let p;
try { p = JSON.parse(process.env.PAYLOAD || ''); } catch (e) { fail('The callback body is not JSON. Check the Sigfox callback body.'); }
const num = v => (v === null || v === undefined || v === '' || isNaN(+v) ? null : +v);
const f = {
  time: num(p.time), seq: num(p.seq), data: String(p.data ?? '').toLowerCase(),
  rssi: num(p.rssi), snr: num(p.snr), station: /^[0-9A-Fa-f]{1,8}$/.test(String(p.station ?? '')) ? String(p.station).toUpperCase() : null,
};
const dev = normId(p.device ?? '');
if (!/^[0-9A-F]{1,8}$/.test(dev)) fail(`Bad device ID in the callback: ${JSON.stringify(p.device)}`);
if (!f.time || f.time < 1.6e9 || f.time > Date.now() / 1000 + 3600) fail(`Bad time in the callback: ${JSON.stringify(p.time)} (expected Unix seconds)`);
if (!/^([0-9a-f]{2}){0,12}$/.test(f.data)) fail(`Bad data in the callback: ${JSON.stringify(p.data)}`);
const tags = await sigfoxTags();
if (!tags.some(t => t.id === dev)) { console.log(`Frame from ${dev} ignored: not in sigfox_tags.txt`); process.exit(0); }

const file = join(OUT, `${dev}.enc.json`);
let store = { device: dev, frames: [] };
try { store = await decrypt(await readFile(file, 'utf8'), PASSWORD); }
catch (e) { if (e.code !== 'ENOENT') fail(`Could not open the stored frames for ${dev} (has SITE_PASSWORD changed?): ${e.message}`); }

if (store.frames.some(x => x.time === f.time && x.seq === f.seq)) { console.log(`${dev}: frame seq ${f.seq} already stored`); process.exit(0); }
store.frames.push(f);
const cut = Date.now() / 1000 - KEEP_DAYS * 86400;
store.frames = store.frames.filter(x => x.time >= cut).sort((a, b) => a.time - b.time);
await mkdir(OUT, { recursive: true });
await writeFile(file, await encrypt(store, PASSWORD));
console.log(`${dev}: stored frame seq ${f.seq} at ${new Date(f.time * 1000).toISOString()} (${f.data || 'no data'}); ${store.frames.length} frames kept`);
