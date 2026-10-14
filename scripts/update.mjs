#!/usr/bin/env node
// Fetches Custos tag data from Field Signal and writes the dashboard's data files.
// Env: FIELD_SIGNAL_PASSCODE (required), FIELD_SIGNAL_URL, DEVICE_ID, DEVICE_NAME, OUT_DIR, DAYS
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = (process.env.FIELD_SIGNAL_URL || 'https://field-signal-sigfox.johanm226618.chatgpt.site').replace(/\/$/, '');
const PASSCODE = (process.env.FIELD_SIGNAL_PASSCODE || '').trim();
const DEV = process.env.DEVICE_ID || '3B4D874';
const NAME = process.env.DEVICE_NAME || 'Custos 11.5SAC';
const OUT = process.env.OUT_DIR || '_site/data';
const DAYS = Number(process.env.DAYS || 35);
const UA = 'custos-dashboard-updater/1.0 (+GitHub Actions)';

function fail(msg) { console.error('ERROR: ' + msg); if (process.env.GITHUB_ACTIONS) console.log('::error::' + msg); process.exit(1); }
if (!PASSCODE) fail('FIELD_SIGNAL_PASSCODE is not set. Add it as a repository secret.');

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
    if (/incorrect|invalid|wrong|try again/i.test(msg)) fail('Field Signal rejected the passcode. Re-enter the FIELD_SIGNAL_PASSCODE secret.');
    if (/challenge-platform|cf-chl|Just a moment/i.test(text) || res.status === 403) fail(`Field Signal's Cloudflare protection blocked the sign-in (HTTP ${res.status}). The site owner needs to allow this client.`);
    fail(`Sign-in failed (HTTP ${res.status}). Check that FIELD_SIGNAL_PASSCODE is correct.`);
  }
  return cookies.join('; ');
}

async function exportCsv(cookie) {
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
function compute(text) {
  if (text.trim().split('\n').length < 2) fail('Export contained no messages for device ' + DEV);
  const rows = text.trim().split('\n').slice(1).map(l => l.replace(/\r$/, '').slice(1, -1).split('","'));
  const P = rows.map(r => { const s = new Date(new Date(r[2]).getTime() + 2 * 3600e3); const iso = s.toISOString(); return {
    sast: iso.slice(0, 16).replace('T', ' '), day: iso.slice(0, 10), hr: s.getUTCHours(), hk: iso.slice(0, 13), utc: r[2],
    seq: +r[5], lat: r[7] === '' ? null : +r[7], lon: r[8] === '' ? null : +r[8], hdop: +r[9], bat: +r[10], temp: +r[11], acc: +r[12], ttf: +r[13],
    r1: r[15] === '' ? null : +r[15], miss: +r[20] }; }).sort((a, b) => a.utc < b.utc ? -1 : 1);
  const med = a => { if (!a.length) return ''; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const r2 = x => Math.round(x * 100) / 100;
  const fix = p => p.lat !== null && p.hdop !== 99;
  const win = h => h >= 5 && h < 9 ? 'Morning' : h >= 9 && h < 17 ? 'Day' : h >= 17 && h < 20 ? 'Dusk' : 'Night';
  const grp = (arr, k) => { const g = new Map(); arr.forEach(p => { const key = typeof k === 'function' ? k(p) : p[k]; if (!g.has(key)) g.set(key, []); g.get(key).push(p); }); return g; };
  const first = P[0], last = P[P.length - 1], fixes = P.filter(fix);
  const expected = last.seq - first.seq + 1;
  const S = {
    device_id: DEV, name: NAME, messages: P.length, first_message_sast: first.sast, last_message_sast: last.sast,
    seq_first: first.seq, seq_last: last.seq, missing_messages: expected - P.length, expected_messages: expected,
    delivery_pct: Math.round(P.length / expected * 1000) / 10, gps_fixes: fixes.length, no_fix: P.length - fixes.length,
    ttf_median_s: med(fixes.map(p => p.ttf)), ttf_over_60s: P.filter(p => p.ttf > 60).length,
    battery_v_latest: last.bat, battery_v_min: Math.min(...P.map(p => p.bat)), battery_v_max: Math.max(...P.map(p => p.bat)),
    temp_c_avg: r2(avg(P.map(p => p.temp))), temp_c_min: Math.min(...P.map(p => p.temp)), temp_c_max: Math.max(...P.map(p => p.temp)),
    msgs_with_activity: P.filter(p => p.acc > 0).length, activity_sum: P.reduce((s, p) => s + p.acc, 0),
    tower_readings_above_minus140: P.filter(p => p.r1 !== null && p.r1 > -140).length,
    latest_lat: last.lat === null ? '' : last.lat.toFixed(6), latest_lon: last.lon === null ? '' : last.lon.toFixed(6),
    latest_hdop: last.hdop, latest_temp_c: last.temp, latest_ttf_s: last.ttf };
  const csv = (cols, data) => cols.join(',') + '\n' + data.map(r => cols.map(c => r[c] === null || r[c] === undefined ? '' : r[c]).join(',')).join('\n') + '\n';
  const summary = csv(Object.keys(S), [S]);
  const byDay = grp(P, 'day');
  const days = []; for (let d = new Date(first.day + 'T00:00:00Z'); d <= new Date(last.day + 'T00:00:00Z'); d = new Date(d.getTime() + 86400e3)) days.push(d.toISOString().slice(0, 10));
  const daily = csv(['date', 'messages', 'missing_before', 'no_fix', 'battery_v_avg', 'battery_v_min', 'battery_v_max', 'temp_c_avg', 'temp_c_min', 'temp_c_max', 'ttf_s_median_fixed', 'msgs_with_activity', 'activity_sum'],
    days.map(d => { const a = byDay.get(d) || []; if (!a.length) return { date: d, messages: 0, missing_before: 0, no_fix: 0, msgs_with_activity: 0, activity_sum: 0 };
      return { date: d, messages: a.length, missing_before: a.reduce((s, p) => s + p.miss, 0), no_fix: a.filter(p => !fix(p)).length,
        battery_v_avg: r2(avg(a.map(p => p.bat))), battery_v_min: Math.min(...a.map(p => p.bat)), battery_v_max: Math.max(...a.map(p => p.bat)),
        temp_c_avg: r2(avg(a.map(p => p.temp))), temp_c_min: Math.min(...a.map(p => p.temp)), temp_c_max: Math.max(...a.map(p => p.temp)),
        ttf_s_median_fixed: med(a.filter(fix).map(p => p.ttf)), msgs_with_activity: a.filter(p => p.acc > 0).length, activity_sum: a.reduce((s, p) => s + p.acc, 0) }; }));
  const hourly = csv(['hour_sast', 'messages', 'battery_v_avg', 'temp_c_avg', 'acc_sum', 'no_fix'],
    [...grp(P, 'hk')].map(([h, a]) => ({ hour_sast: h + ':00', messages: a.length, battery_v_avg: r2(avg(a.map(p => p.bat))), temp_c_avg: r2(avg(a.map(p => p.temp))), acc_sum: a.reduce((s, p) => s + p.acc, 0), no_fix: a.filter(p => !fix(p)).length })));
  const hod = csv(['hour_sast', 'messages', 'temp_c_avg', 'activity_sum'],
    Array.from({ length: 24 }, (_, h) => { const a = P.filter(p => p.hr === h); return { hour_sast: h, messages: a.length, temp_c_avg: a.length ? r2(avg(a.map(p => p.temp))) : '', activity_sum: a.reduce((s, p) => s + p.acc, 0) }; }));
  const loc = new Map(); fixes.forEach(p => { const k = p.lat.toFixed(3) + ',' + p.lon.toFixed(3); if (!loc.has(k)) loc.set(k, { k, n: 0, first: p.sast, last: p.sast, la: 0, lo: 0 }); const o = loc.get(k); o.n++; o.last = p.sast; o.la += p.lat; o.lo += p.lon; });
  const locations = 'grid_cell,fixes,first_seen_sast,last_seen_sast,mean_lat,mean_lon\n' + [...loc.values()].sort((a, b) => b.n - a.n).slice(0, 10)
    .map(o => `"${o.k}",${o.n},${o.first},${o.last},${+(o.la / o.n).toFixed(6)},${+(o.lo / o.n).toFixed(6)}`).join('\n') + '\n';
  const gl = []; for (let i = 1; i < P.length; i++) { const g = Math.round((new Date(P[i].utc) - new Date(P[i - 1].utc)) / 60000); if (g > 270) gl.push({ gap_minutes: g, from_sast: P[i - 1].sast, to_sast: P[i].sast, seq_from: P[i - 1].seq, seq_to: P[i].seq, seq_skipped: P[i].seq - P[i - 1].seq - 1 }); }
  const gaps = csv(['gap_minutes', 'from_sast', 'to_sast', 'seq_from', 'seq_to', 'seq_skipped'], gl.sort((a, b) => b.gap_minutes - a.gap_minutes).slice(0, 10));
  const cell = new Map(); fixes.forEach(p => { const w = win(p.hr); const k = p.lat.toFixed(4) + ',' + p.lon.toFixed(4) + ',' + w; if (!cell.has(k)) cell.set(k, { la: 0, lo: 0, n: 0, a: 0, w }); const o = cell.get(k); o.la += p.lat; o.lo += p.lon; o.n++; o.a += p.acc; });
  const fix_points = 'lat,lon,window,fixes,acc_sum\n' + [...cell.values()].map(o => `${(o.la / o.n).toFixed(5)},${(o.lo / o.n).toFixed(5)},${o.w},${o.n},${o.a}`).join('\n') + '\n';
  const tr = []; let prev = null; fixes.forEach(p => { const k = p.lat.toFixed(3) + ',' + p.lon.toFixed(3); if (k !== prev) { tr.push(`${p.sast},${p.lat.toFixed(5)},${p.lon.toFixed(5)},${win(p.hr)}`); prev = k; } });
  const track = 'time_sast,lat,lon,window\n' + tr.join('\n') + '\n';
  const out = { 'summary.csv': summary, 'daily.csv': daily, 'hourly.csv': hourly, 'hour_of_day.csv': hod, 'locations_top10.csv': locations, 'longest_gaps.csv': gaps, 'fix_points.csv': fix_points, 'track.csv': track };
  return { out, P, first, last };
}

const cookie = await signIn();
const csv = await exportCsv(cookie);
const { out, P, first, last } = compute(csv);
if (!P.length) fail('Export contained no messages for device ' + DEV);
await mkdir(OUT, { recursive: true });
for (const [name, content] of Object.entries(out)) await writeFile(join(OUT, name), content);
const meta = { generatedAt: new Date().toISOString(), device: DEV, name: NAME, messages: P.length, firstMessageSast: first.sast, lastMessageSast: last.sast, source: BASE };
await writeFile(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(`Wrote ${Object.keys(out).length + 1} files to ${OUT}: ${P.length} messages, last ${last.sast} SAST`);
