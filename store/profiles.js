/**
 * ProfileStore — simple JSON persistence layer using app.getPath('userData')
 * No external deps, runs in the Electron main process.
 */
const fs   = require('fs');
const path = require('path');

class ProfileStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'holla-profiles.json');
    this.data     = this._load();
  }

  _defaults() {
    return {
      buttons: [],
      settings: {
        snrThreshold: 25,      // tap must be 25× above ambient noise floor
        cooldown:     400,     // ms between taps
        k:            3,       // KNN neighbours
        maxDistance:  150,     // max KNN distance to accept a classification
        fftSize:      2048,    // GCC-PHAT window
        notifyOnTap:  true,    // native notification
        debugMode:    false    // show raw feature values
      }
    };
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so new settings keys always exist
      return {
        buttons:  parsed.buttons  || [],
        settings: Object.assign({}, this._defaults().settings, parsed.settings || {})
      };
    } catch {
      return this._defaults();
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ProfileStore] save failed:', err.message);
    }
  }

  getData()               { return JSON.parse(JSON.stringify(this.data)); }   // deep clone
  getButtons()            { return this.data.buttons; }
  getSettings()           { return this.data.settings; }

  setButtons(buttons) {
    this.data.buttons = buttons;
    this.save();
  }

  addButton(button) {
    this.data.buttons.push(button);
    this.save();
  }

  updateButton(id, updates) {
    const idx = this.data.buttons.findIndex(b => b.id === id);
    if (idx !== -1) {
      this.data.buttons[idx] = Object.assign({}, this.data.buttons[idx], updates);
      this.save();
    }
  }

  deleteButton(id) {
    this.data.buttons = this.data.buttons.filter(b => b.id !== id);
    this.save();
  }

  updateSettings(partial) {
    this.data.settings = Object.assign({}, this.data.settings, partial);
    this.save();
  }
}

module.exports = ProfileStore;
