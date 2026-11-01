// Transport logic checks — run: node test/check-deck.js
const assert = require('assert');
const D = require('../deck.js');

const tr = (name, min) => ({ name, dur: min * 60 });

// 1. Side lengths
assert.deepStrictEqual(Object.values(D.TAPES).map((t) => t.sideSec / 60), [23, 30, 45, 60]);

// 2. Layout: leader, then tracks separated by gaps
const L = D.layout([tr('a', 3), tr('b', 4)]);
assert.strictEqual(L.segs[0].start, D.LEADER);
assert.strictEqual(L.segs[1].start, D.LEADER + 180 + D.GAP);
assert.strictEqual(L.used, D.LEADER + 180 + D.GAP + 240);

// 3. Assignment fills A, then B, then rejects
const songs = Array.from({ length: 12 }, (_, i) => tr('s' + i, 5));      // 12 x 5 min = 60 min
const C60 = D.TAPES.C60.sideSec;
const r = D.assign({ A: [], B: [] }, songs, C60);
assert.strictEqual(r.sides.A.length, 5);   // 5 + 5*5min + 4*4s = 25:21 ; a 6th would need 30:25
assert.strictEqual(r.sides.B.length, 5);
assert.strictEqual(r.rejected.length, 2);
const r120 = D.assign({ A: [], B: [] }, songs, D.TAPES.C120.sideSec);
assert.strictEqual(r120.rejected.length, 0);

// 4. Shortening the tape moves overflow and reports what no longer fits
const back = D.refit(r120.sides, D.TAPES.C46.sideSec);
assert(back.sides.A.length <= 4 && back.rejected.length > 0);

// 5. Locate / music search
const segs = L.segs;
assert.strictEqual(D.locate(segs, 2).kind, 'gap');
assert.deepStrictEqual(D.locate(segs, D.LEADER + 10), { kind: 'track', index: 0, offset: 10 });
assert.strictEqual(D.locate(segs, D.LEADER + 181).kind, 'gap');
assert.strictEqual(D.nextStart(segs, D.LEADER + 10), segs[1].start);
assert.strictEqual(D.nextStart(segs, segs[1].start + 5), null);
assert.strictEqual(D.prevStart(segs, segs[1].start + 30), segs[1].start);   // restart current track
assert.strictEqual(D.prevStart(segs, segs[1].start + 1), segs[0].start);    // early: previous track

// 6. Flipping keeps the physical spot on the tape
assert.strictEqual(D.flipPos(600, C60), 1200);
assert.strictEqual(D.flipPos(C60, C60), 0);

// 7. Reels: take-up grows, supply shrinks, sizes plausible (C-60 full pack ~ 2.5 cm radius)
const a = D.reels('C60', 0), b = D.reels('C60', C60 / 2), c = D.reels('C60', C60);
assert(Math.abs(a.takeup - a.hub) < 1e-9 && Math.abs(c.supply - c.hub) < 1e-9);
assert(b.takeup > a.takeup && b.supply < a.supply);
assert(a.full > 0.022 && a.full < 0.028, `C-60 pack radius ${a.full}`);
assert(D.omega(a.hub) > D.omega(a.full), 'small reel turns faster');

// 8. Tags
const enc = (s) => Buffer.from(s, 'utf8');
function id3v23(frames) {               // ID3v2.3 with UTF-8 (enc 3) text frames
  const body = Buffer.concat(frames.map(([id, s, e = 3]) => {
    const txt = e === 0 ? s : enc(s), data = Buffer.concat([Buffer.from([e]), txt]);
    const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(data.length, 4);
    return Buffer.concat([h, data]);
  }));
  const n = body.length, hdr = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  return new Uint8Array(Buffer.concat([hdr, body]));
}
let tg = D.parseTags(id3v23([['TPE1', '山下達郎'], ['TIT2', 'RIDE ON TIME']]), null, 'x.mp3');
assert.deepStrictEqual(tg, { artist: '山下達郎', title: 'RIDE ON TIME' });
// Shift_JIS in an ISO-8859-1 frame (common in older Japanese files): 'あ' = 0x82 0xA0
tg = D.parseTags(id3v23([['TPE1', Buffer.from([0x82, 0xa0, 0x82, 0xa2]), 0]]), null, 'y.mp3');
assert.strictEqual(tg.artist, 'あい');
// FLAC Vorbis comment
const vc = (() => {
  const vendor = enc('ref'), items = ['ARTIST=Chet Baker', 'TITLE=Alone Together'].map(enc);
  const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)]; parts[0].writeUInt32LE(vendor.length); parts[2].writeUInt32LE(items.length);
  items.forEach((it) => { const l = Buffer.alloc(4); l.writeUInt32LE(it.length); parts.push(l, it); });
  const body = Buffer.concat(parts), h = Buffer.from([0x84, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]);
  return new Uint8Array(Buffer.concat([enc('fLaC'), h, body]));
})();
assert.deepStrictEqual(D.parseTags(vc, null, 'z.flac'), { artist: 'Chet Baker', title: 'Alone Together' });
// file-name fallback
assert.deepStrictEqual(D.parseTags(new Uint8Array(16), null, '03 Bill Evans - Waltz for Debby.mp3'), { artist: 'Bill Evans', title: 'Waltz for Debby' });
assert.deepStrictEqual(D.parseTags(new Uint8Array(16), null, '05. Untitled.wav'), { artist: '', title: 'Untitled' });
// label caption
assert.strictEqual(D.sideCaption([{ artist: 'A' }, { artist: 'A' }]).artist, 'A');
assert.strictEqual(D.sideCaption([{ artist: 'A' }, { artist: 'B' }]).artist, 'A / B');
assert.strictEqual(D.sideCaption([{ artist: 'A' }, { artist: 'B' }, { artist: 'C' }]).artist, 'A ほか');
assert(D.LABELS.includes(D.LABELS.find((l) => l.paper === D.randomLabel(() => 0.99).paper)));

console.log(`OK  deck: C-60 pack radius ${(a.full * 100).toFixed(2)} cm, C-120 ${(D.reels('C120', 0).full * 100).toFixed(2)} cm`);
