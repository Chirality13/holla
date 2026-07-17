/**
 * KNN Classifier for tap fingerprints — v2
 *
 * Feature vector (6 values):
 *   [ild, sc, bandLow, bandMid, bandHigh, logEnergy]
 *
 *   ild      – Inter-channel Level Difference (−1…+1). Primary spatial feature.
 *              Measures which microphone "heard" the tap louder.
 *   sc       – Spectral centroid (0…1). Encodes the dominant frequency.
 *   bandLow  – Fraction of energy in 0–1 kHz (table resonance).
 *   bandMid  – Fraction of energy in 1–8 kHz (main tap transient).
 *   bandHigh – Fraction of energy in 8–24 kHz (high-frequency click).
 *   logEnergy– Log10 RMS energy. Low weight — varies with tap force.
 *
 * Weights are tuned for Intel SST microphone arrays where ILD is the
 * dominant reliable spatial indicator.
 */
class KNNClassifier {
  constructor(k = 3) {
    this.k       = k;
    this.samples = [];
    // Weights per feature: [ild, sc, bLow, bMid, bHigh, logE]
    this.weights = [15, 4, 6, 5, 3, 0.3];
  }

  /** Rebuild from stored button profiles. */
  loadFromButtons(buttons) {
    this.samples = [];
    for (const btn of buttons) {
      for (const f of (btn.samples || [])) {
        this.samples.push({ buttonId: btn.id, name: btn.name, features: f });
      }
    }
  }

  addSample(buttonId, name, features) {
    this.samples.push({ buttonId, name, features });
  }

  clearButton(buttonId) {
    this.samples = this.samples.filter(s => s.buttonId !== buttonId);
  }

  get sampleCount() { return this.samples.length; }

  /** Weighted Euclidean distance. */
  _distance(a, b) {
    let s = 0;
    const len = Math.min(a.length, b.length, this.weights.length);
    for (let i = 0; i < len; i++) {
      const d = (a[i] - b[i]) * this.weights[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }

  /**
   * Classify a feature vector.
   * Returns { buttonId, name, confidence, distance } or null.
   */
  classify(features) {
    if (this.samples.length === 0) return null;

    const dists = this.samples.map(s => ({
      ...s, dist: this._distance(features, s.features)
    }));
    dists.sort((a, b) => a.dist - b.dist);

    const k     = Math.min(this.k, dists.length);
    const nbrs  = dists.slice(0, k);

    // Majority vote
    const votes = {};
    for (const n of nbrs) votes[n.buttonId] = (votes[n.buttonId] || 0) + 1;

    let max = 0, winnerId = null;
    for (const [id, c] of Object.entries(votes)) {
      if (c > max) { max = c; winnerId = id; }
    }

    const winner = nbrs.find(n => n.buttonId === winnerId);
    return {
      buttonId:   winnerId,
      name:       winner.name,
      confidence: max / k,
      distance:   nbrs[0].dist
    };
  }
}

module.exports = KNNClassifier;
