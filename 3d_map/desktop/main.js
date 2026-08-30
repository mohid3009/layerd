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
const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('child_process')
const http = require('http')
const net = require('net')
const path = require('path')
const fs = require('fs')

const DEV = !!process.env.ELECTRON_DEV || process.argv.includes('--dev')
const DEV_PORT = process.env.BACKEND_PORT || 8000
const ROOT = path.join(__dirname, '..', '..') // repo root

let backend = null
let backendUrl = null
let win = null

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
  win.on('closed', () => {
    win = null
  })
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

app.whenReady().then(async () => {
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
    return errorWindow(
      'Check that the <code>lidarvenv</code> Python environment exists at the repo root ' +
        '(or that <code>python</code> is on PATH).',
    )
  }
  createWindow(backendUrl)
})

app.on('window-all-closed', () => {
  stopBackend()
  app.quit()
})
