// ===== Playback-chain correction =====
// Reads a REW measurement export (.txt), an AutoEQ / Equalizer APO ParametricEQ file,
// or an AutoEQ GraphicEQ line, and turns it into a minimum-phase correction filter
// with a boost limit, a frequency range and automatic headroom.
const CORR = (() => {
  const TAU = 2 * Math.PI;
  const FMIN = 10, FMAX = 24000, NPTS = 480;
  const grid = Array.from({ length: NPTS }, (_, i) => FMIN * Math.pow(FMAX / FMIN, i / (NPTS - 1)));

  // Linear interpolation on log-frequency; clamps outside the data range.
  function interpLog(fs, vs, f) {
    if (f <= fs[0]) return vs[0];
    const n = fs.length;
    if (f >= fs[n - 1]) return vs[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (fs[m] <= f) lo = m; else hi = m; }
    const t = Math.log(f / fs[lo]) / Math.log(fs[hi] / fs[lo]);
    return vs[lo] + t * (vs[hi] - vs[lo]);
  }

  // ---------- parsing ----------
  function parse(text) {
    const filters = [], pts = [];
    let graphic = null, preamp = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let m;
      if ((m = line.match(/^GraphicEQ\s*:\s*(.*)$/i))) {
        graphic = m[1].split(';')
          .map((s) => s.trim().split(/\s+/).map(Number))
          .filter((p) => p.length >= 2 && p[0] > 0 && isFinite(p[0]) && isFinite(p[1]))
          .map((p) => [p[0], p[1]]);
        continue;
      }
      if ((m = line.match(/^Preamp\s*:\s*([-+\d.]+)\s*dB/i))) { preamp = +m[1]; continue; }
      if ((m = line.match(/^Filter\s*\d*\s*:\s*ON\s+([A-Z]+)(?:\s+\d+\s*dB)?\s+Fc\s+([\d.]+)\s*Hz(?:\s+Gain\s+([-+\d.]+)\s*dB)?(?:\s+Q\s+([\d.]+))?/i))) {
        filters.push({ type: m[1].toUpperCase(), fc: +m[2], gain: m[3] != null ? +m[3] : 0, q: m[4] != null ? +m[4] : null });
        continue;
      }
      if (/^Filter/i.test(line) || /^[*#;]/.test(line) || /[a-z]{3,}/i.test(line)) continue;
      const nums = line.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (nums.length >= 2 && isFinite(nums[0]) && isFinite(nums[1]) && nums[0] > 0) pts.push([nums[0], nums[1]]);
    }
    if (graphic && graphic.length >= 3) {
      graphic.sort((a, b) => a[0] - b[0]);
      return { kind: 'graphic', points: graphic };
    }
    if (filters.length) return { kind: 'filters', filters, preamp };
    if (pts.length >= 10) {
      pts.sort((a, b) => a[0] - b[0]);
      return { kind: 'measurement', points: pts };
    }
    throw new Error('対応する形式が見つかりません');
  }

  // ---------- biquad magnitude (RBJ cookbook, fs = 48 kHz) ----------
  function biquadDb(fl, f, fs = 48000) {
    const w0 = (TAU * fl.fc) / fs, cw = Math.cos(w0), sw = Math.sin(w0);
    const A = Math.pow(10, fl.gain / 40);
    const Q = fl.q || Math.SQRT1_2;
    const alpha = sw / (2 * Q), sq = 2 * Math.sqrt(A) * alpha;
    let b0, b1, b2, a0, a1, a2;
    switch (fl.type) {
      case 'PK': case 'PEQ':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'LS': case 'LSC':
        b0 = A * ((A + 1) - (A - 1) * cw + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sq);
        a0 = (A + 1) + (A - 1) * cw + sq; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sq; break;
      case 'HS': case 'HSC':
        b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq);
        a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq; break;
      case 'LP': case 'LPQ':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'HP': case 'HPQ':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      default: return 0;
    }
    const w = (TAU * Math.min(f, fs * 0.499)) / fs;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  // ---------- smoothing (power average over a fractional-octave window) ----------
  function smoothWidth(f, mode) {
    if (mode === 'third') return 1 / 3;
    if (mode === 'sixth') return 1 / 6;
    // variable: fine in the room-mode region, broad at high frequencies
    if (f <= 300) return 1 / 6;
    if (f >= 3000) return 1;
    const t = Math.log(f / 300) / Math.log(10);
    return Math.pow(2, Math.log2(1 / 6) * (1 - t));
  }
  function smooth(points, mode) {
    const fs = points.map((p) => p[0]), vs = points.map((p) => p[1]);
    const FN = 2048, fine = [], fineP = [];
    for (let i = 0; i < FN; i++) {
      const f = FMIN * Math.pow(FMAX / FMIN, i / (FN - 1));
      fine.push(Math.log2(f));
      fineP.push(Math.pow(10, interpLog(fs, vs, f) / 10));
    }
    return grid.map((f) => {
      const c = Math.log2(f), h = smoothWidth(f, mode) / 2;
      let acc = 0, n = 0;
      for (let i = 0; i < FN; i++) if (fine[i] >= c - h && fine[i] <= c + h) { acc += fineP[i]; n++; }
      return 10 * Math.log10(n ? acc / n : Math.pow(10, interpLog(fs, vs, f) / 10));
    });
  }

  const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  // opt: { maxBoost (dB), fLo, fHi (Hz), smoothing: 'var'|'third'|'sixth' }
  function build(src, opt) {
    let meas = null, raw;
    if (src.kind === 'measurement') {
      const sm = smooth(src.points, opt.smoothing);
      let acc = 0, n = 0;
      grid.forEach((f, i) => { if (f >= 300 && f <= 3000) { acc += sm[i]; n++; } });
      const ref = acc / n;
      meas = sm.map((v) => v - ref);
      raw = meas.map((v) => -v);
    } else if (src.kind === 'filters') {
      raw = grid.map((f) => src.filters.reduce((a, fl) => a + biquadDb(fl, f), 0));
    } else {
      const fs = src.points.map((p) => p[0]), vs = src.points.map((p) => p[1]);
      raw = grid.map((f) => interpLog(fs, vs, f));
    }
    // fade the correction out over half an octave beyond the chosen range
    const weight = grid.map((f) => smoothstep(2 * Math.log2(f / opt.fLo) + 1) * smoothstep(1 - 2 * Math.log2(f / opt.fHi)));
    const corr = raw.map((v, i) => Math.max(-24, Math.min(opt.maxBoost, v * weight[i])));
    let peak = 0;
    grid.forEach((f, i) => { if (f >= 20 && f <= 20000) peak = Math.max(peak, corr[i]); });
    return { f: grid, meas, corr, headroom: peak, gain: corr.map((v) => v - peak) };
  }

  // ---------- FFT + minimum-phase impulse ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -TAU / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  function ifft(re, im) {
    const n = re.length;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im);
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
  }

  // Minimum-phase impulse via the folded real cepstrum.
  function impulse(c, sr, N = 16384) {
    const half = N / 2, re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k <= half; k++) {
      const f = Math.max(FMIN, (k * sr) / N);
      re[k] = (interpLog(c.f, c.gain, f) * Math.LN10) / 20;
      if (k > 0 && k < half) re[N - k] = re[k];
    }
    ifft(re, im);
    for (let n = 1; n < half; n++) re[n] *= 2;
    for (let n = half + 1; n < N; n++) re[n] = 0;
    im.fill(0);
    fft(re, im);
    for (let k = 0; k < N; k++) {
      const e = Math.exp(re[k]);
      re[k] = e * Math.cos(im[k]); im[k] = e * Math.sin(im[k]);
    }
    ifft(re, im);
    const out = new Float32Array(N), fade = N / 8;
    for (let i = 0; i < N; i++) {
      let v = re[i];
      if (i > N - fade) v *= 0.5 * (1 + Math.cos((Math.PI * (i - (N - fade))) / fade));
      out[i] = v;
    }
    return out;
  }

  // Synthetic REW-style measurement: small bookshelf speaker in a room (for the demo).
  function sampleText() {
    const shape = [
      { type: 'HP', fc: 65, q: 0.9, gain: 0 },
      { type: 'PK', fc: 110, q: 5, gain: 7 },
      { type: 'PK', fc: 230, q: 6, gain: -12 },
      { type: 'PK', fc: 2800, q: 1.8, gain: 2.5 },
      { type: 'HS', fc: 12000, q: 0.7, gain: -3 },
    ];
    let s = '* サンプル測定（合成データ）: 小型ブックシェルフ + 部屋\n* Freq(Hz) SPL(dB) Phase(degrees)\n';
    for (let i = 0; i <= 420; i++) {
      const f = 15 * Math.pow(2, i / 40);
      if (f > 22000) break;
      const ripple = 0.8 * Math.sin(i * 0.9) + 0.5 * Math.sin(i * 2.3 + 1);
      const spl = 82 + shape.reduce((a, fl) => a + biquadDb(fl, f), 0) + (f > 500 ? ripple : 0);
      s += `${f.toFixed(3)} ${spl.toFixed(3)} 0\n`;
    }
    return s;
  }

  return { parse, build, impulse, sampleText, biquadDb, interpLog, grid };
})();
if (typeof module !== 'undefined') module.exports = CORR;
