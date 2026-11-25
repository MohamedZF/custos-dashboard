// Custos V12 Sigfox frame decoder (12 bytes, MSB first; first 2 bits: 00 position, 01 activity,
// 10 health, 11 start-up). A line-for-line port of TAG-CODE tools/custos_frames.py, which follows the
// packing in nRF/gps_monitor/src/frames.c (frames agreed 2026-11-16). Checked against the Python decoder
// on 5,007 frames. Used by the tag2 page in the browser and by scripts/update.mjs in Node.
(function (root, factory) {
  const C = factory();
  if (typeof module === 'object' && module.exports) module.exports = C; else root.CustosFrames = C;
})(typeof self !== 'undefined' ? self : this, () => {
  const LAT_MIN = -35.5, LAT_SPAN = 14.5, LON_MIN = 16.0, LON_SPAN = 17.5, BOX_MAX = 0xFFFFE;
  const FIX = ["FIX", "FIX_POOR", "NO_FIX", "NO_SKY"];
  const TESTS = ["GPS", "SD", "acc", "flash", "LSM", "PMIC"];
  const START = ["first power-on", "power loss or brown-out", "watchdog", "firmware update",
    "after a Bluetooth visit", "reset button", "other", "by hand"];
  const SD = ["done", "partial", "failed", "no card"];
  const MORT = ["normal", "suspected", "confirmed", "moved again"];
  const STILL_MIN = [0, 15, 30, 60, 120, 180, 240, 360, 480, 600, 720, 960, 1200, 1440, 2160, 2880];

  function bits(bytes) {
    let v = 0n;
    for (const x of bytes) v = (v << 8n) | BigInt(x);
    let left = bytes.length * 8;
    return { take(n) { left -= n; return Number((v >> BigInt(left)) & ((1n << BigInt(n)) - 1n)); } };
  }
  const r6 = x => Math.round(x * 1e6) / 1e6;
  function pos(b) {
    const y = b.take(20), x = b.take(20);
    if (y === 0xFFFFF && x === 0xFFFFF) return null;
    return [r6(LAT_MIN + y / BOX_MAX * LAT_SPAN), r6(LON_MIN + x / BOX_MAX * LON_SPAN)];
  }
  const p2 = n => String(n).padStart(2, "0");
  function when(b) {
    const mo = b.take(4), d = b.take(5), h = b.take(5), mi = b.take(6);
    return mo ? `${p2(mo)}-${p2(d)} ${p2(h)}:${p2(mi)} UTC` : null;
  }
  const noneIf = (v, none, f) => (v === none ? null : f(v));
  const mv8 = v => 2500 + 10 * v;
  function tests(v) {
    const o = {};
    TESTS.forEach((n, i) => { o[n] = ((v >> (5 - i)) & 1) === 1; });
    return o;
  }

  function decode(bytes) {
    const b = bits(bytes);
    const kind = b.take(2);
    let f;
    if (kind === 0) {
      f = { type: "position" };
      f.fix_time = when(b);
      f.position = pos(b);
      f.fix = FIX[b.take(2)];
      f.hdop = b.take(3);
      f.ttf_s = b.take(7);
      f.act_median = b.take(3); f.act_max = b.take(3);
      f.battery_mv = 2700 + 100 * b.take(4);
      f.tests = tests(b.take(6));
      f.mortality = MORT[b.take(2)];
      f.still_min_at_least = STILL_MIN[b.take(4)];
    } else if (kind === 1) {
      f = { type: "acc", hour_end: when(b) };
      const lo = [0, 1, 2, 3].map(() => noneIf(b.take(5), 31, v => v * 6 - 90));
      const hi = [0, 1, 2, 3].map(() => noneIf(b.take(5), 31, v => v * 6 - 90));
      const roll = [0, 1, 2, 3].map(() => noneIf(b.take(4), 15, v => v * 24 - (v > 7 ? 360 : 0)));
      const act = [0, 1, 2, 3].map(() => b.take(3));
      f.pitch_min_deg = lo; f.pitch_max_deg = hi; f.roll_deg = roll;
      f.act_median = act.map((a, i) => (lo[i] !== null ? a : null));
      f.turns = b.take(6);
    } else if (kind === 2) {
      f = { type: "health", cycle_end: when(b) };
      f.supply_mv = mv8(b.take(8));
      f.supply_min_mv = mv8(b.take(8));
      f.level = b.take(3);
      f.temp_c = b.take(6);
      f.tests = tests(b.take(6));
      f.errors = b.take(4);
      f.last_error = b.take(6);
      f.days_waiting = b.take(4);
      f.last_sd = SD[b.take(2)];
      f.days_since_sd = b.take(5);
      const free = b.take(7);
      f.sd_free_pct = free === 127 ? null : free;
      f.gps_misses = b.take(4);
      f.restarts = b.take(4);
      f.visits = b.take(2);
      f.mortality = MORT[b.take(2)];
      const h = b.take(3);
      f.still_min_last_hour = h === 7 ? 60 : h ? `up to ${h * 10}` : 0;
    } else {
      f = { type: "start-up", sent: when(b) };
      f.reason = START[b.take(3)];
      f.tests = tests(b.take(6));
      f.fix = FIX[b.take(2)];
      f.ttf_s = b.take(7) * 5;
      f.position = pos(b);
      f.battery_mv = 2700 + 100 * b.take(4);
      f.firmware = b.take(6);
      f.config = b.take(6);
    }
    return f;
  }

  function hexToBytes(h) {
    const out = [];
    for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
    return out;
  }
  return { decode, hexToBytes, FIX, TESTS };
});
