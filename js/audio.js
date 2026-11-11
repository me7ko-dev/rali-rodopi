// Small synthesised sound set: engine, tyre squeal, beeps. Starts on the first click.
export class Sound {
  constructor() { this.ac = null; }
  start() {
    if (this.ac) { this.ac.resume(); return; }
    try {
      const ac = this.ac = new (window.AudioContext || window.webkitAudioContext)();
      this.master = ac.createGain(); this.master.gain.value = 0.5; this.master.connect(ac.destination);
      // engine: two detuned saws through a low-pass
      this.eGain = ac.createGain(); this.eGain.gain.value = 0;
      this.eFilter = ac.createBiquadFilter(); this.eFilter.type = 'lowpass'; this.eFilter.frequency.value = 500;
      this.o1 = ac.createOscillator(); this.o1.type = 'sawtooth'; this.o2 = ac.createOscillator(); this.o2.type = 'square';
      const g2 = ac.createGain(); g2.gain.value = 0.35;
      this.o1.connect(this.eFilter); this.o2.connect(g2); g2.connect(this.eFilter); this.eFilter.connect(this.eGain); this.eGain.connect(this.master);
      this.o1.start(); this.o2.start();
      // squeal: filtered noise
      const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const n = ac.createBufferSource(); n.buffer = buf; n.loop = true;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 4;
      this.sGain = ac.createGain(); this.sGain.gain.value = 0;
      n.connect(bp); bp.connect(this.sGain); this.sGain.connect(this.master); n.start();
    } catch (e) { this.ac = null; }
  }
  engine(ratio, throttle, on) {
    if (!this.ac) return;
    const t = this.ac.currentTime, r = Math.max(0, Math.min(1.25, ratio));
    const gear = Math.min(4, Math.floor(r * 5)), frac = r * 5 - gear;
    const f = 55 + gear * 14 + frac * 95;
    this.o1.frequency.setTargetAtTime(f, t, 0.05); this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.eFilter.frequency.setTargetAtTime(350 + r * 1300 + throttle * 500, t, 0.08);
    this.eGain.gain.setTargetAtTime(on ? 0.07 + throttle * 0.06 : 0, t, 0.1);
  }
  skid(amount) { if (this.ac) this.sGain.gain.setTargetAtTime(Math.min(0.16, amount), this.ac.currentTime, 0.06); }
  beep(freq, dur = 0.18, vol = 0.2, type = 'square') {
    if (!this.ac) return;
    const t = this.ac.currentTime, o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur);
  }
  thud(v) { this.beep(70, 0.2, Math.min(0.5, v / 40), 'sawtooth'); }
  quiet() { this.engine(0, 0, false); this.skid(0); }
}
