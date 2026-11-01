// Sanity checks — run: node test/check-model.js
const assert = require('assert');
const C = require('../cassette.js');

const base = { tape: 'I', dolbyTape: false, dolbyDecode: true, wfScale: 1, hissOffset: 0, recLevel: 0 };
const cfg = (o) => C.config({ ...base, ...o });

// 1. Frequency response: -3 dB points sit near the stated ranges
const edge = (c, lo, hi) => {
  let fl = null, fh = null;
  for (let f = 15; f < 24000; f *= 1.01) {
    const v = C.responseDb(c, f);
    if (fl === null && v > -3) fl = f;
    if (fl !== null && f > 1000 && v < -3 && fh === null) fh = f;
  }
  assert(fl > lo[0] && fl < lo[1], `low edge ${fl.toFixed(0)} Hz`);
  assert(fh > hi[0] && fh < hi[1], `high edge ${fh.toFixed(0)} Hz`);
  return [fl, fh];
};
for (const [p, t, lo, hi] of [
  ['budget', 'I', [40, 60], [9000, 11500]], ['budget', 'II', [40, 60], [11000, 13500]],
  ['budget', 'III', [40, 60], [11500, 14000]], ['budget', 'IV', [40, 60], [12000, 15000]],
  ['premium', 'I', [15, 25], [16500, 19500]], ['premium', 'II', [15, 25], [19000, 22000]],
  ['premium', 'III', [15, 25], [18000, 21000]], ['premium', 'IV', [15, 25], [20000, 23000]],
]) {
  const [fl, fh] = edge(cfg({ player: p, tape: t }), lo, hi);
  console.log(`${p.padEnd(7)} ${t.padEnd(2)} ${fl.toFixed(0)} Hz – ${(fh / 1000).toFixed(1)} kHz`);
}
assert(Math.abs(C.responseDb(cfg({ player: 'budget' }), 1000)) < 0.5, '1 kHz reference level');

// 2. Wow & flutter components add up to the stated WRMS figure
for (const p of ['budget', 'premium']) {
  const c = cfg({ player: p });
  const rms = Math.sqrt(c.wow.peak ** 2 / 2 + c.flutter.peak ** 2 / 2 + c.random.rms ** 2) * 100;
  assert(Math.abs(rms - C.PLAYERS[p].wf) < 1e-9, `${p} W&F`);
}

// 3. Random drift: unit-rms derivative and a seamless loop
const d = C.randomDrift();
const rms = Math.sqrt(d.dev.reduce((s, v) => s + v * v, 0) / d.dev.length);
assert(Math.abs(rms - 1) < 0.02, `drift rms ${rms}`);
assert(Math.abs(d.tau[0] - d.tau[d.tau.length - 1]) < 1e-3, 'drift loop seam');

// 4. Azimuth: budget mono sum nulls near 1 / (2 * 73 us), premium stays flat
assert(C.monoDb(cfg({ player: 'budget' }), 6850) < -25, 'budget mono null');
assert(C.monoDb(cfg({ player: 'premium' }), 6850) > -1, 'premium mono flat');

// 5. Dolby: budget cannot decode, premium can; undecoded tape is brighter
assert(cfg({ player: 'budget', dolbyTape: true }).bright === true);
assert(cfg({ player: 'premium', dolbyTape: true }).decode === true);
assert(C.responseDb(cfg({ player: 'premium', dolbyTape: true, dolbyDecode: false }), 8000) > 4, 'undecoded lift');

// 6. Saturation reaches ~3 % THD at the maximum output level
const c = cfg({ player: 'budget' });
const x = Math.pow(10, (C.REF_DBFS + c.tape.mol) / 20);
assert(Math.abs((c.satA * x) ** 2 / 12 - 0.03) < 1e-9, 'MOL calibration');

// 7. Metal tape: most headroom, least high-frequency pre-emphasis into the saturator
for (const p of ['budget', 'premium']) {
  const T = C.PLAYERS[p].tapes;
  assert(T.IV.mol > T.III.mol && T.III.mol > T.II.mol && T.II.mol >= T.I.mol, `${p} MOL order`);
  assert(T.IV.emph < T.II.emph && T.II.emph < T.I.emph, `${p} emphasis order`);
}

// 8. Ageing: monotonic with years, and off means no change
const a10 = C.ageing(10), a30 = C.ageing(30), a50 = C.ageing(50), a0 = C.ageing(0);
assert(!a0.on && a0.shelf.gain === 0 && a0.wfFactor === 1, 'new tape unchanged');
assert(a10.shelf.gain > a30.shelf.gain && a30.shelf.gain > a50.shelf.gain, 'HF loss grows');
assert(a10.dropRate < a30.dropRate && a30.dropRate < a50.dropRate, 'dropout rate grows');
assert(a10.printDb < a50.printDb && a50.printDb < -30, 'print-through grows, stays faint');
const fresh = cfg({ player: 'premium', tape: 'II' }), old = cfg({ player: 'premium', tape: 'II', age: 50 });
assert(C.responseDb(fresh, 10000) - C.responseDb(old, 10000) > 6, '50-year tape loses treble');
assert(old.wfPct > fresh.wfPct, 'stretched tape wobbles more');
// 9. dbx: only the premium deck decodes; decoding doubles tape errors, adds ~30 dB S/N
const dbxP = cfg({ player: 'premium', tape: 'II', nr: 'dbx', nrDecode: true });
const dbxB = cfg({ player: 'budget', tape: 'II', nr: 'dbx', nrDecode: true });
assert(dbxP.dbxDec && !dbxB.dbxDec && dbxB.dbxEnc, 'dbx decode availability');
assert(dbxP.snEff - cfg({ player: 'premium', tape: 'II' }).snEff === 30, 'dbx +30 dB');
const plain = cfg({ player: 'budget', tape: 'I' }), enc = cfg({ player: 'budget', tape: 'I', nr: 'dbx', nrDecode: true });
assert(C.responseDb(enc, 8000) - C.responseDb(plain, 8000) > 7, 'undecoded dbx is bright');
const decB = { ...cfg({ player: 'premium', tape: 'I', age: 50 }) }, decD = cfg({ player: 'premium', tape: 'I', age: 50, nr: 'dbx', nrDecode: true });
assert(Math.abs(C.responseDb(decD, 10000) - 2 * C.responseDb(decB, 10000)) < 1e-9, 'dbx doubles tape error');

// 10. Dolby B / C / S: noise reduction 10 / 20 / 24 dB, laws monotonic (decodable), S also acts on bass
for (const [k, sn] of [['dolby-b', 10], ['dolby-c', 20], ['dolby-s', 24]]) {
  const d = cfg({ player: 'premium', tape: 'II', nr: k, nrDecode: true });
  assert(d.decode && d.snEff - cfg({ player: 'premium', tape: 'II' }).snEff === sn, `${k} S/N`);
  for (const sh of C.NR[k].shelves) {
    let prev = -Infinity;
    for (let x = -140; x <= 40; x += 0.05) { const y = x + C.boostDb(sh, x); assert(y > prev, `${k} law not monotonic`); prev = y; }
  }
  assert(cfg({ player: 'budget', tape: 'II', nr: k, nrDecode: true }).bright, `${k} undecoded on budget`);
}
assert(C.NR['dolby-s'].shelves.some((s) => s.type === 'LS'), 'Dolby S low-frequency stage');

console.log(`ageing 10/30/50 y: HF ${a10.shelf.gain.toFixed(1)}/${a30.shelf.gain.toFixed(1)}/${a50.shelf.gain.toFixed(1)} dB, dropouts ${(a10.dropRate * 60).toFixed(0)}/${(a30.dropRate * 60).toFixed(0)}/${(a50.dropRate * 60).toFixed(0)} per min`);

console.log('\nOK  cassette model');
