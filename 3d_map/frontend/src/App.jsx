import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { getSavedBuildings, getSessions, deleteSession } from './api.js'
import Landing from './components/Landing.jsx'
import Login from './components/Login.jsx'
import BuildingsMap from './components/BuildingsMap.jsx'

// heavy libs (maplibre ~800 KB, three + drei ~1 MB) load only on the pages /
// views that actually need them
const LidarMap = lazy(() => import('./components/LidarMap.jsx'))

const PageFallback = () => <div className="loading muted">loading…</div>

const ROLE_LABELS = { citizen: 'Citizen', surveyor: 'Surveyor', registrar: 'Registrar' }
const SESSION_KEY = 'layerd-session'

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY))
  } catch {
    return null
  }
}

function saveSession(s) {
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
  else sessionStorage.removeItem(SESSION_KEY)
}

export default function App() {
  const [session, setSession] = useState(loadSession)
  const updateSession = (s) => {
    setSession(s)
    saveSession(s)
  }

  return (
    <Routes>
      <Route path="/" element={<Home session={session} />} />
      <Route path="/login" element={<LoginRoute session={session} setSession={updateSession} />} />
      <Route
        path="/dashboard"
        element={
          session ? <Dashboard session={session} onLogout={() => updateSession(null)} /> : <Navigate to="/login" replace />
        }
      />
      <Route
        path="/lidar"
        element={
          session
            ? session.role === 'citizen'
              ? <Navigate to="/dashboard" replace />
              : <LidarPage session={session} onLogout={() => updateSession(null)} />
            : <Navigate to="/login" replace />
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function Home({ session }) {
  const navigate = useNavigate()
  if (session) return <Navigate to="/dashboard" replace />
  return <Landing onEnter={(role) => navigate(`/login?role=${role || 'citizen'}`)} />
}

function LoginRoute({ session, setSession }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  if (session) return <Navigate to="/dashboard" replace />
  return (
    <Login
      initialRole={params.get('role') || 'citizen'}
      onLogin={(s) => {
        setSession(s)
        navigate('/dashboard')
      }}
      onBack={() => navigate('/')}
    />
  )
}

function Topbar({ session, onLogout, children }) {
  return (
    <header className="topbar">
      <div>
        <h1>Layerd</h1>
        <span className="muted tiny">3D cadastral system · SIH26095</span>
      </div>
      <nav className="mode-switch">
        <NavLink to="/dashboard" end className={({ isActive }) => `btn ${isActive ? 'primary' : ''}`}>
          parcels
        </NavLink>
        {session.role !== 'citizen' && (
          <NavLink to="/lidar" className={({ isActive }) => `btn ${isActive ? 'primary' : ''}`}>
            LiDAR scan
          </NavLink>
        )}
      </nav>
      {children}
      <div className="session-box">
        <div className="session-user">
          <span className="session-name">{session.name}</span>
          <span className={`session-role role-${session.role}`}>{ROLE_LABELS[session.role]}</span>
        </div>
        <button className="btn" onClick={onLogout}>
          log out
        </button>
      </div>
    </header>
  )
}

function Dashboard({ session, onLogout }) {
  const [state, setState] = useState('loading') // loading | ready | empty | unavailable
  const [features, setFeatures] = useState([])
  const [sessions, setSessions] = useState([])
  const [activeSessions, setActiveSessions] = useState(null) // null = all visible
  const [selectedId, setSelectedId] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    Promise.all([getSavedBuildings(), getSessions()])
      .then(([fc, ss]) => {
        if (cancelled) return
        setFeatures(fc.features || [])
        setSessions(ss)
        setActiveSessions(new Set(ss.map((s) => s.session_id)))
        setState(fc.features?.length ? 'ready' : 'empty')
      })
      .catch(() => {
        if (cancelled) return
        setFeatures([])
        setSessions([])
        setState('unavailable')
      })
    return () => { cancelled = true }
  }, [reloadKey])

  // buildings from the visible sessions only
  const visibleFeatures = useMemo(
    () =>
      !activeSessions || activeSessions.size === 0
        ? features
        : features.filter((f) => activeSessions.has(f.properties.session_id)),
    [features, activeSessions],
  )

  const toggleSession = (sid) => {
    setActiveSessions((prev) => {
      const next = new Set(prev || sessions.map((s) => s.session_id))
      if (next.has(sid)) next.delete(sid)
      else next.add(sid)
      return next
    })
  }

  const removeSession = (sid) => {
    deleteSession(sid)
      .then(() => setReloadKey((k) => k + 1))
      .catch((e) => console.error('session delete failed:', e))
  }

  const canScan = session.role !== 'citizen' // citizens view saved scans only
  const canEdit = session.role === 'surveyor' // surveyor edits, registrar views

  const selected = useMemo(
    () => visibleFeatures.find((f) => f.properties.building_id === selectedId)?.properties ?? null,
    [visibleFeatures, selectedId],
  )

  const stats = useMemo(() => {
    const n = visibleFeatures.length
    if (!n) return null
    const fromLidar = visibleFeatures.filter((f) => f.properties.height_source === 'lidar').length
    const assumed = visibleFeatures.filter((f) => f.properties.height_source === 'assumed-1-story').length
    const edited = visibleFeatures.filter((f) => ['edited', 'manual'].includes(f.properties.height_source)).length
    const heights = visibleFeatures.map((f) => f.properties.height_m || 0)
    return {
      n,
      fromLidar,
      assumed,
      edited,
      tallest: Math.max(...heights),
      mean: heights.reduce((a, b) => a + b, 0) / n,
    }
  }, [visibleFeatures])

  return (
    <div className="app">
      <Topbar session={session} onLogout={onLogout} />

      <div className="parcel-strip">
        <span className="muted tiny">
          buildings from saved LiDAR scans — pan the map anywhere, or run a new scan
        </span>
        <span style={{ flex: 1 }} />
        {state === 'ready' && (
          <span className="mono tiny">{stats.n} buildings · tallest {stats.tallest} m</span>
        )}
        <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>refresh</button>
        {canScan && <NavLink to="/lidar" className="btn">new scan</NavLink>}
      </div>

      <main className="workspace">
        <section className="viewport">
          {state === 'ready' && (
            <BuildingsMap features={visibleFeatures} selectedId={selectedId} onSelect={setSelectedId} />
          )}
          {state === 'loading' && <div className="loading muted">loading saved buildings…</div>}
          {state === 'empty' && (
            <div className="lidar-empty muted">
              <h3>No buildings yet</h3>
              <p>run a LiDAR scan to generate building footprints and heights — they will appear here, stored in PostGIS.</p>
              {canScan && <NavLink to="/lidar" className="btn primary">open LiDAR scan</NavLink>}
            </div>
          )}
          {state === 'unavailable' && (
            <div className="lidar-empty muted">
              <h3>PostGIS unavailable</h3>
              <p>start PostgreSQL and refresh — saved buildings live in the <span className="mono">layerd</span> database.</p>
              <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>retry</button>
            </div>
          )}
        </section>

        <aside className="sidebar">
          <div className="panel-section">
            <h3>scan sessions</h3>
            {sessions.length ? (
              sessions.map((s) => {
                const active = !activeSessions || activeSessions.has(s.session_id)
                return (
                  <div key={s.session_id} className={`session-row ${active ? '' : 'off'}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggleSession(s.session_id)}
                      />
                      <span className="session-label" title={s.session_id}>
                        {s.label || s.session_id}
                      </span>
                    </label>
                    <span className="muted tiny mono">{s.buildings} bld</span>
                    {canEdit && (
                      <button
                        className="btn danger tiny"
                        title="delete this session and its buildings"
                        onClick={() => removeSession(s.session_id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )
              })
            ) : (
              <p className="muted tiny">no sessions yet</p>
            )}
          </div>

          <div className="panel-section">
            <h3>saved buildings</h3>
            {stats ? (
              <table className="kv">
                <tbody>
                  <tr><td>buildings</td><td>{stats.n}</td></tr>
                  <tr><td>from LiDAR</td><td>{stats.fromLidar}</td></tr>
                  <tr><td>assumed 1 storey</td><td>{stats.assumed}</td></tr>
                  <tr><td>edited / manual</td><td>{stats.edited}</td></tr>
                  <tr><td>tallest</td><td>{stats.tallest} m</td></tr>
                  <tr><td>mean height</td><td>{stats.mean.toFixed(1)} m</td></tr>
                </tbody>
              </table>
            ) : (
              <p className="muted tiny">nothing saved yet</p>
            )}
            <p className="muted tiny" style={{ marginTop: 10 }}>
              data lives in PostgreSQL/PostGIS (<span className="mono">layerd.lidar_buildings</span>) — click any building on the map for details.
            </p>
          </div>

          {selected && (
            <div className="panel-section">
              <h3>building details</h3>
              <table className="kv">
                <tbody>
                  <tr><td>id</td><td className="mono">{selected.building_id}</td></tr>
                  {selected.name && <tr><td>name</td><td>{selected.name}</td></tr>}
                  <tr><td>height</td><td>{selected.height_m} m</td></tr>
                  <tr><td>storeys</td><td>{selected.stories}</td></tr>
                  <tr><td>ground Z</td><td>{selected.ground_z ?? '—'}</td></tr>
                  <tr><td>roof Z</td><td>{selected.roof_z ?? '—'}</td></tr>
                  <tr><td>LiDAR points</td><td>{selected.lidar_points}</td></tr>
                  <tr><td>source</td><td>{selected.height_source}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}

function LidarPage({ session, onLogout }) {
  return (
    <div className="app">
      <Topbar session={session} onLogout={onLogout} />
      <Suspense fallback={<PageFallback />}>
        <LidarMap canEdit={session.role === 'surveyor'} />
      </Suspense>
    </div>
  )
}
