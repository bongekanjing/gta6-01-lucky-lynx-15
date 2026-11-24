// WebAudio only: every sound is built from oscillators and filtered noise at call time, so the
// game needs no audio files. A tiny graph — master gain, a compressor, a noise buffer reused by
// every percussive sound — and one function per effect. Nothing here throws if the context is
// blocked; a missing AudioContext just makes the module silent.
export function createAudio() {
  let ctx = null;
  let master = null;
  let noise = null;
  let engine = null;
  let engineGain = null;
  let siren = null;
  let sirenGain = null;
  let sirenLfo = null;
  let started = false;
  // Audio is generated, not sampled, but the noise buffer still needs scattered bytes. A small
  // LCG keeps the module free of Math.random so the whole codebase is deterministic.
  let noiseSeed = 0x2f6e2b1;
  const noiseRand = () => {
    noiseSeed = (noiseSeed * 1664525 + 1013904223) >>> 0;
    return noiseSeed / 4294967296;
  };

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    master.connect(comp).connect(ctx.destination);
    // One second of white noise, reused.
    const len = ctx.sampleRate;
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = noiseRand() * 2 - 1;
    return ctx;
  }

  /** Must be called from a user gesture; it is safe to call repeatedly. */
  function unlock() {
    const c = ensure();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    if (!started) {
      started = true;
      startEngine();
      startSiren();
    }
  }

  function startEngine() {
    if (!ctx) return;
    engine = ctx.createOscillator();
    engine.type = 'sawtooth';
    engine.frequency.value = 70;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engine.connect(filter).connect(engineGain).connect(master);
    engine.start();
  }

  function startSiren() {
    if (!ctx) return;
    siren = ctx.createOscillator();
    siren.type = 'square';
    siren.frequency.value = 720;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 3;
    sirenGain = ctx.createGain();
    sirenGain.gain.value = 0;
    sirenLfo = ctx.createOscillator();
    sirenLfo.frequency.value = 0.7;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 240;
    sirenLfo.connect(lfoGain).connect(siren.frequency);
    siren.connect(filter).connect(sirenGain).connect(master);
    siren.start();
    sirenLfo.start();
  }

  function noiseBurst(duration, filterFreq, gain, type = 'bandpass') {
    if (!ctx || !noise) return;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.7 + noiseRand() * 0.6;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    filter.Q.value = 1.1;
    const env = ctx.createGain();
    const now = ctx.currentTime;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(filter).connect(env).connect(master);
    src.start(now);
    src.stop(now + duration + 0.02);
  }

  function tone(freq, endFreq, duration, gain, type = 'square') {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(env).connect(master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  const sfx = {
    pistol() {
      noiseBurst(0.14, 1500, 0.5);
      tone(220, 60, 0.12, 0.28, 'square');
    },
    smg() {
      noiseBurst(0.08, 2200, 0.3);
      tone(320, 90, 0.06, 0.16, 'square');
    },
    shotgun() {
      noiseBurst(0.34, 900, 0.62, 'lowpass');
      tone(120, 40, 0.3, 0.35, 'sawtooth');
    },
    hit() {
      noiseBurst(0.1, 500, 0.34, 'lowpass');
      tone(90, 50, 0.13, 0.2, 'triangle');
    },
    pickup() {
      tone(660, 990, 0.09, 0.16, 'triangle');
      setTimeout(() => tone(990, 1320, 0.1, 0.13, 'triangle'), 70);
    },
    cash() {
      tone(880, 1320, 0.08, 0.12, 'triangle');
      setTimeout(() => tone(1320, 1760, 0.12, 0.1, 'triangle'), 60);
    },
    wanted() {
      tone(180, 90, 0.4, 0.3, 'sawtooth');
      setTimeout(() => tone(240, 120, 0.35, 0.2, 'sawtooth'), 140);
    },
    mission() {
      tone(392, 392, 0.16, 0.16, 'triangle');
      setTimeout(() => tone(523, 523, 0.16, 0.16, 'triangle'), 140);
      setTimeout(() => tone(659, 659, 0.3, 0.18, 'triangle'), 280);
    },
    fail() {
      tone(320, 110, 0.5, 0.22, 'sawtooth');
    },
    carHit() {
      noiseBurst(0.22, 360, 0.4, 'lowpass');
      tone(70, 35, 0.2, 0.3, 'square');
    },
    door() {
      noiseBurst(0.1, 900, 0.18, 'bandpass');
      tone(140, 90, 0.12, 0.12, 'square');
    },
    sirenBlip() {
      tone(700, 1000, 0.18, 0.1, 'square');
    },
    death() {
      tone(220, 55, 0.9, 0.3, 'sawtooth');
      noiseBurst(0.7, 300, 0.3, 'lowpass');
    },
  };

  function play(name) {
    if (!ctx) return;
    const fn = sfx[name];
    if (fn) fn();
  }

  /** Engine pitch and siren mix follow the world every frame. */
  function update({ speed = 0, maxSpeed = 200, driving = false, copsNear = 0, wanted = 0, muted = false }) {
    if (!ctx || !engineGain) return;
    const now = ctx.currentTime;
    const t = Math.min(1, speed / Math.max(1, maxSpeed));
    const wantEngine = driving ? 0.06 + t * 0.11 : 0;
    engineGain.gain.setTargetAtTime(muted ? 0 : wantEngine, now, 0.08);
    engine.frequency.setTargetAtTime(58 + t * 150 + (t > 0.55 ? (t - 0.55) * 90 : 0), now, 0.09);
    if (sirenGain) {
      const s = wanted > 0 ? Math.min(0.075, 0.018 + copsNear * 0.014 + wanted * 0.007) : 0;
      sirenGain.gain.setTargetAtTime(muted ? 0 : s, now, 0.15);
      if (sirenLfo) sirenLfo.frequency.setTargetAtTime(0.55 + wanted * 0.12, now, 0.2);
    }
  }

  function setMuted(muted) {
    if (!master || !ctx) return;
    master.gain.setTargetAtTime(muted ? 0 : 0.55, ctx.currentTime, 0.05);
  }

  return { unlock, play, update, ensure, setMuted };
}
