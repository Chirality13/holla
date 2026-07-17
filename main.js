/**
 * main.js — Electron main process
 * Responsibilities:
 *   • Window lifecycle & tray management
 *   • IPC handlers (profile CRUD, action execution, window controls)
 *   • Screenshot capture via PowerShell
 *   • Native notifications
 */

const {
  app, BrowserWindow, ipcMain, Tray, Menu,
  nativeImage, shell, Notification
} = require('electron');
const path        = require('path');
const { exec, spawn } = require('child_process');
const ProfileStore = require('./store/profiles');

// ── Globals ────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray       = null;
let store      = null;

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1120,
    height:          720,
    minWidth:        900,
    minHeight:       580,
    frame:           false,       // custom title bar
    transparent:     false,
    backgroundColor: '#05090f',
    show:            false,
    icon:            path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Allow microphone access for getUserMedia in the renderer
      webSecurity:      true,
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Hide to tray instead of closing
  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  // Grant microphone permission automatically (desktop app)
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'mediaKeySystem');
  });
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media';
  });
}

// ── System Tray ────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch { icon = nativeImage.createEmpty(); }

  tray = new Tray(icon);
  tray.setToolTip('Holla — Table Tap Interface');
  rebuildTrayMenu(true);

  tray.on('double-click', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

function rebuildTrayMenu(listening) {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Dashboard',
      click: () => { mainWindow.show(); mainWindow.focus(); }
    },
    { type: 'separator' },
    {
      label:   listening ? '● Listening' : '○ Paused',
      enabled: false
    },
    {
      label: listening ? 'Pause Listening' : 'Resume Listening',
      click: () => {
        const next = !listening;
        mainWindow.webContents.send('toggle-listening', next);
        rebuildTrayMenu(next);
      }
    },
    { type: 'separator' },
    { label: 'Quit Holla', click: () => app.exit(0) }
  ]);
  tray.setContextMenu(menu);
}

// ── IPC Handlers ───────────────────────────────────────────────────────────

// Profile
ipcMain.handle('get-profile', () => store.getData());
ipcMain.handle('save-buttons',  (_e, btns) => { store.setButtons(btns);     return true; });
ipcMain.handle('save-settings', (_e, cfg)  => { store.updateSettings(cfg);  return true; });

// Action execution
ipcMain.handle('execute-action', async (_e, action) => {
  try {
    switch (action.type) {
      case 'open_url':
        await shell.openExternal(action.value);
        break;

      case 'launch_app':
        // On Windows, use 'start' to launch without blocking
        if (process.platform === 'win32') {
          exec(`start "" "${action.value}"`);
        } else {
          spawn(action.value, [], { detached: true, stdio: 'ignore' }).unref();
        }
        break;

      case 'screenshot':
        await takeScreenshot();
        break;

      case 'custom_command':
        exec(action.value, { timeout: 10000 });
        break;
    }
    return { ok: true };
  } catch (err) {
    console.error('[action]', err.message);
    return { ok: false, error: err.message };
  }
});

// Window controls
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow.hide());

// Tap fired — show native notification
ipcMain.on('tap-fired', (_e, buttonName) => {
  if (!store.getSettings().notifyOnTap) return;
  if (Notification.isSupported()) {
    new Notification({
      title:  'Holla',
      body:   `"${buttonName}" triggered`,
      silent: true,
      icon:   path.join(__dirname, 'assets', 'icon.png')
    }).show();
  }
});

// ── Screenshot (Windows PowerShell) ───────────────────────────────────────
function takeScreenshot() {
  return new Promise((resolve) => {
    const desktop  = app.getPath('desktop');
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `Holla-${ts}.png`;
    const outPath  = path.join(desktop, filename).replace(/\\/g, '\\\\');

    const ps = [
      'Add-Type -Assembly System.Windows.Forms,System.Drawing;',
      `$s=[System.Windows.Forms.Screen]::PrimaryScreen;`,
      `$b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height);`,
      `$g=[System.Drawing.Graphics]::FromImage($b);`,
      `$g.CopyFromScreen($s.Bounds.Location,[System.Drawing.Point]::Empty,$s.Bounds.Size);`,
      `$b.Save('${outPath}');`,
      `$g.Dispose();$b.Dispose()`
    ].join(' ');

    exec(`powershell -WindowStyle Hidden -Command "& { ${ps} }"`, (err) => {
      if (!err && Notification.isSupported()) {
        new Notification({
          title: 'Holla',
          body:  `Screenshot saved: ${filename}`,
          icon:  path.join(__dirname, 'assets', 'icon.png')
        }).show();
      }
      resolve(!err);
    });
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  store = new ProfileStore(app.getPath('userData'));
  createWindow();
  createTray();
});

// Prevent default quit; the user exits via tray menu
app.on('window-all-closed', () => { /* intentionally empty — tray app */ });
app.on('activate', () => {
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
});

// Clean exit
app.on('before-quit', () => {
  mainWindow.removeAllListeners('close');
});
