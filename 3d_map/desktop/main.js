/*
 * Layerd desktop shell (Electron).
 *
 * - Spawns the FastAPI backend (lidarvenv python + uvicorn) as a child process
 *   on a FREE port (dev mode: fixed 8000 so the Vite proxy finds it) and waits
 *   for it to become healthy.
 * - Loads the built frontend served BY the backend so the UI and the API share
 *   one origin — no CORS, no proxy.
 * - Dev mode (`electron . --dev` or ELECTRON_DEV=1) loads the Vite dev server
 *   at http://localhost:5173 instead — run `npm run dev` in 3d_map/frontend
 *   alongside it.
 *
 * PostgreSQL must be running locally (the app degrades gracefully without it).
 */
const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron')
const { spawn } = require('child_process')
const http = require('http')
const net = require('net')
const path = require('path')
const fs = require('fs')

const DEV = !!process.env.ELECTRON_DEV || process.argv.includes('--dev')
const DEV_PORT = process.env.BACKEND_PORT || 8000
const ROOT = path.join(__dirname, '..', '..') // repo root
// --hidden: start minimized to the tray (used as the login-item launch arg)
const HIDDEN_LAUNCH = process.argv.includes('--hidden') || process.env.ELECTRON_HIDDEN === '1'

let backend = null
let backendUrl = null
let win = null
let tray = null
let quitting = false

function pythonExe() {
  const venvWin = path.join(ROOT, 'lidarvenv', 'Scripts', 'python.exe')
  const venvNix = path.join(ROOT, 'lidarvenv', 'bin', 'python')
  if (fs.existsSync(venvWin)) return venvWin
  if (fs.existsSync(venvNix)) return venvNix
  return 'python' // fallback: whatever python is on PATH
}

// ask the OS for a port that is currently free (production mode)
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function startBackend(port) {
  const args = ['-m', 'uvicorn', 'app.main:app', '--port', String(port)]
  if (DEV) args.push('--reload')
  backend = spawn(pythonExe(), args, {
    cwd: path.join(ROOT, '3d_map', 'backend'),
    windowsHide: true,
  })
  backend.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backend.on('exit', (code) => console.log(`[backend] exited with code ${code}`))
}

function stopBackend() {
  if (backend) {
    try {
      backend.kill()
    } catch {}
    backend = null
  }
}

function pingBackend(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/lidar/buildings/status`, (res) => {
      res.resume()
      resolve(res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitBackend(url, ms = 30000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await pingBackend(url)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'Layerd',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.setWindowOpenHandler(({ url: external }) => {
    shell.openExternal(external)
    return { action: 'deny' }
  })
  win.loadURL(url)
  win.on('close', (e) => {
    // running in tray mode: hide instead of closing so the backend keeps running
    if (tray && !quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    win = null
  })
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
  } else if (backendUrl) {
    createWindow(backendUrl)
  }
}

function errorWindow(message) {
  win = new BrowserWindow({
    width: 580,
    height: 260,
    title: 'Layerd — backend failed to start',
    autoHideMenuBar: true,
  })
  win.loadURL(
    'data:text/html,<body style="font-family:sans-serif;background:%230e0e0e;color:%23f5f5f7;padding:24px">' +
      '<h2>Backend failed to start</h2>' +
      '<p style="color:%23a1a1a6">' + message + '</p></body>',
  )
}

/* ---------------- open at login ---------------- */

// args used for the login-item registration. Unpackaged apps run through
// electron.exe, so the app directory must be passed as an argument too.
function loginItemArgs() {
  return app.isPackaged ? ['--hidden'] : ['.', '--hidden']
}

function setOpenAtLogin(enabled) {
  if (DEV) return // never touch the registry from a dev session
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: process.execPath,
    args: loginItemArgs(),
  })
}

function getOpenAtLogin() {
  if (DEV) return false
  return !!app.getLoginItemSettings({ args: loginItemArgs() }).openAtLogin
}

// enabled by default on the first production run; toggleable from the tray menu
function syncLoginItem() {
  if (DEV || getOpenAtLogin()) return
  setOpenAtLogin(true)
}

/* ---------------- tray ---------------- */

// 16x16 blocky "L" drawn as raw BGRA — no icon asset needed
function makeTrayIcon() {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const px = (x, y, on) => {
    const i = (y * size + x) * 4
    buf[i] = buf[i + 1] = buf[i + 2] = on ? 0xff : 0
    buf[i + 3] = on ? 0xff : 0
  }
  for (let y = 3; y < 13; y++) for (let x = 4; x < 7; x++) px(x, y, true) // vertical stroke
  for (let y = 10; y < 13; y++) for (let x = 4; x < 12; x++) px(x, y, true) // horizontal foot
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

function createTray() {
  tray = new Tray(makeTrayIcon())
  tray.setToolTip('Layerd')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Layerd', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: getOpenAtLogin(),
        click: (item) => setOpenAtLogin(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Quit Layerd',
        click: () => {
          quitting = true
          stopBackend()
          app.quit()
        },
      },
    ]),
  )
  tray.on('double-click', () => showWindow())
}

// single instance: a manual launch while the app already runs from login
// just focuses the existing window instead of spawning a second backend
const gotLock = app.requestSingleInstanceLock()
if (gotLock) {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    syncLoginItem()
    createTray()
    if (DEV) {
      // dev mode: fixed port so the Vite proxy (5173 -> 8000) finds the backend
      backendUrl = `http://localhost:${DEV_PORT}`
      startBackend(DEV_PORT)
      const ok = await waitBackend(backendUrl)
      if (!ok) return errorWindow('The backend did not become healthy — check the console output.')
      createWindow('http://localhost:5173')
      win.webContents.openDevTools({ mode: 'detach' })
      return
    }
    // production mode: bind a free port so we never clash with a dev server
    const port = await getFreePort()
    backendUrl = `http://localhost:${port}`
    startBackend(port)
    const ok = await waitBackend(backendUrl)
    if (!ok) {
      if (HIDDEN_LAUNCH) return // silent at login; user can open from the tray later
      return errorWindow(
        'Check that the <code>lidarvenv</code> Python environment exists at the repo root ' +
          '(or that <code>python</code> is on PATH).',
      )
    }
    if (!HIDDEN_LAUNCH) createWindow(backendUrl)
  })
} else {
  app.quit()
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  // stay alive in the tray unless the user explicitly quit from the tray menu
  if (quitting) {
    stopBackend()
    app.quit()
  }
})
