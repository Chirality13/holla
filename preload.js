/**
 * Preload — context bridge between renderer and main process.
 * contextIsolation: true, nodeIntegration: false.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('holla', {
  // ── Profile / Storage ───────────────────────────────────────────────────
  getProfile:     ()       => ipcRenderer.invoke('get-profile'),
  saveButtons:    (btns)   => ipcRenderer.invoke('save-buttons', btns),
  saveSettings:   (cfg)    => ipcRenderer.invoke('save-settings', cfg),

  // ── Action execution (main process) ────────────────────────────────────
  executeAction:  (action) => ipcRenderer.invoke('execute-action', action),

  // ── Window controls ─────────────────────────────────────────────────────
  minimize:       ()       => ipcRenderer.send('window-minimize'),
  maximize:       ()       => ipcRenderer.send('window-maximize'),
  close:          ()       => ipcRenderer.send('window-close'),

  // ── Notifications / events from main ───────────────────────────────────
  onToggleListen: (cb)     => ipcRenderer.on('toggle-listening', (_e, v) => cb(v)),

  // ── Tap fired (notify main for tray badge / native notification) ────────
  tapFired: (buttonName)   => ipcRenderer.send('tap-fired', buttonName),

  // ── Platform info ───────────────────────────────────────────────────────
  platform: process.platform
});
