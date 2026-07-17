/**
 * HollaProcessor — AudioWorklet processor v3
 *
 * FIXES vs v2:
 *   1. Warmup phase (0.8 s) — no taps fired while noise floor calibrates.
 *      Eliminates phantom taps from mic initialisation and cold start.
 *
 *   2. noiseFloor starts at 0.005 (conservative / high) and adapts DOWN
 *      to the actual ambient level during warmup (alpha=0.85, fast).
 *      After warmup, slow tracking (alpha=0.997) follows gradual changes.
 *
 *   3. 'reset' command — sent by the renderer when the user enters the
 *      calibration wizard for the Nth time. Restarts warmup and clears
 *      the cooldown so a fresh, clean baseline is measured each time.
 *
 *   4. Absolute minimum energy gate (absMinEnergy=0.001) prevents the
 *      processor from firing on microphone self-noise / digital silence.
 *
 *   5. Posts 'warmup' progress messages so the UI can show "Calibrating
 *      mic…" status instead of "tap now" during the blind period.
 */

class HollaProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.FFT_SIZE   = 2048;
    this.BUF_SIZE   = this.FFT_SIZE * 2;

    // ── Tap detection params ────────────────────────────────────────────
    this.snrThreshold   = 25;       // × above noise floor
    this.absMinEnergy   = 0.001;    // absolute gate — never fires quieter
    this.cooldownFrames = Math.ceil(sampleRate * 0.40 / 128);
    this.cooldown       = 0;
    this.enabled        = true;

    // ── Adaptive noise floor ────────────────────────────────────────────
    // Starts HIGH → adapts DOWN during warmup. Better than starting low.
    this.noiseFloor   = 0.005;
    this.ALPHA_SLOW   = 0.997;   // after warmup: ~0.9 s time constant
    this.ALPHA_FAST   = 0.85;    // during warmup: very fast adaptation

    // ── Warmup ─────────────────────────────────────────────────────────
    // Do not fire taps for the first WARMUP_FRAMES quanta (~0.8 s).
    this.WARMUP_FRAMES  = Math.ceil(sampleRate * 0.80 / 128);
    this.warmupCounter  = this.WARMUP_FRAMES;

    // ── Smoothed STE ────────────────────────────────────────────────────
    this.energyBuf  = new Float32Array(8);
    this.energyIdx  = 0;

    // ── Circular audio buffers ──────────────────────────────────────────
    this.bufL       = new Float32Array(this.BUF_SIZE);
    this.bufR       = new Float32Array(this.BUF_SIZE);
    this.writePos   = 0;

    // ── Port messages ───────────────────────────────────────────────────
    this.port.onmessage = ({ data }) => {
      if (!data) return;
      switch (data.type) {
        case 'config':
          if (data.snrThreshold !== undefined) this.snrThreshold   = data.snrThreshold;
          if (data.enabled      !== undefined) this.enabled        = data.enabled;
          if (data.cooldown     !== undefined) {
            this.cooldownFrames = Math.ceil(sampleRate * data.cooldown / 1000 / 128);
          }
          break;

        // Called when user enters calibration wizard (fresh or 2nd attempt)
        case 'reset':
          this.warmupCounter = this.WARMUP_FRAMES;
          this.cooldown      = 0;
          this.noiseFloor    = 0.005;   // restart estimate
          this.energyBuf.fill(0);
          this.energyIdx = 0;
          break;
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

    // Smooth energy (8-frame average)
    this.energyBuf[this.energyIdx % 8] = ste;
    this.energyIdx++;
    let smoothSte = 0;
    for (let i = 0; i < 8; i++) smoothSte += this.energyBuf[i];
    smoothSte /= 8;

    // 3. WARMUP — rapidly calibrate noise floor, don't fire taps
    if (this.warmupCounter > 0) {
      this.warmupCounter--;
      // Fast adaptation: converges to true ambient in ~8 frames
      this.noiseFloor = this.ALPHA_FAST * this.noiseFloor +
                        (1 - this.ALPHA_FAST) * smoothSte;

      // Report warmup progress to renderer every 10 frames
      if (this.warmupCounter % 10 === 0) {
        this.port.postMessage({
          type:      'warmup',
          progress:  1 - this.warmupCounter / this.WARMUP_FRAMES,
          noiseFloor: this.noiseFloor
        });
      }
      return true;
    }

    // 4. Cooldown countdown
    if (this.cooldown > 0) { this.cooldown--; return true; }

    // 5. Compute SNR
    const snr = smoothSte / (this.noiseFloor + 1e-12);

    // 6. Update noise floor ONLY on quiet frames (not during/near taps)
    if (snr < 4) {
      this.noiseFloor = this.ALPHA_SLOW * this.noiseFloor +
                        (1 - this.ALPHA_SLOW) * smoothSte;
    }

    // 7. Tap onset gate: SNR gate AND absolute minimum energy gate
    if (snr > this.snrThreshold && smoothSte > this.absMinEnergy) {
      this.cooldown = this.cooldownFrames;
      this._processTap(smoothSte, mono);
    }

    return true;
  }

  // ── Tap feature extraction ───────────────────────────────────────────────
  _processTap(energy, mono) {
    const N   = this.FFT_SIZE;
    const chL = new Float32Array(N);
    const chR = new Float32Array(N);

    const start = (this.writePos - N + this.BUF_SIZE) % this.BUF_SIZE;
    for (let i = 0; i < N; i++) {
      const idx = (start + i) % this.BUF_SIZE;
      chL[i]    = this.bufL[idx];
      chR[i]    = this.bufR[idx];
    }

    // Hanning window
    for (let i = 0; i < N; i++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      chL[i] *= w;
      chR[i] *= w;
    }

    // ILD
    let ssL = 0, ssR = 0;
    for (let i = 0; i < N; i++) { ssL += chL[i]*chL[i]; ssR += chR[i]*chR[i]; }
    const rmsL = Math.sqrt(ssL / N);
    const rmsR = Math.sqrt(ssR / N);
    const ild  = (rmsL - rmsR) / (rmsL + rmsR + 1e-12);

    // Spectral analysis on mixed channel
    const mixed = new Float32Array(N);
    for (let i = 0; i < N; i++) mixed[i] = (chL[i] + chR[i]) * 0.5;

    const reM = new Float64Array(N), imM = new Float64Array(N);
    for (let i = 0; i < N; i++) reM[i] = mixed[i];
    this._fft(reM, imM);

    const half  = N / 2;
    const power = new Float64Array(half);
    let   total = 0;
    for (let k = 0; k < half; k++) {
      power[k] = reM[k]*reM[k] + imM[k]*imM[k];
      total   += power[k];
    }

    let wSum = 0;
    for (let k = 0; k < half; k++) wSum += k * power[k];
    const sc = total > 0 ? wSum / total / half : 0;

    const bLow  = this._bandEnergy(power,   0,  42) / (total + 1e-12);
    const bMid  = this._bandEnergy(power,  43, 341) / (total + 1e-12);
    const bHigh = this._bandEnergy(power, 342,1023) / (total + 1e-12);

    const logE  = Math.log10(energy + 1e-12);
    const tdoa  = mono ? 0 : this._gccPhat(chL, chR);

    this.port.postMessage({
      type:       'tap',
      features:   [ild, sc, bLow, bMid, bHigh, logE],
      tdoa,
      monoMode:   mono,
      noiseFloor: this.noiseFloor,
      snr:        energy / (this.noiseFloor + 1e-12),
      timestamp:  currentTime
    });
  }

  _bandEnergy(power, lo, hi) {
    let s = 0;
    const end = Math.min(hi, power.length - 1);
    for (let k = lo; k <= end; k++) s += power[k];
    return s;
  }

  _gccPhat(x0, x1) {
    const N   = x0.length;
    const re0 = new Float64Array(N), im0 = new Float64Array(N);
    const re1 = new Float64Array(N), im1 = new Float64Array(N);
    for (let i = 0; i < N; i++) { re0[i]=x0[i]; re1[i]=x1[i]; }
    this._fft(re0,im0); this._fft(re1,im1);
    const gRe=new Float64Array(N), gIm=new Float64Array(N);
    for (let k=0;k<N;k++){
      const gr=re0[k]*re1[k]+im0[k]*im1[k];
      const gi=im0[k]*re1[k]-re0[k]*im1[k];
      const mag=Math.sqrt(gr*gr+gi*gi)+1e-12;
      gRe[k]=gr/mag; gIm[k]=gi/mag;
    }
    this._ifft(gRe,gIm);
    let maxV=-Infinity,maxI=0;
    for(let i=0;i<N;i++){if(gRe[i]>maxV){maxV=gRe[i];maxI=i;}}
    if(maxI>N/2) maxI-=N;
    return maxI;
  }

  _fft(re, im) {
    const N=re.length;
    for(let i=1,j=0;i<N;i++){
      let bit=N>>1;
      for(;j&bit;bit>>=1) j^=bit;
      j^=bit;
      if(i<j){let t;t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}
    }
    for(let len=2;len<=N;len<<=1){
      const half=len>>1;
      const ang=-2*Math.PI/len;
      const wBR=Math.cos(ang),wBI=Math.sin(ang);
      for(let i=0;i<N;i+=len){
        let wR=1,wI=0;
        for(let k=0;k<half;k++){
          const uR=re[i+k],uI=im[i+k];
          const vR=re[i+k+half]*wR-im[i+k+half]*wI;
          const vI=re[i+k+half]*wI+im[i+k+half]*wR;
          re[i+k]=uR+vR;im[i+k]=uI+vI;
          re[i+k+half]=uR-vR;im[i+k+half]=uI-vI;
          const nR=wR*wBR-wI*wBI;wI=wR*wBI+wI*wBR;wR=nR;
        }
      }
    }
  }

  _ifft(re,im){
    const N=re.length;
    for(let i=0;i<N;i++) im[i]=-im[i];
    this._fft(re,im);
    for(let i=0;i<N;i++){re[i]/=N;im[i]=-im[i]/N;}
  }
}

registerProcessor('holla-processor', HollaProcessor);
