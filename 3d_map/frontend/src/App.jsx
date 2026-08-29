import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { getParcels, getParcel, getSavedBuildings, getSavedStatus } from './api.js'
import Landing from './components/Landing.jsx'
import Login from './components/Login.jsx'
import UnitPanel from './components/UnitPanel.jsx'
import SurveyorPanel from './components/SurveyorPanel.jsx'
import RegistrarPanel from './components/RegistrarPanel.jsx'
import LedgerView from './components/LedgerView.jsx'
import NgdrsModal from './components/NgdrsModal.jsx'

// heavy libs (maplibre ~800 KB, three + drei ~1 MB) load only on the pages /
// views that actually need them
const ParcelMap = lazy(() => import('./components/ParcelMap.jsx'))
const Building3D = lazy(() => import('./components/Building3D.jsx'))
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
          session ? <LidarPage session={session} onLogout={() => updateSession(null)} /> : <Navigate to="/login" replace />
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
        <NavLink to="/lidar" className={({ isActive }) => `btn ${isActive ? 'primary' : ''}`}>
          LiDAR scan
        </NavLink>
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

function LidarPage({ session, onLogout }) {
  return (
    <div className="app">
      <Topbar session={session} onLogout={onLogout} />
      <Suspense fallback={<PageFallback />}>
        <LidarMap />
      </Suspense>
    </div>
  )
}

function Dashboard({ session, onLogout }) {
  const [parcels, setParcels] = useState([])
  const [selectedUlpin, setSelectedUlpin] = useState(null)
  const [parcel, setParcel] = useState(null)
  const [view3d, setView3d] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState(null)
  const [conflicts, setConflicts] = useState(new Set())
  const [search, setSearch] = useState('')
  const [showNgdrs, setShowNgdrs] = useState(false)
  const [lidarShow, setLidarShow] = useState(false)
  const [lidarFC, setLidarFC] = useState(null)
  const [lidarCount, setLidarCount] = useState(null)

  const role = session?.role ?? null

  useEffect(() => {
    getParcels()
      .then((ps) => {
        setParcels(ps)
        if (!selectedUlpin && ps.length) setSelectedUlpin(ps[0].ulpin)
      })
      .catch((e) => console.error(e))
    getSavedStatus()
      .then((s) => setLidarCount(s.available ? s.count : null))
      .catch(() => setLidarCount(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleLidarBuildings = () => {
    const next = !lidarShow
    setLidarShow(next)
    if (next && !lidarFC) {
      getSavedBuildings()
        .then(setLidarFC)
        .catch((e) => console.error('LiDAR buildings fetch failed:', e))
    }
  }

  const refreshParcel = useCallback(() => {
    if (!selectedUlpin || !role) return
    getParcel(selectedUlpin, role).then(setParcel).catch(console.error)
  }, [selectedUlpin, role])

  useEffect(() => {
    refreshParcel()
  }, [refreshParcel])
  useEffect(() => {
    setSelectedUnit(null)
    setConflicts(new Set())
  }, [selectedUlpin])

  const unit = useMemo(
    () => parcel?.units?.find((u) => u.unit_ulpin === selectedUnit) || null,
    [parcel, selectedUnit],
  )

  const filteredParcels = parcels.filter((p) =>
    p.ulpin.toLowerCase().includes(search.toLowerCase()),
  )

  const onFocusUnit = (unitUlpin, parcelUlpin) => {
    // FR21: auto-switch parcel and jump to 3D view so disputed unit is visible
    if (parcelUlpin && parcelUlpin !== selectedUlpin) {
      setSelectedUlpin(parcelUlpin)
    }
    setView3d(true)
    setSelectedUnit(unitUlpin)
    // Only highlight red if unit is actually in conflict
    setConflicts((prev) => {
      const unit = parcel?.units?.find((u) => u.unit_ulpin === unitUlpin)
      if (unit?.validation_status === 'conflict') {
        return new Set([...prev, unitUlpin])
      }
      return prev
    })
  }

  return (
    <div className="app">
      <Topbar session={session} onLogout={onLogout}>
        <input
          className="search"
          placeholder="search ULPIN e.g. TN-02-6001-2345-6789"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Topbar>

      <div className="parcel-strip">
        {filteredParcels.map((p) => (
          <button
            key={p.ulpin}
            className={`parcel-chip ${p.ulpin === selectedUlpin ? 'active' : ''}`}
            onClick={() => setSelectedUlpin(p.ulpin)}
          >
            <span className="mono">{p.ulpin}</span>
            <span className="muted tiny">
              {p.district}, {p.state} · {p.unit_count} units
            </span>
          </button>
        ))}
        {parcels.length > 0 && filteredParcels.length === 0 && (
          <span className="muted">no parcel matches “{search}”</span>
        )}
      </div>

      {parcel && (
        <main className="workspace">
          <section className="viewport">
            <div className="view-toolbar">
              <button className={`btn ${!view3d ? 'primary' : ''}`} onClick={() => setView3d(false)}>
                3D map
              </button>
              <button
                className={`btn ${view3d ? 'primary' : ''}`}
                onClick={() => setView3d(true)}
                disabled={!parcel.has_vertical_structure}
                title={parcel.has_vertical_structure ? '' : 'no vertical structure on this parcel yet'}
              >
                3D building{parcel.has_vertical_structure ? '' : ' (unavailable)'}
              </button>
              <button
                className={`btn ${lidarShow ? 'primary' : ''}`}
                onClick={toggleLidarBuildings}
                title="show buildings generated from the LiDAR scan (stored in PostGIS)"
              >
                LiDAR buildings{lidarCount != null ? ` (${lidarCount})` : ''}
              </button>
              {parcel.has_vertical_structure && !view3d && <span className="badge-flag">⚑ this parcel has 3D vertical units</span>}
            </div>
            {!view3d ? (
              <Suspense fallback={<PageFallback />}>
                <ParcelMap
                  parcels={parcels}
                  selectedUlpin={selectedUlpin}
                  onSelect={setSelectedUlpin}
                  lidarFeatures={lidarShow ? (lidarFC?.features ?? []) : null}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<PageFallback />}>
                <Building3D
                  parcel={parcel}
                  units={parcel.units || []}
                  selected={selectedUnit}
                  conflictIds={conflicts}
                  onSelect={setSelectedUnit}
                />
              </Suspense>
            )}
            <div className="legend">
              <span><i style={{ background: '#4da3ff' }} /> owned</span>
              <span><i style={{ background: '#ffb84d' }} /> leased</span>
              <span><i style={{ background: '#8f9aa8' }} /> common</span>
              <span><i style={{ background: '#b07aff' }} /> air-rights</span>
              <span><i style={{ background: '#ff4d4d' }} /> conflict</span>
              {lidarShow && <span><i style={{ background: '#2fbf8f' }} /> LiDAR buildings</span>}
            </div>
          </section>

          <aside className="sidebar">
            <div className="panel-section">
              <h3>{parcel.district}, {parcel.state}</h3>
              <table className="kv">
                <tbody>
                  <tr><td>base ULPIN</td><td className="mono">{parcel.ulpin}</td></tr>
                  <tr><td>floors</td><td>G+{parcel.floor_count - 1}{parcel.basement_count ? ` · B${parcel.basement_count}` : ''}</td></tr>
                  <tr><td>floor height</td><td>{parcel.floor_height_m} m</td></tr>
                  <tr><td>vertical units</td><td>{parcel.units?.length ?? 0}</td></tr>
                </tbody>
              </table>
              {(role === 'registrar' || role === 'surveyor') && (
                <button className="btn" onClick={() => setShowNgdrs(true)}>
                  push to NGDRS (mock)
                </button>
              )}
            </div>

            <div className="panel-section">
              <h3>unit details</h3>
              <UnitPanel unit={unit} role={role} onDisputeSubmitted={refreshParcel} />
            </div>

            {role === 'surveyor' && (
              <SurveyorPanel parcel={parcel} onUnitsChanged={refreshParcel} setConflicts={setConflicts} />
            )}

            {role === 'registrar' && (
              <>
                <RegistrarPanel onFocusUnit={onFocusUnit} />
                <div className="panel-section">
                  <h3>ownership ledger</h3>
                  {selectedUnit ? (
                    <LedgerView unitUlpin={selectedUnit} role={role} />
                  ) : (
                    <p className="muted">select a unit to inspect its hash-chained history</p>
                  )}
                </div>
              </>
            )}

            {role === 'citizen' && selectedUnit && (
              <div className="panel-section">
                <h3>ownership history</h3>
                <LedgerView unitUlpin={selectedUnit} role={role} />
              </div>
            )}
          </aside>
        </main>
      )}

      {!parcel && <div className="loading muted">loading parcels…</div>}

      {showNgdrs && <NgdrsModal parcelUlpin={selectedUlpin} onClose={() => setShowNgdrs(false)} />}
    </div>
  )
}
