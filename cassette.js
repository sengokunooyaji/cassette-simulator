// ===== Cassette playback model =====
// Two player classes x two tape types. Values are representative catalogue-level figures of the
// late-1970s/80s era (estimates, not a specific model). All levels are referenced to Dolby level,
// which this model places at -6 dBFS rms: a modern master peaking at 0 dBFS then peaks at about
// +3 dB, the way a recordist would set the level for a loud source.
const CASSETTE = (() => {
  const TAU = 2 * Math.PI;
  const REF_DBFS = -6;
  const bq = (typeof CORR !== 'undefined' ? CORR : require('./correction.js')).biquadDb;

  const PLAYERS = {
    budget: {
      label: '普及モデル', sub: 'ラジカセ／ポータブル級・2ヘッド',
      wf: 0.25,          // % WRMS
      flutterHz: 6.8,    // capstan rotation
      azimuthMin: 15,    // head azimuth error (arc minutes)
      azDelay: 73e-6,    // resulting L/R time offset
      revAzMin: 8,       // extra azimuth error on the reverse side of an auto-reverse head
      dolby: false,
      dbx: false,
      tapes: {
        I:  { range: '50Hz–10kHz', sn: 47, mol: 3, emph: 6, eq: [
          { type: 'HP', fc: 50, q: 0.707 }, { type: 'PK', fc: 85, gain: 2.5, q: 1.2 },
          { type: 'LP', fc: 11000, q: 0.8 }, { type: 'LP', fc: 14500, q: 0.55 } ] },
        II: { range: '50Hz–12kHz', sn: 51, mol: 4, emph: 4.5, eq: [
          { type: 'HP', fc: 50, q: 0.707 }, { type: 'PK', fc: 85, gain: 2.5, q: 1.2 },
          { type: 'LP', fc: 13000, q: 0.8 }, { type: 'LP', fc: 17000, q: 0.55 } ] },
        III: { range: '50Hz–12kHz', sn: 50, mol: 5, emph: 4.5, eq: [
          { type: 'HP', fc: 50, q: 0.707 }, { type: 'PK', fc: 85, gain: 2.5, q: 1.2 },
          { type: 'LP', fc: 12800, q: 0.8 }, { type: 'LP', fc: 16500, q: 0.55 } ] },
        IV: { range: '50Hz–13kHz', sn: 52, mol: 7, emph: 2.5, eq: [
          { type: 'HP', fc: 50, q: 0.707 }, { type: 'PK', fc: 85, gain: 2.5, q: 1.2 },
          { type: 'LP', fc: 14000, q: 0.8 }, { type: 'LP', fc: 18000, q: 0.55 } ] },
      },
    },
    premium: {
      label: '高級モデル', sub: '3ヘッド・クローズドループ級',
      wf: 0.04,
      flutterHz: 10.5,
      azimuthMin: 2,
      azDelay: 10e-6,
      revAzMin: 3,
      dolby: true,       // Dolby B / C / S
      dbx: true,
      tapes: {
        I:  { range: '20Hz–18kHz', sn: 57, mol: 6, emph: 6, eq: [
          { type: 'HP', fc: 20, q: 0.707 }, { type: 'PK', fc: 45, gain: 1.0, q: 1.4 },
          { type: 'LP', fc: 18000, q: 0.707 }, { type: 'PK', fc: 1000, gain: 0, q: 1 } ] },
        II: { range: '20Hz–20kHz', sn: 60, mol: 7, emph: 4.5, eq: [
          { type: 'HP', fc: 20, q: 0.707 }, { type: 'PK', fc: 45, gain: 1.0, q: 1.4 },
          { type: 'LP', fc: 20500, q: 0.707 }, { type: 'PK', fc: 1000, gain: 0, q: 1 } ] },
        III: { range: '20Hz–19kHz', sn: 59, mol: 8, emph: 4.5, eq: [
          { type: 'HP', fc: 20, q: 0.707 }, { type: 'PK', fc: 45, gain: 1.0, q: 1.4 },
          { type: 'LP', fc: 19500, q: 0.707 }, { type: 'PK', fc: 1000, gain: 0, q: 1 } ] },
        IV: { range: '20Hz–21kHz', sn: 61, mol: 11, emph: 2.5, eq: [
          { type: 'HP', fc: 20, q: 0.707 }, { type: 'PK', fc: 45, gain: 1.0, q: 1.4 },
          { type: 'LP', fc: 21000, q: 0.707 }, { type: 'PK', fc: 1000, gain: 0, q: 1 } ] },
      },
    },
  };

  // Dolby B / C / S as level-dependent shelving companders. On record, a shelf boosts quiet
  // high-frequency (and for S, low-frequency) content; loud content passes almost unchanged.
  // Playback applies the exact inverse shelf, driven by the level it detects on tape.
  // Boost per stage: max / (1 + (a / a_c)^2), a = band level re Dolby level.
  // B: one stage up to 10 dB. C: two staggered stages, 20 dB, wider band. S: two HF stages
  // (24 dB) plus a 10 dB low-frequency stage.
  const NR = {
    'dolby-b': { label: 'ドルビーB', snGain: 10, shelves: [
      { type: 'HS', fc: 1500, det: 2500, stages: [{ max: 10, c: -20 }] } ] },
    'dolby-c': { label: 'ドルビーC', snGain: 20, shelves: [
      { type: 'HS', fc: 600, det: 1000, stages: [{ max: 10, c: -20 }, { max: 10, c: -36 }] } ] },
    'dolby-s': { label: 'ドルビーS', snGain: 24, shelves: [
      { type: 'HS', fc: 450, det: 800, stages: [{ max: 12, c: -18 }, { max: 12, c: -34 }] },
      { type: 'LS', fc: 150, det: 100, stages: [{ max: 10, c: -26 }] } ] },
  };
  const boostDb = (sh, aDb) => sh.stages.reduce((s, st) => s + st.max / (1 + Math.pow(10, (aDb - st.c) / 10)), 0);
  const NR_MEAS_DB = -20;   // cassette response is specified at -20 dB re Dolby level
  // dbx type II: 2:1 compression on record, 1:2 expansion on playback, with high-frequency
  // pre-/de-emphasis around the compander. Detector: rectified average, ~10 Hz smoothing.
  const DBX = { emph: { type: 'HS', fc: 1600, gain: 10, q: 0.707 }, detHz: 10, maxGainDb: 30, detScale: 0.25 };

  // Record pre-emphasis around the saturator; its gain is per tape (tape.emph): ferric tape saturates
  // early at high frequencies, metal tape has far more high-frequency headroom. Type III (ferrichrome,
  // a chrome layer over a ferric layer) sits between I and II: ferric-like low-frequency headroom,
  // chrome-like treble.
  const EMPHASIS = { type: 'HS', fc: 3000, gain: 6, q: 0.707 };

  // Tape ageing. s = years / 50 (0.2 at 10 years, 1 at 50 years).
  //  - oxide wear / head-contact loss: high-shelf cut above ~5 kHz, plus a small loss of level (demagnetisation)
  //  - dropouts: brief level dips with a strong high-frequency loss, rate rising with age
  //  - print-through: a post-echo one tape wrap later (~1.8 s), level rising with storage time
  //  - tape stretch: more wow
  function ageing(years) {
    if (!years) return { on: false, s: 0, years: 0, shelf: { type: 'HS', fc: 5000, gain: 0, q: 0.707 }, levelDb: 0, dropRate: 0, dropDepth: [0, 0], dropDur: [0, 0], printDb: -200, printDelay: 1.8, wfFactor: 1, hissDb: 0 };
    const s = years / 50;
    return {
      on: true, s, years,
      shelf: { type: 'HS', fc: 5000, gain: -8 * Math.pow(s, 1.3), q: 0.707 },
      levelDb: -1.5 * s,
      dropRate: 0.02 + 0.5 * s * s,               // per second
      dropDepth: [3, 6 + 14 * s],                 // dB, broadband part; HF falls much further
      dropDur: [0.02, 0.06 + 0.12 * s],           // seconds
      printDb: -58 + 16 * s,
      printDelay: 1.8,
      wfFactor: 1 + 0.8 * s * s,
      hissDb: 1.5 * s,
    };
  }

  // Wow & flutter split: slow wow sine, capstan flutter sine, band-limited random drift.
  const WF_RATIO = { wow: 1, flutter: 0.5, random: 0.6 };
  const WOW_HZ = 0.6;

  // opts: { player, tape, nr: 'none'|'dolby'|'dbx', nrDecode, wfScale, hissOffset (dB), recLevel (dB), age (years, 0 = new) }
  // (dolbyTape / dolbyDecode are still accepted for compatibility)
  function config(opts) {
    const P = PLAYERS[opts.player], T = P.tapes[opts.tape];
    let nr = opts.nr || (opts.dolbyTape ? 'dolby-b' : 'none');
    if (nr === 'dolby') nr = 'dolby-b';
    const nrDecode = opts.nrDecode !== undefined ? opts.nrDecode : opts.dolbyDecode !== false;
    const isDolby = nr in NR;
    const decode = P.dolby && isDolby && nrDecode;
    const dbxEnc = nr === 'dbx', dbxDec = dbxEnc && P.dbx && nrDecode;
    const age = ageing(opts.age || 0);
    const wfPct = P.wf * opts.wfScale * age.wfFactor;
    const unitRms = Math.sqrt(WF_RATIO.wow ** 2 / 2 + WF_RATIO.flutter ** 2 / 2 + WF_RATIO.random ** 2);
    const k = wfPct / 100 / unitRms;
    // 3 % THD (tanh, 3rd harmonic ~ (a x)^2 / 12) reached at MOL above Dolby level
    const satA = 0.6 / Math.pow(10, (REF_DBFS + T.mol) / 20);
    return {
      player: P, tape: T, eq: T.eq,
      nr, isDolby, decode, dolbyEnc: isDolby, bright: isDolby && !decode, dbxEnc, dbxDec,
      wfPct,
      wow: { hz: WOW_HZ, peak: k * WF_RATIO.wow },
      flutter: { hz: P.flutterHz, peak: k * WF_RATIO.flutter },
      random: { rms: k * WF_RATIO.random },
      satA,
      hissDb: REF_DBFS - T.sn + opts.hissOffset + age.hissDb,
      age,
      snEff: T.sn + (decode ? NR[nr].snGain : 0) + (dbxDec ? 30 : 0),
      azDelay: P.azDelay,
      recGain: Math.pow(10, opts.recLevel / 20),
    };
  }

  const eqDb = (list, f) => list.reduce((a, s) => a + bq(s, f), 0);
  // Frequency response of one channel, plus what an undecoded Dolby tape adds.
  function responseDb(cfg, f) {
    // an encoded Dolby tape played without decoding: the record shelf at the -20 dB measuring level
    const undecoded = cfg.bright ? NR[cfg.nr].shelves.reduce((s, sh) => s + bq({ type: sh.type, fc: sh.fc, gain: boostDb(sh, NR_MEAS_DB), q: 0.707 }, f), 0) : 0;
    const tape = eqDb(cfg.eq, f) + undecoded + bq(cfg.age.shelf, f) + cfg.age.levelDb;
    if (cfg.dbxDec) return 2 * tape;                       // 1:2 expansion doubles any tape error (sine sweep)
    if (cfg.dbxEnc) return tape + bq(DBX.emph, f);         // undecoded: the record pre-emphasis stays
    return tape;
  }
  // Mono sum (L+R)/2 with the azimuth time offset between channels.
  function monoDb(cfg, f) {
    return responseDb(cfg, f) + 20 * Math.log10(Math.max(1e-6, Math.abs(Math.cos(Math.PI * f * cfg.azDelay))));
  }

  // Deterministic PRNG
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Periodic band-limited drift. Returns the delay-time signal tau (seconds per unit speed
  // deviation) and its derivative dev, normalised so that rms(dev) = 1.
  // Built from sinusoids at multiples of 1/period, so the buffer loops without a seam.
  // Evaluated on a coarse grid (the signal is below 6 Hz) and linearly interpolated to `rate`.
  function randomDrift(rate = 22050, period = 40, fc = 1.2, seed = 7, coarse = 200) {
    const rnd = mulberry32(seed), n = Math.round(rate * period), nc = Math.round(coarse * period);
    const comps = [];
    for (let k = 1; k * (1 / period) <= 6; k++) {
      const f = k / period;
      const amp = 1 / (1 + (f / fc) ** 2);               // 2nd-order roll-off in tau
      comps.push({ w: TAU * f, a: amp * (0.5 + rnd()), p: TAU * rnd() });
    }
    const devRms = Math.sqrt(comps.reduce((s, c) => s + (c.a * c.w) ** 2 / 2, 0));
    const ct = new Float32Array(nc), cd = new Float32Array(nc);
    for (let i = 0; i < nc; i++) {
      const t = i / coarse;
      let x = 0, d = 0;
      for (const c of comps) { const ph = c.w * t + c.p; x += c.a * Math.sin(ph); d += c.a * c.w * Math.cos(ph); }
      ct[i] = x / devRms; cd[i] = d / devRms;
    }
    const tau = new Float32Array(n), dev = new Float32Array(n), step = coarse / rate;
    for (let i = 0; i < n; i++) {
      const x = i * step, i0 = Math.floor(x) % nc, i1 = (i0 + 1) % nc, fr = x - Math.floor(x);
      tau[i] = ct[i0] + fr * (ct[i1] - ct[i0]);
      dev[i] = cd[i0] + fr * (cd[i1] - cd[i0]);
    }
    return { rate, period, tau, dev };
  }

  // ---------- dbx compander from native Web Audio nodes (browser only) ----------
  // Encoder gain = (a / aRef)^-1/2 via a WaveShaper curve on the detector output; decoder gain =
  // b / aRef, fed straight into the VCA gain. With a flat tape path the pair is transparent.
  function buildDbx(ctx, aRef) {
    const map = { HP: 'highpass', LP: 'lowpass', PK: 'peaking', HS: 'highshelf', LS: 'lowshelf' };
    const filt = (s) => {
      const b = ctx.createBiquadFilter(); b.type = map[s.type]; b.frequency.value = s.fc;
      b.Q.value = s.type === 'HP' || s.type === 'LP' ? 20 * Math.log10(s.q) : s.q; b.gain.value = s.gain || 0; return b;
    };
    const stereo = (g) => { g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers'; return g; };
    const NPTS = 65537;
    const absCurve = new Float32Array(NPTS), powCurve = new Float32Array(NPTS);
    const maxG = Math.pow(10, DBX.maxGainDb / 20), ref = DBX.detScale * aRef;
    for (let i = 0; i < NPTS; i++) {
      const u = (i / (NPTS - 1)) * 2 - 1;
      absCurve[i] = Math.abs(u);
      powCurve[i] = u <= 0 ? maxG : Math.min(maxG, Math.pow(u / ref, -0.5));
    }
    function detector(src) {
      const pre = ctx.createGain(); pre.gain.value = DBX.detScale;
      const abs = ctx.createWaveShaper(); abs.curve = absCurve;
      const l1 = filt({ type: 'LP', fc: DBX.detHz, q: 0.707 }), l2 = filt({ type: 'LP', fc: DBX.detHz * 1.5, q: 0.707 });
      src.connect(pre); pre.connect(abs); abs.connect(l1); l1.connect(l2);
      return l2;
    }
    function stage(kind) {
      const input = stereo(ctx.createGain()), output = ctx.createGain();
      const bypass = ctx.createGain(), wet = ctx.createGain(); wet.gain.value = 0;
      const vca = ctx.createGain(); vca.gain.value = 0;
      input.connect(bypass); bypass.connect(output);
      if (kind === 'enc') {
        const pre = filt(DBX.emph);
        input.connect(pre); pre.connect(vca);
        const shaper = ctx.createWaveShaper(); shaper.curve = powCurve;
        detector(pre).connect(shaper); shaper.connect(vca.gain);
        vca.connect(wet);
      } else {
        const de = filt({ ...DBX.emph, gain: -DBX.emph.gain });
        input.connect(vca); vca.connect(de); de.connect(wet);
        const scale = ctx.createGain(); scale.gain.value = 1 / ref;
        detector(input).connect(scale); scale.connect(vca.gain);
      }
      wet.connect(output);
      return {
        input, output,
        set(on, t = ctx.currentTime) {
          bypass.gain.setTargetAtTime(on ? 0 : 1, t, 0.02);
          wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
        },
      };
    }
    return { enc: stage('enc'), dec: stage('dec') };
  }

  // ---------- Dolby B / C / S compander (browser only) ----------
  // Detector: band filter -> rectifier -> low-pass, scaled so 1.0 = Dolby level. A WaveShaper maps
  // the detected level to the shelf gain in dB, wired into BiquadFilter.gain.
  function buildDolby(ctx, aRef, key) {
    const def = NR[key];
    const NPTS = 65537;
    const absCurve = new Float32Array(NPTS);
    for (let i = 0; i < NPTS; i++) absCurve[i] = Math.abs((i / (NPTS - 1)) * 2 - 1);
    const stereo = (g) => { g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers'; return g; };
    function detector(src, sh) {
      const pre = ctx.createGain(); pre.gain.value = 1 / aRef;
      const band = ctx.createBiquadFilter(); band.type = sh.type === 'HS' ? 'highpass' : 'lowpass'; band.frequency.value = sh.det; band.Q.value = -3.01;
      const abs = ctx.createWaveShaper(); abs.curve = absCurve;
      const l1 = ctx.createBiquadFilter(); l1.type = 'lowpass'; l1.frequency.value = sh.type === 'HS' ? 30 : 12; l1.Q.value = -3.01;
      const l2 = ctx.createBiquadFilter(); l2.type = 'lowpass'; l2.frequency.value = sh.type === 'HS' ? 45 : 18; l2.Q.value = -3.01;
      src.connect(band); band.connect(pre); pre.connect(abs); abs.connect(l1); l1.connect(l2);
      return l2;
    }
    // Encoder: feed-forward, detector on the input. Decoder: feedback, detector on the decoded
    // output (through one render quantum of delay), as real Dolby decoders do. Both detectors then
    // see the same signal, so the shelf gains mirror each other.
    function curveFor(sh, decode) {
      const c = new Float32Array(NPTS);
      for (let i = 0; i < NPTS; i++) {
        const u = (i / (NPTS - 1)) * 2 - 1;
        const g = boostDb(sh, u <= 0 ? -200 : 20 * Math.log10(u));
        c[i] = decode ? -g : g;
      }
      return c;
    }
    function stage(decode) {
      const input = stereo(ctx.createGain()), output = ctx.createGain();
      const bypass = ctx.createGain(), wet = ctx.createGain(); wet.gain.value = 0;
      input.connect(bypass); bypass.connect(output);
      let node = input;
      const filters = def.shelves.map((sh) => {
        const f = ctx.createBiquadFilter(); f.type = sh.type === 'HS' ? 'highshelf' : 'lowshelf'; f.frequency.value = sh.fc; f.gain.value = 0;
        node.connect(f); node = f;
        return f;
      });
      let sense = input;
      if (decode) { sense = ctx.createDelay(0.05); sense.delayTime.value = 0; node.connect(sense); }
      def.shelves.forEach((sh, i) => {
        const shaper = ctx.createWaveShaper(); shaper.curve = curveFor(sh, decode);
        detector(sense, sh).connect(shaper); shaper.connect(filters[i].gain);
      });
      node.connect(wet); wet.connect(output);
      return {
        input, output,
        set(on, t = ctx.currentTime) {
          bypass.gain.setTargetAtTime(on ? 0 : 1, t, 0.02);
          wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
        },
      };
    }
    return { enc: stage(false), dec: stage(true) };
  }

  return { PLAYERS, REF_DBFS, NR, boostDb, EMPHASIS, DBX, buildDbx, buildDolby, ageing, config, responseDb, monoDb, randomDrift };
})();
if (typeof module !== 'undefined') module.exports = CASSETTE;
