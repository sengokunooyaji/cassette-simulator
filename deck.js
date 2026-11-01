// ===== Cassette transport model (pure logic, browser + Node) =====
// Tape lengths, A/B side layout, capacity, flipping, reel geometry.
const DECK = (() => {
  // C-number = total minutes for both sides. Base-film thickness sets how big the full reel is.
  const TAPES = {
    C46:  { label: 'C-46',  sideSec: 23 * 60, thick: 18e-6 },
    C60:  { label: 'C-60',  sideSec: 30 * 60, thick: 18e-6 },
    C90:  { label: 'C-90',  sideSec: 45 * 60, thick: 12e-6 },
    C120: { label: 'C-120', sideSec: 60 * 60, thick: 9e-6 },
  };
  const SPEED = 0.0476;      // m/s (1 7/8 ips)
  const HUB_R = 0.011;       // m
  const LEADER = 5;          // s of leader / blank before the first track on each side
  const GAP = 4;             // s of blank between tracks
  const WIND = 24;           // winding speed, x play speed (reserved)

  // Lay a side out on the tape: [{ track, start, end }], plus the time used.
  function layout(tracks) {
    let t = LEADER;
    const segs = tracks.map((tr, i) => {
      const s = { track: tr, start: t, end: t + tr.dur };
      t = s.end + (i < tracks.length - 1 ? GAP : 0);
      return s;
    });
    return { segs, used: tracks.length ? t : 0 };
  }
  // Would `extra` still fit on a side holding `tracks`?
  function fits(tracks, extra, sideSec) {
    return layout([...tracks, extra]).used <= sideSec;
  }
  // Put new tracks on side A while they fit, then on B; the rest is reported as not fitting.
  function assign(sides, newTracks, sideSec) {
    const out = { A: [...sides.A], B: [...sides.B] }, rejected = [];
    for (const tr of newTracks) {
      if (fits(out.A, tr, sideSec)) out.A.push(tr);
      else if (fits(out.B, tr, sideSec)) out.B.push(tr);
      else rejected.push(tr);
    }
    return { sides: out, rejected };
  }
  // After a tape-length change: keep each track on its side while it fits, move overflow to the
  // other side, and report what no longer fits anywhere.
  function refit(sides, sideSec) {
    const out = { A: [], B: [] }, rejected = [];
    for (const s of ['A', 'B']) for (const tr of sides[s]) {
      const o = s === 'A' ? 'B' : 'A';
      if (fits(out[s], tr, sideSec)) out[s].push(tr);
      else if (fits(out[o], tr, sideSec)) out[o].push(tr);
      else rejected.push(tr);
    }
    return { sides: out, rejected };
  }
  // Which segment (or gap) a position falls in.
  function locate(segs, pos) {
    for (let i = 0; i < segs.length; i++) {
      if (pos < segs[i].start) return { kind: 'gap', next: i };
      if (pos < segs[i].end) return { kind: 'track', index: i, offset: pos - segs[i].start };
    }
    return { kind: 'gap', next: segs.length };
  }
  // Music search targets (like AMS / APSS).
  function nextStart(segs, pos) {
    const s = segs.find((g) => g.start > pos + 0.25);
    return s ? s.start : null;
  }
  function prevStart(segs, pos) {
    // within the first 3 s of a track: go to the previous one; otherwise to the start of this one
    let target = null;
    for (const g of segs) { if (g.start < pos - 3) target = g.start; }
    return target ?? LEADER;
  }
  // Turning the cassette over (or reversing direction): the same physical spot on the tape.
  const flipPos = (pos, sideSec) => Math.min(sideSec, Math.max(0, sideSec - pos));

  // Reel radii for a side position: supply reel empties, take-up reel fills.
  function reels(tapeKey, pos) {
    const T = TAPES[tapeKey];
    const len = SPEED * T.sideSec, area = len * T.thick;
    const played = Math.min(1, Math.max(0, pos / T.sideSec));
    const r = (a) => Math.sqrt(HUB_R * HUB_R + a / Math.PI);
    return { hub: HUB_R, full: r(area), takeup: r(area * played), supply: r(area * (1 - played)) };
  }
  // Angular speed (rad/s) of a reel of radius r with the tape moving at `rate` x play speed.
  const omega = (r, rate = 1) => (SPEED * rate) / r;

  // ---------- labels ----------
  // Label stock and pen colours of the era; one pair is drawn at random for each new tape.
  const LABELS = [
    { paper: '#f2ede1', ink: '#1f2a6e' }, { paper: '#fbf7ee', ink: '#1a1a1a' }, { paper: '#cfe3f2', ink: '#1a2340' },
    { paper: '#f6cfd6', ink: '#3a1430' }, { paper: '#f7e27a', ink: '#2a2208' }, { paper: '#cdeedd', ink: '#123d2a' },
    { paper: '#d8c3a5', ink: '#2b1a0c' }, { paper: '#e6dcf3', ink: '#2c1a52' }, { paper: '#ffd8a8', ink: '#5a1d00' },
  ];
  function randomLabel(rnd = Math.random) {
    const L = LABELS[Math.floor(rnd() * LABELS.length)];
    return { ...L, tilt: (rnd() - 0.5) * 0.05, jitter: rnd() * 1000 };
  }

  // ---------- tags: artist / title from the file ----------
  const latin1 = (b) => String.fromCharCode(...b);
  function decodeText(bytes, enc) {
    const td = (label) => { try { return new TextDecoder(label).decode(bytes); } catch (e) { return null; } };
    let s;
    if (enc === 1) s = td('utf-16');
    else if (enc === 2) s = td('utf-16be');
    else if (enc === 3) s = td('utf-8');
    else {
      // ISO-8859-1 by the spec, but Japanese files often hold Shift_JIS here
      const hi = bytes.some((x) => x >= 0x80);
      const u8 = hi ? td('utf-8') : null;
      s = hi ? (u8 && !u8.includes('\ufffd') ? u8 : td('shift_jis') || latin1(bytes)) : latin1(bytes);
    }
    return (s || '').replace(/\u0000.*$/s, '').replace(/^﻿/, '').trim();
  }
  function id3v2(b) {
    if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return {};
    const ver = b[3], size = ((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127);
    let p = 10;
    if (b[5] & 0x40 && ver >= 3) p += ver === 4 ? (((b[10] & 127) << 21) | ((b[11] & 127) << 14) | ((b[12] & 127) << 7) | (b[13] & 127)) : (((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4);
    const end = Math.min(b.length, 10 + size), out = {};
    const want = ver === 2 ? { TP1: 'artist', TT2: 'title' } : { TPE1: 'artist', TIT2: 'title' };
    while (p + (ver === 2 ? 6 : 10) <= end) {
      let id, fs, hl;
      if (ver === 2) { id = latin1(b.subarray(p, p + 3)); fs = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]; hl = 6; }
      else {
        id = latin1(b.subarray(p, p + 4)); hl = 10;
        fs = ver === 4 ? ((b[p + 4] & 127) << 21) | ((b[p + 5] & 127) << 14) | ((b[p + 6] & 127) << 7) | (b[p + 7] & 127)
          : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
      }
      if (!/^[A-Z0-9]{3,4}$/.test(id) || fs <= 0) break;
      if (want[id] && p + hl + fs <= end) out[want[id]] = decodeText(b.subarray(p + hl + 1, p + hl + fs), b[p + hl]);
      p += hl + fs;
    }
    return out;
  }
  function id3v1(t) {
    if (!t || t.length < 128) return {};
    const b = t.subarray(t.length - 128);
    if (latin1(b.subarray(0, 3)) !== 'TAG') return {};
    return { title: decodeText(b.subarray(3, 33), 0), artist: decodeText(b.subarray(33, 63), 0) };
  }
  function flac(b) {
    if (latin1(b.subarray(0, 4)) !== 'fLaC') return {};
    let p = 4;
    const out = {};
    while (p + 4 <= b.length) {
      const last = b[p] & 0x80, type = b[p] & 0x7f, len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
      if (type === 4 && p + 4 + len <= b.length) {
        const dv = new DataView(b.buffer, b.byteOffset + p + 4, len);
        let q = 4 + dv.getUint32(0, true);
        const n = dv.getUint32(q, true); q += 4;
        for (let i = 0; i < n && q + 4 <= len; i++) {
          const l = dv.getUint32(q, true); q += 4;
          const s = new TextDecoder('utf-8').decode(b.subarray(p + 4 + q, p + 4 + q + l)); q += l;
          const m = s.match(/^(ARTIST|TITLE)=(.*)$/i);
          if (m && !out[m[1].toLowerCase()]) out[m[1].toLowerCase()] = m[2].trim();
        }
      }
      if (last) break;
      p += 4 + len;
    }
    return out;
  }
  function mp4(b) {
    const out = {};
    const walk = (s, e, depth) => {
      let p = s;
      while (p + 8 <= e && depth < 8) {
        const size = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0, type = latin1(b.subarray(p + 4, p + 8));
        if (size < 8 || p + size > e) break;
        if (['moov', 'udta', 'ilst'].includes(type)) walk(p + 8, p + size, depth + 1);
        else if (type === 'meta') walk(p + 12, p + size, depth + 1);
        else if (type === '©ART' || type === '©nam') {
          const d = p + 8;
          if (latin1(b.subarray(d + 4, d + 8)) === 'data') out[type === '©ART' ? 'artist' : 'title'] = new TextDecoder('utf-8').decode(b.subarray(d + 16, p + size)).trim();
        }
        p += size;
      }
    };
    walk(0, b.length, 0);
    return out;
  }
  // From the file name: "Artist - Title", "01 Artist - Title", "01. Title"
  function nameTags(filename) {
    const base = filename.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    const noNum = base.replace(/^\d{1,3}[\s.\-_]+/, '');
    const m = noNum.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: noNum || base };
  }
  // head: the first bytes of the file, tail: the last bytes (for ID3v1 / a trailing moov box)
  function parseTags(head, tail, filename) {
    let t = {};
    for (const f of [id3v2, flac, mp4]) { t = f(head); if (t.artist || t.title) break; }
    if (!t.artist && !t.title && tail) { t = id3v1(tail); if (!t.artist && !t.title) t = mp4(tail); }
    const n = nameTags(filename || '');
    return { artist: t.artist || n.artist || '', title: t.title || n.title || '' };
  }
  // What goes on a side's label: the artist(s) and the titles.
  function sideCaption(tracks) {
    const artists = [...new Set(tracks.map((t) => t.artist).filter(Boolean))];
    const artist = !artists.length ? '' : artists.length === 1 ? artists[0] : artists.length === 2 ? artists.join(' / ') : `${artists[0]} ほか`;
    return { artist, titles: tracks.map((t) => t.title || t.name).filter(Boolean).join(' · ') };
  }

  const fmt = (t) => {
    t = Math.max(0, Math.floor(t));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };

  return { LABELS, randomLabel, parseTags, nameTags, sideCaption, TAPES, SPEED, LEADER, GAP, WIND, layout, fits, assign, refit, locate, nextStart, prevStart, flipPos, reels, omega, fmt };
})();
if (typeof module !== 'undefined') module.exports = DECK;
