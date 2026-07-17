/**
 * HollaProcessor — AudioWorklet processor v2
 *
 * KEY FIXES vs v1:
 *   1. Adaptive SNR threshold — continuously estimates the ambient noise floor
 *      and requires the tap to be `snrThreshold` × louder (default 25×).
 *      Fan noise, A/C, keyboard typing all raise the floor, so only genuine
 *      loud taps pass. Absolute energy alone (v1) was useless.
 *
 *   2. Better spatial features for Intel SST — the Intel Smart Sound Technology
 *      driver applies beamforming, which DESTROYS raw TDOA phase information.
 *      Instead we use two features that survive DSP processing:
 *
 *      a) ILD (Inter-channel Level Difference)
 *         ild = (rmsL − rmsR) / (rmsL + rmsR)   → −1 (pure left) … +1 (pure right)
 *         Even post-beamforming, amplitude differences between channels remain.
 *
 *      b) Spectral shape fingerprint (3 normalised frequency bands)
 *         Different table positions excite different resonant modes. A tap at
 *         "rear left" has a different low/mid/high energy ratio than "front right".
 *         These ratios are independent of how hard you tap.
 *
 *   3. Feature vector (6 values):
 *      [ild, spectralCentroid, bandLow, bandMid, bandHigh, logEnergy]
 *      Backwards-incompatible with v1 — profiles must be re-calibrated.
 *
 * Pipeline per 128-sample quantum:
 *   1. Accumulate L/R samples into 4096-sample circular buffers
 *   2. Compute STE; update adaptive noise floor
 *   3. If STE / noiseFloor > snrThreshold → tap onset
 *   4. Extract 2048-sample window, apply Hanning window
 *   5. Compute ILD, spectral shape, GCC-PHAT (for debug), log energy
 *   6. Post feature vector to renderer via port.postMessage
 */

class HollaProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ── Config ──────────────────────────────────────────────────────────
    this.FFT_SIZE   = 2048;
    this.BUF_SIZE   = this.FFT_SIZE * 2;

    // Tap detection
    this.snrThreshold   = 25;      // tap must be 25× above noise floor
    this.absMinEnergy   = 0.0002;  // absolute floor — never trigger below this
    this.cooldownFrames = Math.floor(sampleRate * 0.40 / 128);  // 400 ms
    this.cooldown       = 0;
    this.enabled        = true;

    // Adaptive noise floor (exponential moving average of quiet frames)
    this.noiseFloor   = 1e-6;
    this.noiseAlpha   = 0.997;    // ~133 quiet frames (~350ms) to adapt

    // Smoothed STE
    this.energyBuf  = new Float32Array(8);
    this.energyIdx  = 0;

    // Circular audio buffers
    this.bufL       = new Float32Array(this.BUF_SIZE);
    this.bufR       = new Float32Array(this.BUF_SIZE);
    this.writePos   = 0;

    // Port config updates
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'config') return;
      if (data.snrThreshold  !== undefined) this.snrThreshold   = data.snrThreshold;
      if (data.enabled       !== undefined) this.enabled        = data.enabled;
      if (data.cooldown      !== undefined) {
        this.cooldownFrames = Math.floor(sampleRate * data.cooldown / 1000 / 128);
      }
    };
  }

  // ── process ─────────────────────────────────────────────────────────────
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || !this.enabled) return true;

    const left  = input[0];
    const right = input[1];
    const mono  = !right || right.length === 0;

    // 1. Write to circular buffers
    for (let i = 0; i < left.length; i++) {
      this.bufL[this.writePos] = left[i];
      this.bufR[this.writePos] = mono ? left[i] : right[i];
      this.writePos = (this.writePos + 1) % this.BUF_SIZE;
    }

    // 2. Short-time energy of this frame
    let ste = 0;
    for (let i = 0; i < left.length; i++) {
      const r = mono ? left[i] : right[i];
      ste += left[i] * left[i] + r * r;
    }
    ste /= (left.length * 2);

    // Smooth over 8 frames
    this.energyBuf[this.energyIdx % 8] = ste;
    this.energyIdx++;
    let smoothSte = 0;
    for (let i = 0; i < 8; i++) smoothSte += this.energyBuf[i];
    smoothSte /= 8;

    // 3. Cooldown countdown
    if (this.cooldown > 0) {
      this.cooldown--;
      return true;
    }

    // 4. Adaptive noise floor: only update during quiet frames
    const snr = smoothSte / (this.noiseFloor + 1e-12);
    if (snr < 5) {
      // Quiet frame — this IS the ambient level
      this.noiseFloor = this.noiseAlpha * this.noiseFloor + (1 - this.noiseAlpha) * smoothSte;
    }

    // 5. Tap onset: SNR gate + absolute minimum
    if (snr > this.snrThreshold && smoothSte > this.absMinEnergy) {
      this.cooldown = this.cooldownFrames;
      this._processTap(smoothSte, mono);
    }

    return true;
  }

  // ── Tap feature extraction ───────────────────────────────────────────────
  _processTap(energy, mono) {
    const N     = this.FFT_SIZE;
    const chL   = new Float32Array(N);
    const chR   = new Float32Array(N);

    const start = (this.writePos - N + this.BUF_SIZE) % this.BUF_SIZE;
    for (let i = 0; i < N; i++) {
      const idx  = (start + i) % this.BUF_SIZE;
      chL[i]     = this.bufL[idx];
      chR[i]     = this.bufR[idx];
    }

    // Hanning window
    for (let i = 0; i < N; i++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      chL[i] *= w;
      chR[i] *= w;
    }

    // ── ILD (Inter-channel Level Difference) ──────────────────────────
    // Survives Intel SST beamforming; most reliable spatial feature.
    let ssL = 0, ssR = 0;
    for (let i = 0; i < N; i++) { ssL += chL[i] * chL[i]; ssR += chR[i] * chR[i]; }
    const rmsL = Math.sqrt(ssL / N);
    const rmsR = Math.sqrt(ssR / N);
    const ild  = (rmsL - rmsR) / (rmsL + rmsR + 1e-12);   // −1…+1

    // ── Spectral analysis on mixed channel ──────────────────────────────
    // Mix both channels; the spectral SHAPE (resonance fingerprint) is what
    // discriminates table positions — independent of stereo balance.
    const mixed  = new Float32Array(N);
    for (let i = 0; i < N; i++) mixed[i] = (chL[i] + chR[i]) * 0.5;

    const reM = new Float64Array(N), imM = new Float64Array(N);
    for (let i = 0; i < N; i++) reM[i] = mixed[i];
    this._fft(reM, imM);

    // Power spectrum (only positive bins)
    const half  = N / 2;
    const power = new Float64Array(half);
    let   total = 0;
    for (let k = 0; k < half; k++) {
      power[k] = reM[k] * reM[k] + imM[k] * imM[k];
      total    += power[k];
    }

    // Spectral centroid (normalised 0–1)
    let wSum = 0;
    for (let k = 0; k < half; k++) wSum += k * power[k];
    const sc = total > 0 ? wSum / total / half : 0;

    // 3 frequency bands (log-spaced) normalised to 0–1 sum = 1.
    // At 48kHz, FFT size 2048: bin width = 23.4 Hz
    //   low : 0–1000 Hz  → bins 0–42
    //   mid : 1–8 kHz    → bins 43–341
    //   high: 8–24 kHz   → bins 342–1023
    const bLow  = this._bandEnergy(power, 0,   42)  / (total + 1e-12);
    const bMid  = this._bandEnergy(power, 43,  341) / (total + 1e-12);
    const bHigh = this._bandEnergy(power, 342, 1023) / (total + 1e-12);

    // Log energy (compressed scale)
    const logE = Math.log10(energy + 1e-12);

    // ── GCC-PHAT (still computed, used as a debug / secondary feature) ──
    const tdoa = mono ? 0 : this._gccPhat(chL, chR);

    // ── Emit ────────────────────────────────────────────────────────────
    // Feature vector: [ild, sc, bandLow, bandMid, bandHigh, logEnergy]
    this.port.postMessage({
      type:      'tap',
      features:  [ild, sc, bLow, bMid, bHigh, logE],
      tdoa,             // for Monitor display only
      monoMode:  mono,
      noiseFloor: this.noiseFloor,
      snr:        energy / (this.noiseFloor + 1e-12),
      timestamp:  currentTime
    });
  }

  // ── Band energy (sum of power in [lo..hi] inclusive) ──────────────────
  _bandEnergy(power, lo, hi) {
    let s = 0;
    const end = Math.min(hi, power.length - 1);
    for (let k = lo; k <= end; k++) s += power[k];
    return s;
  }

  // ── GCC-PHAT ────────────────────────────────────────────────────────────
  _gccPhat(x0, x1) {
    const N   = x0.length;
    const re0 = new Float64Array(N), im0 = new Float64Array(N);
    const re1 = new Float64Array(N), im1 = new Float64Array(N);
    for (let i = 0; i < N; i++) { re0[i] = x0[i]; re1[i] = x1[i]; }
    this._fft(re0, im0); this._fft(re1, im1);
    const gRe = new Float64Array(N), gIm = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const gr  = re0[k]*re1[k] + im0[k]*im1[k];
      const gi  = im0[k]*re1[k] - re0[k]*im1[k];
      const mag = Math.sqrt(gr*gr + gi*gi) + 1e-12;
      gRe[k] = gr/mag; gIm[k] = gi/mag;
    }
    this._ifft(gRe, gIm);
    let maxV = -Infinity, maxI = 0;
    for (let i = 0; i < N; i++) { if (gRe[i] > maxV) { maxV = gRe[i]; maxI = i; } }
    if (maxI > N / 2) maxI -= N;
    return maxI;
  }

  // ── Cooley-Tukey DIT FFT ────────────────────────────────────────────────
  _fft(re, im) {
    const N = re.length;
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t; t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t;
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1;
      const ang  = -2 * Math.PI / len;
      const wBR  = Math.cos(ang), wBI = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let wR = 1, wI = 0;
        for (let k = 0; k < half; k++) {
          const uR = re[i+k], uI = im[i+k];
          const vR = re[i+k+half]*wR - im[i+k+half]*wI;
          const vI = re[i+k+half]*wI + im[i+k+half]*wR;
          re[i+k]=uR+vR; im[i+k]=uI+vI;
          re[i+k+half]=uR-vR; im[i+k+half]=uI-vI;
          const nR=wR*wBR-wI*wBI; wI=wR*wBI+wI*wBR; wR=nR;
        }
      }
    }
  }

  _ifft(re, im) {
    const N = re.length;
    for (let i = 0; i < N; i++) im[i] = -im[i];
    this._fft(re, im);
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
  }
}

registerProcessor('holla-processor', HollaProcessor);
