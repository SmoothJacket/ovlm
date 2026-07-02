'use strict'
const { app, BrowserWindow, shell } = require('electron')
const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs   = require('fs')

const ROOT = path.join(__dirname, '..')

// Ensure child processes can see Homebrew and user-installed tools
const ENV = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH]
    .filter(Boolean).join(':'),
}

// Prefer the project venv (created by install_mac.sh) so packages like
// omnipresense are available without polluting the system Python.
// Falls back to whatever python3 is first on PATH (Homebrew, pyenv, etc.).
const VENV_PYTHON = path.join(ROOT, 'nuc', '.venv', 'bin', 'python3')
const PYTHON3 = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3'

// npm: resolve via PATH (works on both Intel /usr/local and Apple Silicon /opt/homebrew)
const NPM = (() => {
  const r = spawnSync('which', ['npm'], { env: ENV, encoding: 'utf8' })
  return (r.stdout || '').trim() || 'npm'
})()

let viteProc    = null
let backendProc = null
let mainWin     = null

// ── Backend ───────────────────────────────────────────────────────────────────
function startBackend() {
  backendProc = spawn(PYTHON3, ['nuc/main.py'], { cwd: ROOT, env: ENV })
  backendProc.stdout.on('data', d => process.stdout.write('[backend] ' + d))
  backendProc.stderr.on('data', d => process.stderr.write('[backend] ' + d))
  backendProc.on('exit', code => console.log('[backend] exited', code ?? ''))
}

// ── Vite dev server ───────────────────────────────────────────────────────────
// Returns the actual URL Vite chose (port may vary if 5173 is busy).
function startVite() {
  return new Promise((resolve, reject) => {
    viteProc = spawn(NPM, ['run', 'dev'], { cwd: ROOT, env: ENV })
    const timer = setTimeout(() => reject(new Error('Vite timed out after 30 s')), 30_000)

    viteProc.stdout.on('data', d => {
      const s = d.toString()
      process.stdout.write('[vite] ' + s)
      // "  ➜  Local:   http://localhost:5173/" (port may differ)
      const m = s.match(/Local:\s+(http:\/\/localhost:\d+\/)/)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    })
    viteProc.stderr.on('data', d => process.stderr.write('[vite] ' + d))
    viteProc.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0 && code !== null) reject(new Error('Vite exited with code ' + code))
    })
  })
}

// ── Main window ───────────────────────────────────────────────────────────────
async function createWindow() {
  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'OVLM',
    backgroundColor: '#0b1220',
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWin.on('closed', () => { mainWin = null })

  // Open anchor target="_blank" links in the system browser, not a new window
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Show a loading screen while Vite spins up
  mainWin.loadURL('data:text/html,<meta charset="utf-8">' +
    '<style>body{background:#0b1220;display:flex;align-items:center;justify-content:center;' +
    'height:100vh;margin:0;font-family:system-ui;color:#64748b;font-size:14px}</style>' +
    '<body>Starting OVLM…</body>')

  try {
    const viteUrl = await startVite()
    mainWin.loadURL(viteUrl)
  } catch (err) {
    console.error('[electron]', err.message)
    mainWin.loadURL('data:text/html,<meta charset="utf-8">' +
      '<style>body{background:#0b1220;color:#f87171;font-family:monospace;padding:2rem;margin:0}</style>' +
      '<body><b>Failed to start frontend</b><br>' + err.message + '</body>')
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  startBackend()
  await createWindow()

  // macOS: re-open window when clicking the dock icon with no windows
  app.on('activate', () => { if (mainWin === null) createWindow() })
})

app.on('window-all-closed', () => { app.quit() })

app.on('before-quit', () => {
  viteProc?.kill('SIGTERM')
  backendProc?.kill('SIGTERM')
})
