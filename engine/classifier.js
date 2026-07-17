/**
 * KNN Classifier for tap fingerprints — v3 (14-Dimensional Manifold)
 *
 * Feature vector (14 values):
 *   [ild, logEnergy, band0 ... band11]
 *
 *   ild      – Inter-channel Level Difference (−1…+1). Primary spatial feature.
 *   logEnergy– Log10 RMS energy. Low weight.
 *   bandX    – 12 logarithmic Mel-scaled frequency bands (0...1 fraction of energy).
 */
class KNNClassifier {
  constructor(k = 3) {
    this.k = k;
    this.samples = [];
    
    // Feature vector: [ild, logE, b0..b11]
    // The weights represent (Normalization Scale × Importance)
    // ILD: scale 50, importance 1.0 -> 50
    // LogE: scale 25, importance 0.1 -> 2.5
    // Bands: scale 100, importance 1.5 -> 150
    this.weights = [50, 2.5, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150];
    
    // Cache per-button dynamic thresholds
    this.buttonThresholds = {};
  }

  /** Rebuild from stored button profiles and calculate standard deviations. */
  loadFromButtons(buttons) {
    this.samples = [];
    this.buttonThresholds = {};
    
    for (const btn of buttons) {
      if (!btn.samples || btn.samples.length === 0) continue;
      
      for (const f of btn.samples) {
        this.samples.push({ buttonId: btn.id, name: btn.name, features: f });
      }
      
      // Calculate variance / dynamic threshold for this button
      let totalDist = 0;
      let comparisons = 0;
      const n = btn.samples.length;
      
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          totalDist += this._distance(btn.samples[i], btn.samples[j]);
          comparisons++;
        }
      }
      
      const meanDist = comparisons > 0 ? totalDist / comparisons : 0;
      // Rejection threshold is mean intra-class distance + an expansion factor
      // A tight cluster means strict rejection. A loose cluster means slightly wider bounds.
      this.buttonThresholds[btn.id] = Math.max(30, meanDist * 2.5);
    }
  }

  addSample(buttonId, name, features) {
    this.samples.push({ buttonId, name, features });
  }

  clearButton(buttonId) {
    this.samples = this.samples.filter(s => s.buttonId !== buttonId);
    delete this.buttonThresholds[buttonId];
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
   * Returns { buttonId, name, confidence, distance, threshold } or null.
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
    const dynamicThreshold = this.buttonThresholds[winnerId] || 150; // Fallback
    
    return {
      buttonId:   winnerId,
      name:       winner.name,
      confidence: max / k,
      distance:   nbrs[0].dist,
      threshold:  dynamicThreshold
    };
  }
}

module.exports = KNNClassifier;
