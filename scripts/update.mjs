#!/usr/bin/env node
// Fetches Custos tag data from Field Signal and writes the dashboard's data files.
// Env: FIELD_SIGNAL_PASSCODE, SITE_PASSWORD (required), FIELD_SIGNAL_URL, TAGS, OUT_DIR
// TAGS lists the tags to publish, one per line or separated by ';', as  DEVICE_ID=Display name
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webcrypto as wc } from 'node:crypto';

const BASE = (process.env.FIELD_SIGNAL_URL || 'https://field-signal-sigfox.johanm226618.chatgpt.site').replace(/\/$/, '');
const PASSCODE = (process.env.FIELD_SIGNAL_PASSCODE || '').trim();
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const TAGS = (process.env.TAGS || '3B4D874=Custos 11.5SAC').split(/[;\n]/).map(t => t.trim()).filter(Boolean).map(t => {
  const [id, ...n] = t.split('='); return { id: id.trim().toUpperCase(), name: (n.join('=').trim() || id.trim()) };
});
const OUT = process.env.OUT_DIR || '_site/data';
const DAYS = 31; // export window; the site shows the last 24 hours, 7 days and 30 days of it
const RANGES = [{ key: '24h', label: 'Past 24 hours', hours: 24, bucket: 'hour' }, { key: '7d', label: 'Past 7 days', hours: 7 * 24, bucket: 'day' }, { key: '30d', label: 'Past 30 days', hours: 30 * 24, bucket: 'day' }];
const UA = 'custos-dashboard-updater/1.0 (+GitHub Actions)';

function fail(msg) { console.error('ERROR: ' + msg); if (process.env.GITHUB_ACTIONS) console.log('::error::' + msg); process.exit(1); }
if (!PASSCODE) fail('FIELD_SIGNAL_PASSCODE is not set. Add it as a repository secret.');
if (!TAGS.length || TAGS.some(t => !/^[0-9A-F]{6,8}$/.test(t.id))) fail('TAGS must list Sigfox device IDs as  ID=Name  (got: ' + (process.env.TAGS || '') + ')');
if (!SITE_PASSWORD) fail('SITE_PASSWORD is not set. Add it as a repository secret so the published data is encrypted.');

// The page derives the same key from the visitor's password: PBKDF2-SHA256 (600k rounds) -> AES-256-GCM.
// One fixed site-wide salt, so a single password (and a remembered key) opens every tag and survives updates.
// The IV is random for every file and every publish.
const KDF_ITERATIONS = 600000;
const enc = new TextEncoder();
const b64 = u => Buffer.from(u).toString('base64');
let saltB, keyP;
async function siteKey() {
  if (!keyP) keyP = (async () => {
    saltB = new Uint8Array(await wc.subtle.digest('SHA-256', enc.encode('custos-dashboard/v2/site'))).slice(0, 16);
    const base = await wc.subtle.importKey('raw', enc.encode(SITE_PASSWORD), 'PBKDF2', false, ['deriveKey']);
    return wc.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: saltB, iterations: KDF_ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  })();
  return keyP;
}
async function encrypt(obj) {
  const key = await siteKey();
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return JSON.stringify({ v: 2, kdf: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: b64(saltB), iv: b64(iv), ct: b64(ct) }) + '\n';
}

async function signIn() {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ passcode: PASSCODE }).toString(),
  });
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(c => c.split(';')[0]).filter(Boolean);
  const where = res.headers.get('location') || '';
  console.log(`Sign-in: HTTP ${res.status}${where ? ' -> ' + where : ''}; cookies set: ${cookies.map(c => c.split('=')[0]).join(', ') || 'none'}`);
  if (/error/i.test(where)) fail('Field Signal rejected the passcode. Check the FIELD_SIGNAL_PASSCODE secret (re-paste it with no extra spaces).');
  const session = cookies.filter(c => !/^(__cf_bm|cf_clearance|__cflb|_cfuvid)=/.test(c));
  if (!session.length) {
    const text = await res.text().catch(() => '');
    const msg = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('Sign-in page says: ' + msg.slice(0, 300));
    if (/not accepted|incorrect|invalid|wrong|try again/i.test(msg)) fail('Field Signal rejected the passcode. Re-enter the FIELD_SIGNAL_PASSCODE secret.');
    if (/cf-chl|Just a moment|Attention Required/i.test(text) || res.status === 403) fail(`Field Signal's Cloudflare protection blocked the sign-in (HTTP ${res.status}). The site owner needs to allow this client.`);
    fail(`Sign-in failed (HTTP ${res.status}). Check that FIELD_SIGNAL_PASSCODE is correct.`);
  }
  return cookies.join('; ');
}

async function exportCsv(cookie, DEV) {
  const now = Date.now() + 2 * 3600e3;
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - DAYS * 86400e3).toISOString().slice(0, 10);
  const url = `${BASE}/api/export.csv?device=${encodeURIComponent(DEV)}&from=${encodeURIComponent(from + 'T00:00:00+02:00')}&to=${encodeURIComponent(to + 'T23:59:59+02:00')}`;
  const res = await fetch(url, { headers: { Cookie: cookie, 'User-Agent': UA } });
  const text = await res.text();
  if (!res.ok) fail(`Export failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  if (!text.startsWith('"Device ID"')) fail('Export did not return CSV (session not accepted?): ' + text.slice(0, 200));
  return text;
}

// Same calculations as the Claude dashboard's refresh, so both show identical numbers.
// Battery: byte 10 of the 12-byte payload is the raw reading (0-255). Field Signal decodes it as
// 2.5 V + raw x 1.1 / 255 (raw 255 = 3.6 V); this matches the export's 0.1 V column on every message checked.
// Using the raw byte gives ~0.004 V steps instead of 0.1 V. Falls back to the export column if the payload is odd.
const batRaw = payload => /^[0-9a-f]{24}$/i.test(payload) ? parseInt(payload.slice(18, 20), 16) : null;
const batVolts = raw => 2.5 + raw * 1.1 / 255;
const r3 = x => Math.round(x * 1000) / 1000;

// Energy store: a 400 F hybrid supercap, 4.0 V when full. Usable energy is counted above 2.5 V, the bottom of
// the battery scale and the usual lower limit of a hybrid (lithium-ion) capacitor: E = 1/2 C (V^2 - Vmin^2).
// The raw reading tops out at 3.6 V, so energy stored between 3.6 V and 4.0 V cannot be seen.
const CAP_F = Number(process.env.CAP_FARADS || 400), CAP_VMAX = Number(process.env.CAP_VMAX || 4.0), CAP_VMIN = Number(process.env.CAP_VMIN || 2.5);
const capJ = v => 0.5 * CAP_F * (Math.max(v, CAP_VMIN) ** 2 - CAP_VMIN ** 2);
const CAP_USABLE_J = capJ(CAP_VMAX), CAP_VISIBLE_J = capJ(3.6);

function parse(text) {
  if (text.trim().split('\n').length < 2) return [];
  const rows = text.trim().split('\n').slice(1).map(l => l.replace(/\r$/, '').slice(1, -1).split('","'));
  return rows.map(r => { const s = new Date(new Date(r[2]).getTime() + 2 * 3600e3); const iso = s.toISOString(); return {
    sast: iso.slice(0, 16).replace('T', ' '), day: iso.slice(0, 10), hr: s.getUTCHours(), hk: iso.slice(0, 13), utc: r[2],
    seq: +r[5], lat: r[7] === '' ? null : +r[7], lon: r[8] === '' ? null : +r[8], hdop: +r[9], braw: batRaw(r[6]), bat: batRaw(r[6]) === null ? +r[10] : batVolts(batRaw(r[6])), temp: +r[11], acc: +r[12], ttf: +r[13],
    r1: r[15] === '' ? null : +r[15], miss: +r[20] }; }).sort((a, b) => a.utc < b.utc ? -1 : 1);
}

// All figures for one time range. bucket 'hour' gives hourly bars in daily.csv (keys YYYY-MM-DDTHH:00), 'day' daily bars.
function compute(P, DEV, NAME, bucket, span) {
  if (!P.length) return null;
  // GPS quality. HDOP is whole numbers, 99 = no fix. TTF statistics use fixed messages only, because the
  // value reported on a failed attempt depends on the tag's firmware timeout (64 s on most, 0 or 119 s on some).
  const pctl = (a, q) => { if (!a.length) return ''; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const HDOP_BINS = [['Excellent (0–1)', h => h <= 1], ['Good (2–4)', h => h >= 2 && h <= 4], ['Moderate (5–9)', h => h >= 5 && h <= 9], ['Poor (10+)', h => h >= 10 && h !== 99]];
  const TTF_BINS = [['0–4 s', 0, 5], ['5–9 s', 5, 10], ['10–19 s', 10, 20], ['20–29 s', 20, 30], ['30–44 s', 30, 45], ['45–64 s', 45, 65], ['65 s +', 65, 1e9]];
  const gpsq = a => { const f = a.filter(fix); return {
    hdop_median: med(f.map(p => p.hdop)), hdop_mean: f.length ? r2(avg(f.map(p => p.hdop))) : '',
    hdop_excellent_pct: f.length ? Math.round(f.filter(p => p.hdop <= 1).length / f.length * 1000) / 10 : '',
    ttf_mean_s: f.length ? Math.round(avg(f.map(p => p.ttf)) * 10) / 10 : '', ttf_p90_s: pctl(f.map(p => p.ttf), 0.9), ttf_max_fixed_s: f.length ? Math.max(...f.map(p => p.ttf)) : '' }; };
  const med = a => { if (!a.length) return ''; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const r2 = x => Math.round(x * 100) / 100;
  const fix = p => p.lat !== null && p.hdop !== 99;
  const win = h => h >= 5 && h < 9 ? 'Morning' : h >= 9 && h < 17 ? 'Day' : h >= 17 && h < 20 ? 'Dusk' : 'Night';
  const grp = (arr, k) => { const g = new Map(); arr.forEach(p => { const key = typeof k === 'function' ? k(p) : p[k]; if (!g.has(key)) g.set(key, []); g.get(key).push(p); }); return g; };
  const first = P[0], last = P[P.length - 1], fixes = P.filter(fix);
  const expected = last.seq - first.seq + 1;
  // Net energy: change in stored energy between consecutive messages, credited to the later message.
  P.forEach((p, i) => { p.e = capJ(p.bat); p.de = i ? p.e - P[i - 1].e : 0; });
  const spanDays = span ? (span.to - span.from) / 864e5 : 1;
  const netJ = last.e - first.e;
  const S = {
    device_id: DEV, name: NAME, messages: P.length, first_message_sast: first.sast, last_message_sast: last.sast,
    seq_first: first.seq, seq_last: last.seq, missing_messages: expected - P.length, expected_messages: expected,
    delivery_pct: Math.round(P.length / expected * 1000) / 10, gps_fixes: fixes.length, no_fix: P.length - fixes.length,
    ttf_median_s: med(fixes.map(p => p.ttf)), ttf_over_60s: P.filter(p => p.ttf > 60).length, ...gpsq(P),
    no_fix_ttf_median_s: med(P.filter(p => !fix(p)).map(p => p.ttf)),
    battery_v_latest: r2(last.bat), battery_v_min: r2(Math.min(...P.map(p => p.bat))), battery_v_max: r2(Math.max(...P.map(p => p.bat))), battery_raw_latest: last.braw ?? '',
    energy_now_j: Math.round(last.e), energy_soc_pct: Math.round(last.e / CAP_USABLE_J * 1000) / 10, energy_usable_j: Math.round(CAP_USABLE_J), energy_visible_max_j: Math.round(CAP_VISIBLE_J),
    energy_net_j: Math.round(netJ), energy_net_per_day_j: Math.round(netJ / Math.max(1, spanDays)),
    energy_min_j: Math.round(Math.min(...P.map(p => p.e))), energy_max_j: Math.round(Math.max(...P.map(p => p.e))),
    at_ceiling_pct: P.some(p => p.braw != null) ? Math.round(P.filter(p => p.braw >= 254).length / P.length * 1000) / 10 : '',
    cap_farads: CAP_F, cap_vmax: CAP_VMAX, cap_vmin: CAP_VMIN,
    temp_c_avg: r2(avg(P.map(p => p.temp))), temp_c_min: Math.min(...P.map(p => p.temp)), temp_c_max: Math.max(...P.map(p => p.temp)),
    msgs_with_activity: P.filter(p => p.acc > 0).length, activity_sum: P.reduce((s, p) => s + p.acc, 0),
    tower_readings_above_minus140: P.filter(p => p.r1 !== null && p.r1 > -140).length,
    latest_lat: last.lat === null ? '' : last.lat.toFixed(6), latest_lon: last.lon === null ? '' : last.lon.toFixed(6),
    latest_hdop: last.hdop, latest_temp_c: last.temp, latest_ttf_s: last.ttf };
  const csv = (cols, data) => cols.join(',') + '\n' + data.map(r => cols.map(c => r[c] === null || r[c] === undefined ? '' : r[c]).join(',')).join('\n') + (data.length ? '\n' : '');
  const summary = csv(Object.keys(S), [S]);
  const bk = bucket === 'hour' ? p => p.hk + ':00' : p => p.day;
  const byDay = grp(P, bk);
  const days = [];
  const step = bucket === 'hour' ? 3600e3 : 86400e3;
  for (let t = span.from; t < span.to; t += step) days.push(bucket === 'hour' ? new Date(t).toISOString().slice(0, 13) + ':00' : new Date(t).toISOString().slice(0, 10));
  const daily = csv(['date', 'messages', 'missing_before', 'no_fix', 'battery_v_avg', 'battery_v_min', 'battery_v_max', 'temp_c_avg', 'temp_c_min', 'temp_c_max', 'ttf_s_median_fixed', 'msgs_with_activity', 'activity_sum', 'hdop_median', 'hdop_mean', 'hdop_excellent_pct', 'ttf_mean_s', 'ttf_p90_s', 'energy_net_j', 'energy_end_j'],
    days.map(d => { const a = byDay.get(d) || []; if (!a.length) return { date: d, messages: 0, missing_before: 0, no_fix: 0, msgs_with_activity: 0, activity_sum: 0 };
      return { date: d, messages: a.length, missing_before: a.reduce((s, p) => s + p.miss, 0), no_fix: a.filter(p => !fix(p)).length,
        battery_v_avg: r2(avg(a.map(p => p.bat))), battery_v_min: r2(Math.min(...a.map(p => p.bat))), battery_v_max: r2(Math.max(...a.map(p => p.bat))),
        temp_c_avg: r2(avg(a.map(p => p.temp))), temp_c_min: Math.min(...a.map(p => p.temp)), temp_c_max: Math.max(...a.map(p => p.temp)),
        ttf_s_median_fixed: med(a.filter(fix).map(p => p.ttf)), msgs_with_activity: a.filter(p => p.acc > 0).length, activity_sum: a.reduce((s, p) => s + p.acc, 0), ...gpsq(a), energy_net_j: Math.round(a.reduce((s, p) => s + p.de, 0)), energy_end_j: Math.round(a[a.length - 1].e) }; }));
  const hourly = csv(['hour_sast', 'messages', 'battery_v_avg', 'temp_c_avg', 'acc_sum', 'no_fix'],
    [...grp(P, 'hk')].map(([h, a]) => ({ hour_sast: h + ':00', messages: a.length, battery_v_avg: r2(avg(a.map(p => p.bat))), temp_c_avg: r2(avg(a.map(p => p.temp))), acc_sum: a.reduce((s, p) => s + p.acc, 0), no_fix: a.filter(p => !fix(p)).length })));
  // Net power by hour of day: energy change over time between consecutive messages up to 90 min apart,
  // credited to the hour (SAST) of their midpoint.
  const pw = Array.from({ length: 24 }, () => ({ j: 0, s: 0 }));
  for (let i = 1; i < P.length; i++) {
    const t0 = Date.parse(P[i - 1].utc), t1 = Date.parse(P[i].utc), dt = (t1 - t0) / 1000;
    if (dt <= 0 || dt > 90 * 60) continue;
    const h = new Date((t0 + t1) / 2 + 2 * 3600e3).getUTCHours(); pw[h].j += P[i].de; pw[h].s += dt;
  }
  const hod = csv(['hour_sast', 'messages', 'temp_c_avg', 'activity_sum', 'fixes', 'ttf_median_s', 'hdop_mean', 'net_power_mw'],
    Array.from({ length: 24 }, (_, h) => { const a = P.filter(p => p.hr === h), f = a.filter(fix); return { hour_sast: h, messages: a.length, temp_c_avg: a.length ? r2(avg(a.map(p => p.temp))) : '', activity_sum: a.reduce((s, p) => s + p.acc, 0), fixes: f.length, ttf_median_s: med(f.map(p => p.ttf)), hdop_mean: f.length ? r2(avg(f.map(p => p.hdop))) : '', net_power_mw: pw[h].s ? Math.round(pw[h].j / pw[h].s * 1000 * 10) / 10 : '' }; }));
  const gps_quality = csv(['kind', 'bin', 'count', 'pct'], [
    ...HDOP_BINS.map(([bin, t]) => { const c = P.filter(p => fix(p) && t(p.hdop)).length; return { kind: 'hdop', bin, count: c, pct: Math.round(c / P.length * 1000) / 10 }; }),
    { kind: 'hdop', bin: 'No fix', count: P.length - fixes.length, pct: Math.round((P.length - fixes.length) / P.length * 1000) / 10 },
    ...TTF_BINS.map(([bin, lo, hi]) => { const c = fixes.filter(p => p.ttf >= lo && p.ttf < hi).length; return { kind: 'ttf', bin, count: c, pct: fixes.length ? Math.round(c / fixes.length * 1000) / 10 : 0 }; }),
  ]);
  const loc = new Map(); fixes.forEach(p => { const k = p.lat.toFixed(3) + ',' + p.lon.toFixed(3); if (!loc.has(k)) loc.set(k, { k, n: 0, first: p.sast, last: p.sast, la: 0, lo: 0 }); const o = loc.get(k); o.n++; o.last = p.sast; o.la += p.lat; o.lo += p.lon; });
  const locations = 'grid_cell,fixes,first_seen_sast,last_seen_sast,mean_lat,mean_lon\n' + [...loc.values()].sort((a, b) => b.n - a.n).slice(0, 10)
    .map(o => `"${o.k}",${o.n},${o.first},${o.last},${+(o.la / o.n).toFixed(6)},${+(o.lo / o.n).toFixed(6)}`).join('\n') + '\n';
  const gl = []; for (let i = 1; i < P.length; i++) { const g = Math.round((new Date(P[i].utc) - new Date(P[i - 1].utc)) / 60000); if (g > 270) gl.push({ gap_minutes: g, from_sast: P[i - 1].sast, to_sast: P[i].sast, seq_from: P[i - 1].seq, seq_to: P[i].seq, seq_skipped: P[i].seq - P[i - 1].seq - 1 }); }
  const gaps = csv(['gap_minutes', 'from_sast', 'to_sast', 'seq_from', 'seq_to', 'seq_skipped'], gl.sort((a, b) => b.gap_minutes - a.gap_minutes).slice(0, 10));
  const cell = new Map(); fixes.forEach(p => { const w = win(p.hr); const k = p.lat.toFixed(4) + ',' + p.lon.toFixed(4) + ',' + w; if (!cell.has(k)) cell.set(k, { la: 0, lo: 0, n: 0, a: 0, h: 0, t: 0, w }); const o = cell.get(k); o.la += p.lat; o.lo += p.lon; o.n++; o.a += p.acc; o.h += p.hdop; o.t += p.ttf; });
  const fix_points = 'lat,lon,window,fixes,acc_sum,hdop_mean,ttf_mean_s\n' + [...cell.values()].map(o => `${(o.la / o.n).toFixed(5)},${(o.lo / o.n).toFixed(5)},${o.w},${o.n},${o.a},${r2(o.h / o.n)},${Math.round(o.t / o.n)}`).join('\n') + '\n';
  const tr = []; let prev = null; fixes.forEach(p => { const k = p.lat.toFixed(3) + ',' + p.lon.toFixed(3); if (k !== prev) { tr.push(`${p.sast},${p.lat.toFixed(5)},${p.lon.toFixed(5)},${win(p.hr)}`); prev = k; } });
  const track = 'time_sast,lat,lon,window\n' + tr.join('\n') + '\n';
  const battery = 'time_sast,battery_v,battery_raw,energy_j\n' + P.map(p => `${p.sast.replace(' ', 'T')},${r3(p.bat)},${p.braw ?? ''},${Math.round(p.e)}`).join('\n') + '\n';
  const out = { 'summary.csv': summary, 'daily.csv': daily, 'hourly.csv': hourly, 'hour_of_day.csv': hod, 'locations_top10.csv': locations, 'longest_gaps.csv': gaps, 'fix_points.csv': fix_points, 'track.csv': track, 'gps_quality.csv': gps_quality, 'battery.csv': battery };
  return { out, P, first, last };
}

const cookie = await signIn();
await mkdir(OUT, { recursive: true });
const generatedAt = new Date().toISOString();
const index = [];
const now = Date.now();
// Windows in SAST-as-UTC milliseconds (the same shifted clock the tables use): 24 whole hours ending with the
// current hour, or 7 / 30 calendar days ending today.
const nowS = now + 2 * 3600e3;
const windowFor = r => {
  if (r.bucket === 'hour') { const end = Math.floor(nowS / 3600e3) * 3600e3 + 3600e3; return { from: end - r.hours * 3600e3, to: end }; }
  const end = Math.floor(nowS / 86400e3) * 86400e3 + 86400e3; return { from: end - r.hours * 3600e3, to: end };
};
const iso = t => new Date(t).toISOString().slice(0, 16);
const inWin = (p, w) => { const t = Date.parse(p.utc) + 2 * 3600e3; return t >= w.from && t < w.to; };
for (const tag of TAGS) {
  const all = parse(await exportCsv(cookie, tag.id));
  const ranges = {}, counts = [];
  for (const r of RANGES) {
    const w = windowFor(r);
    const res = compute(all.filter(p => inWin(p, w)), tag.id, tag.name, r.bucket, w);
    ranges[r.key] = { label: r.label, bucket: r.bucket, fromSast: iso(w.from), toSast: iso(w.to), messages: res ? res.P.length : 0, files: res ? res.out : null };
    counts.push(`${r.key} ${res ? res.P.length : 0}`);
  }
  const w30 = windowFor(RANGES[2]);
  const m = compute(all.filter(p => inWin(p, w30)), tag.id, tag.name, 'day', w30);
  if (!m) { console.log(`${tag.name} (${tag.id}): no messages in the last 30 days`); index.push({ id: tag.id, name: tag.name, messages: 0 }); continue; }
  const { P, first, last, out } = m;
  const S = d3row(out['summary.csv']);
  index.push({ id: tag.id, name: tag.name, messages: P.length, first_message_sast: first.sast, last_message_sast: last.sast, last_message_utc: last.utc,
    delivery_pct: S.delivery_pct, battery_v_latest: S.battery_v_latest, gps_fixes: S.gps_fixes, temp_c_latest: last.temp, msgs_with_activity: S.msgs_with_activity });
  const meta = { generatedAt, device: tag.id, name: tag.name, lastMessageSast: last.sast, ranges: RANGES.map(r => r.key) };
  await writeFile(join(OUT, `tag-${tag.id}.enc.json`), await encrypt({ meta, ranges }));
  console.log(`${tag.name} (${tag.id}): ${counts.join(', ')} messages; last ${last.sast} SAST`);
}
const home = { generatedAt, days: 30, tags: index };
await writeFile(join(OUT, 'tags.enc.json'), await encrypt(home));
console.log(`Wrote encrypted data for ${index.length} tag(s) to ${OUT}`);

function d3row(csvText) { const [h, v] = csvText.trim().split('\n'); const ks = h.split(','), vs = v.split(','); return Object.fromEntries(ks.map((k, i) => [k, isNaN(+vs[i]) || vs[i] === '' ? vs[i] : +vs[i]])); }
