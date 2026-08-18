/**
 * sound.js — synthesized UI sound effects via the Web Audio API (no audio
 * files). Unchanged in spirit from the original, plus a master volume
 * control wired to settings.soundVolume.
 */
export class SoundManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.8;
  }
  _ensureCtx() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  setEnabled(v) { this.enabled = v; }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); }

  _tone({ freq = 440, duration = 0.12, type = 'square', gain = 0.13, glideTo = null, delay = 0, filterFreq = null, filterType = 'lowpass', filterQ = 1 } = {}, bypassMute = false) {
    if (!this.enabled && !bypassMute) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
    const effGain = gain * this.volume;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, effGain), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    let out = osc;
    if (filterFreq) {
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.setValueAtTime(filterFreq, t0);
      f.Q.value = filterQ;
      osc.connect(f);
      out = f;
    }
    out.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }

  _noise({ duration = 0.05, gain = 0.1, filterFreq = 3000, filterType = 'bandpass', filterQ = 1.2, delay = 0 } = {}, bypassMute = false) {
    if (!this.enabled && !bypassMute) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = filterFreq;
    filt.Q.value = filterQ;

    const g = ctx.createGain();
    const effGain = gain * this.volume;
    g.gain.setValueAtTime(effGain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    src.connect(filt);
    filt.connect(g);
    g.connect(ctx.destination);
    src.start(t0);
  }

  _blipSequence(freqs, { duration = 0.045, gap = 0.02, gain = 0.12, type = 'square' } = {}) {
    freqs.forEach((f, i) => {
      this._tone({ freq: f, duration, type, gain, delay: i * (duration + gap), filterFreq: 4200 });
    });
  }

  hover() { this._tone({ freq: 1900, duration: 0.025, type: 'square', gain: 0.03, filterFreq: 4500 }); }
  open() {
    this._blipSequence([620, 880, 1320], { duration: 0.045, gap: 0.018, gain: 0.13 });
    this._noise({ duration: 0.05, gain: 0.05, filterFreq: 5500, delay: 0.13 });
  }
  enterFolder() {
    this._tone({ freq: 340, duration: 0.1, type: 'sawtooth', gain: 0.13, glideTo: 950, filterFreq: 2400 });
    this._noise({ duration: 0.04, gain: 0.05, filterFreq: 6000, delay: 0.06 });
  }
  back() { this._tone({ freq: 950, duration: 0.1, type: 'sawtooth', gain: 0.12, glideTo: 300, filterFreq: 2400 }); }
  switchTab() {
    this._noise({ duration: 0.02, gain: 0.09, filterFreq: 4500, filterType: 'highpass' });
    this._tone({ freq: 1100, duration: 0.03, type: 'square', gain: 0.07, delay: 0.008, filterFreq: 5000 });
  }
  add() { this._blipSequence([523.25, 659.25, 987.77], { duration: 0.05, gap: 0.012, gain: 0.13 }); }
  remove() {
    this._tone({ freq: 260, duration: 0.18, type: 'sawtooth', gain: 0.1, glideTo: 85, filterFreq: 1200 });
    this._noise({ duration: 0.09, gain: 0.07, filterFreq: 900, filterType: 'lowpass', delay: 0.02 });
  }
  uiClick() { this._noise({ duration: 0.02, gain: 0.15, filterFreq: 3500, filterQ: 2 }, true); }
}

export const sound = new SoundManager();
