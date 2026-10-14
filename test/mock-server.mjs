// Local stand-in for Field Signal: form sign-in -> session cookie -> CSV export in the real column format.
import http from 'node:http';

const PASS = 'test-pass';
const HDR = ['Device ID', 'Friendly name', 'Sigfox timestamp', 'Payload hour', 'Payload minute', 'Sequence number', 'Raw payload', 'Latitude', 'Longitude', 'HDOP', 'Battery voltage', 'Temperature', 'ACC', 'TTF', 'Tower 1 ID', 'Tower 1 RSSI', 'Tower 2 ID', 'Tower 2 RSSI', 'Tower 3 ID', 'Tower 3 RSSI', 'Missing messages before this message', 'Delivery percentage'];
const q = v => '"' + String(v) + '"';

function csv() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const lines = [HDR.map(q).join(',')];
  let t = Date.parse('2026-09-28T09:00:00Z'), seq = 67;
  while (t < Date.parse('2026-10-14T16:00:00Z')) {
    const sastH = (new Date(t).getUTCHours() + 2) % 24;
    const day = sastH >= 9 && sastH < 16;
    const site = day && rnd() < 0.6 ? [-26.1852, 28.00093] : [-26.14539, 27.9068];
    const fix = rnd() > 0.25;
    const skipped = rnd() < 0.15 ? Math.floor(rnd() * 4) + 1 : 0;
    seq += 1 + skipped;
    const lat = fix ? (site[0] + (rnd() - 0.5) * 0.0004).toFixed(6) : '';
    const lon = fix ? (site[1] + (rnd() - 0.5) * 0.0004).toFixed(6) : '';
    const acc = day && rnd() < 0.15 ? Math.floor(rnd() * 6) : 0;
    lines.push([ '3B4D874', 'Custos 11.5SAC', new Date(t).toISOString().replace(/\.\d+Z$/, '.000Z'), sastH, 0, seq, 'ab', lat, lon,
      fix ? Math.floor(rnd() * 3) : 99, (3.2 + rnd() * 0.4).toFixed(1), Math.round(6 + 10 * Math.sin((sastH - 6) / 24 * 2 * Math.PI) + 6),
      acc, fix ? Math.floor(rnd() * 40) : 64, '', '', '', '', '', '', skipped, '66.4' ].map(q).join(','));
    t += (8 + rnd() * 6) * 60e3;
  }
  return lines.join('\r\n');
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/login') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const ok = new URLSearchParams(body).get('passcode') === PASS;
      if (!ok) { res.writeHead(303, { Location: '/?error=1' }); return res.end(); }
      res.writeHead(303, { Location: '/dashboard', 'Set-Cookie': 'fs_session=s3cr3t; Path=/; HttpOnly; Secure; SameSite=Lax' }); res.end();
    }); return;
  }
  if (req.url.startsWith('/api/export.csv')) {
    if (!/fs_session=s3cr3t/.test(req.headers.cookie || '')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"Passcode required"}'); }
    res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end(csv());
  }
  res.writeHead(404); res.end();
}).listen(8787, () => console.log('mock on 8787'));
