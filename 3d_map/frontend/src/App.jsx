import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { getSavedBuildings, getSessions, deleteSession, updateBuilding, confirmBuildingEdit, deleteBuilding as deleteBuildingApi, getRegion } from './api.js'
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
  const [focusSid, setFocusSid] = useState(null) // focused session inside a region
  const [regionData, setRegionData] = useState({}) // cluster key -> { country, region }
  const [selCountry, setSelCountry] = useState(null)
  const [selRegion, setSelRegion] = useState(null) // "country||region" key
  const [selectedId, setSelectedId] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [editingBld, setEditingBld] = useState(false) // inline dashboard edit
  const [editDraft, setEditDraft] = useState(null)
  const [panelTab, setPanelTab] = useState('sessions') // registrar sidebar tab
  const [toast, setToast] = useState(null) // { kind: 'success' | 'info', text }
  const [resolvingIds, setResolvingIds] = useState(() => new Set()) // rows animating out
  const toastTimerRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    Promise.all([getSavedBuildings(), getSessions()])
      .then(([fc, ss]) => {
        if (cancelled) return
        setFeatures(fc.features || [])
        setSessions(ss)
        setSelCountry(null)
        setSelRegion(null)
        setFocusSid(null)
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

  // if PostgreSQL wasn't reachable (e.g. the desktop app launched before the
  // database finished starting), keep retrying every 5 seconds
  useEffect(() => {
    if (state !== 'unavailable') return
    const t = setTimeout(() => setReloadKey((k) => k + 1), 5000)
    return () => { clearTimeout(t) }
  }, [state, reloadKey])

  // proximity clusters of sessions — the bottom level of the country/region
  // tree (nearby scans of the same area stay together under their region)
  const clusters = useMemo(() => {
    const meta = new Map() // session_id -> { count, lon, lat }
    for (const f of features) {
      const sid = f.properties.session_id
      const g = f.geometry
      if (!sid || !g) continue
      const coords = g.type === 'Polygon' ? g.coordinates[0] : (g.coordinates || []).flat()
      if (!coords?.length) continue
      let lon = 0
      let lat = 0
      for (const [x, y] of coords) {
        lon += x
        lat += y
      }
      lon /= coords.length
      lat /= coords.length
      const m = meta.get(sid) || { count: 0, lon: 0, lat: 0 }
      m.count += 1
      m.lon += lon
      m.lat += lat
      meta.set(sid, m)
    }
    const TH = 0.5 // degrees (~55 km) — scans this close share a cluster
    const raw = []
    for (const [sid, m] of meta) {
      const s = { sid, count: m.count, lon: m.lon / m.count, lat: m.lat / m.count }
      let grp = raw.find((g) => Math.abs(g.lat - s.lat) < TH && Math.abs(g.lon - s.lon) < TH)
      if (!grp) {
        grp = { sids: [], lonSum: 0, latSum: 0, buildings: 0 }
        raw.push(grp)
      }
      grp.sids.push(sid)
      grp.lonSum += s.lon
      grp.latSum += s.lat
      grp.buildings += s.count
    }
    const labelOf = (sid) => sessions.find((x) => x.session_id === sid)?.label || sid
    return raw.map((g) => ({
      key: `${(g.latSum / g.sids.length).toFixed(2)},${(g.lonSum / g.sids.length).toFixed(2)}`,
      lat: g.latSum / g.sids.length,
      lon: g.lonSum / g.sids.length,
      sids: g.sids,
      buildings: g.buildings,
      objs: g.sids.map((sid) => ({ sid, label: labelOf(sid), count: meta.get(sid).count })),
    }))
  }, [features, sessions])

  // resolve each cluster's country/region (cached server-side via Nominatim)
  useEffect(() => {
    const missing = clusters.filter((g) => !regionData[g.key])
    if (!missing.length) return
    let cancelled = false
    ;(async () => {
      for (const g of missing) {
        try {
          const v = await getRegion(g.lat, g.lon)
          if (cancelled) return
          setRegionData((prev) => ({ ...prev, [g.key]: v }))
        } catch {
          if (cancelled) return
          setRegionData((prev) => ({ ...prev, [g.key]: { country: null, region: null } }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [clusters, regionData])

  const regionKeyOf = (g) => {
    const info = regionData[g.key]
    if (!info) return { country: '⏳ locating…', region: '…', pending: true }
    if (!info.country)
      return { country: 'Unknown area', region: `near ${g.lat.toFixed(2)}, ${g.lon.toFixed(2)}`, pending: false }
    return { country: info.country, region: info.region || '—', pending: false }
  }

  // country → region → scans hierarchy
  const countryTree = useMemo(() => {
    const countries = new Map()
    for (const g of clusters) {
      const { country, region } = regionKeyOf(g)
      if (!countries.has(country))
        countries.set(country, { name: country, regions: new Map(), sids: [], buildings: 0 })
      const c = countries.get(country)
      const rk = `${country}||${region}`
      if (!c.regions.has(rk))
        c.regions.set(rk, { key: rk, name: region, sids: [], buildings: 0, scans: [] })
      const r = c.regions.get(rk)
      for (const sid of g.sids) c.sids.push(sid)
      c.buildings += g.buildings
      for (const sid of g.sids) r.sids.push(sid)
      r.buildings += g.buildings
      r.scans.push(...g.objs)
    }
    return [...countries.values()].map((c) => ({ ...c, regions: [...c.regions.values()] }))
  }, [clusters, regionData])

  // sids visible under the current country/region selection (null = everything)
  const visibleSids = useMemo(() => {
    if (!selCountry) return null
    const c = countryTree.find((x) => x.name === selCountry)
    if (!c) return null
    if (!selRegion) return new Set(c.sids)
    const r = c.regions.find((x) => x.key === selRegion)
    return r ? new Set(r.sids) : null
  }, [countryTree, selCountry, selRegion])

  // buildings for the current view: focused scan → country/region → everything
  const visibleFeatures = useMemo(() => {
    if (focusSid) return features.filter((f) => f.properties.session_id === focusSid)
    if (visibleSids) return features.filter((f) => visibleSids.has(f.properties.session_id))
    return features
  }, [features, focusSid, visibleSids])

  const focusSession = (sid) => setFocusSid((cur) => (cur === sid ? null : sid))

  const removeSession = (sid) => {
    deleteSession(sid)
      .then(() => setReloadKey((k) => k + 1))
      .catch((e) => console.error('session delete failed:', e))
  }

  const canScan = session.role !== 'citizen' // citizens view saved scans only
  const canEdit = session.role === 'surveyor' // surveyor manages scan sessions
  const isRegistrar = session.role === 'registrar'
  const canEditBuildings = session.role !== 'citizen' // surveyor or registrar

  const showToast = (kind, text) => {
    setToast({ kind, text })
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 4200)
  }

  // edits awaiting registrar confirmation
  const pendingFeatures = useMemo(
    () => features.filter((f) => f.properties.edit_status === 'pending'),
    [features],
  )

  const saveBuildingEdit = () => {
    if (!selectedId || !editDraft) return
    const feature = features.find((f) => f.properties.building_id === selectedId)
    if (!feature) return
    const p = feature.properties
    const stories = Math.max(1, parseInt(editDraft.floors) || 1)
    const basements = Math.max(0, parseInt(editDraft.basements) || 0)
    const h = Math.max(0.5, parseFloat(editDraft.height) || stories * 3)
    const changes = []
    if (stories !== p.stories) changes.push(`storeys ${p.stories}→${stories}`)
    if (basements !== (p.basements || 0)) changes.push(`basements ${p.basements || 0}→${basements}`)
    if (h !== p.height_m) changes.push(`height ${p.height_m}→${h} m`)
    if (!changes.length) {
      setEditingBld(false)
      setEditDraft(null)
      return
    }
    // surveyor edits await registrar confirmation; registrar edits are final
    const status = session.role === 'registrar' ? 'confirmed' : 'pending'
    const updated = {
      ...feature,
      properties: {
        ...p,
        original_height_m: p.original_height_m ?? p.height_m,
        original_stories: p.original_stories ?? p.stories,
        original_basements: p.original_basements ?? (p.basements || 0),
        original_height_source: p.original_height_source ?? p.height_source,
        height_m: h,
        stories,
        basements,
        roof_z: p.ground_z != null ? +(p.ground_z + h).toFixed(2) : p.roof_z,
        height_source: p.height_source === 'manual' ? 'manual' : 'edited',
        color: '#2fbf8f',
        edit_status: status,
        edit_history: [
          ...(p.edit_history || []),
          {
            at: new Date().toISOString(),
            by: session.name,
            role: session.role,
            change: `${changes.join(', ')}${status === 'confirmed' ? ' (auto-confirmed)' : ' — awaiting registrar confirmation'}`,
          },
        ],
      },
    }
    updateBuilding(updated)
      .then(() => {
        setFeatures((prev) => prev.map((f) => (f.properties.building_id === selectedId ? updated : f)))
        setEditingBld(false)
        setEditDraft(null)
        showToast(
          status === 'confirmed' ? 'success' : 'info',
          status === 'confirmed'
            ? `✓ saved & auto-confirmed — ${selectedId}`
            : 'saved — awaiting registrar confirmation',
        )
      })
      .catch((e) => console.error('building update failed:', e.message))
  }

  const confirmBuilding = (bid) => {
    const entry = {
      at: new Date().toISOString(),
      by: session.name,
      role: session.role,
      change: 'edit confirmed by registrar',
    }
    // mark the notification row as resolving (green fade) while the API runs
    setResolvingIds((prev) => new Set(prev).add(bid))
    confirmBuildingEdit(bid, 'confirmed', entry)
      .then(() => {
        showToast('success', `✓ edit confirmed — ${bid}`)
        // let the resolve animation play before the row disappears
        setTimeout(() => {
          setFeatures((prev) =>
            prev.map((f) =>
              f.properties.building_id === bid
                ? {
                    ...f,
                    properties: {
                      ...f.properties,
                      edit_status: 'confirmed',
                      edit_history: [...(f.properties.edit_history || []), entry],
                    },
                  }
                : f,
            ),
          )
          setResolvingIds((prev) => {
            const next = new Set(prev)
            next.delete(bid)
            return next
          })
        }, 700)
      })
      .catch((e) => {
        setResolvingIds((prev) => {
          const next = new Set(prev)
          next.delete(bid)
          return next
        })
        console.error('confirm failed:', e.message)
      })
  }

  // free-draw footprint replacement from the dashboard map — same audit +
  // confirmation flow as every other edit
  const handleFootprintDrawn = (bid, ring) => {
    const feature = features.find((f) => f.properties.building_id === bid)
    if (!feature) return
    const p = feature.properties
    const status = session.role === 'registrar' ? 'confirmed' : 'pending'
    const updated = {
      ...feature,
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        ...p,
        height_source: p.height_source === 'manual' ? 'manual' : 'edited',
        color: '#2fbf8f',
        edit_status: status,
        edit_history: [
          ...(p.edit_history || []),
          {
            at: new Date().toISOString(),
            by: session.name,
            role: session.role,
            change: `footprint redrawn (${ring.length} corners)${status === 'confirmed' ? ' (auto-confirmed)' : ' — awaiting registrar confirmation'}`,
          },
        ],
      },
    }
    updateBuilding(updated)
      .then(() => {
        setFeatures((prev) => prev.map((f) => (f.properties.building_id === bid ? updated : f)))
        showToast(
          status === 'confirmed' ? 'success' : 'info',
          status === 'confirmed'
            ? `✓ footprint redrawn & auto-confirmed — ${bid}`
            : `footprint redrawn — awaiting registrar confirmation`,
        )
      })
      .catch((e) => console.error('footprint update failed:', e.message))
  }

  // open a pending notification: leave any country/region focus so the
  // building is guaranteed visible, then select it
  const openPendingBuilding = (f) => {
    setSelCountry(null)
    setSelRegion(null)
    setFocusSid(null)
    setSelectedId(f.properties.building_id)
  }

  const removeBuilding = (bid) => {
    deleteBuildingApi(bid)
      .then(() => {
        setFeatures((prev) => prev.filter((f) => f.properties.building_id !== bid))
        setSelectedId(null)
        setEditingBld(false)
        setEditDraft(null)
        showToast('info', `building deleted — ${bid}`)
      })
      .catch((e) => console.error('building delete failed:', e.message))
  }

  const selected = useMemo(
    () => visibleFeatures.find((f) => f.properties.building_id === selectedId)?.properties ?? null,
    [visibleFeatures, selectedId],
  )

  // original → proposed comparison for a pending edit (drives the highlight)
  const proposedRows = useMemo(() => {
    if (!selected || selected.edit_status !== 'pending') return []
    const rows = []
    if (selected.original_height_m != null && selected.original_height_m !== selected.height_m)
      rows.push(['height', `${selected.original_height_m} m`, `${selected.height_m} m`])
    if (selected.original_stories != null && selected.original_stories !== selected.stories)
      rows.push(['storeys', selected.original_stories, selected.stories])
    if (selected.original_basements != null && selected.original_basements !== (selected.basements || 0))
      rows.push(['basements', selected.original_basements, selected.basements || 0])
    return rows
  }, [selected])

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
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}

      <div className="parcel-strip">
        <span className="muted tiny">
          buildings from saved LiDAR scans — pan the map anywhere, or run a new scan
        </span>
        <span style={{ flex: 1 }} />
        {state === 'ready' && stats && (
          <span className="mono tiny">{stats.n} buildings · tallest {stats.tallest} m</span>
        )}
        {isRegistrar && pendingFeatures.length > 0 && (
          <span className="pending-badge">
            ⚑ {pendingFeatures.length} edit{pendingFeatures.length > 1 ? 's' : ''} awaiting confirmation
          </span>
        )}
        <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>refresh</button>
        {canScan && <NavLink to="/lidar" className="btn">new scan</NavLink>}
      </div>

      <main className="workspace">
        <section className="viewport">
          {state === 'ready' && (
            <BuildingsMap
              features={visibleFeatures}
              selectedId={selectedId}
              onSelect={setSelectedId}
              canEdit={canEditBuildings}
              onFootprintDrawn={handleFootprintDrawn}
            />
          )}
          {state === 'ready' && !visibleFeatures.length && (
            <div className="map-note muted tiny">
              no buildings in this view — go back to all areas or run a new scan
            </div>
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
          {isRegistrar && (
            <div className="tab-btns">
              <button className={`btn ${panelTab === 'sessions' ? 'primary' : ''}`} onClick={() => setPanelTab('sessions')}>
                scan sessions
              </button>
              <button className={`btn ${panelTab === 'confirmations' ? 'primary' : ''}`} onClick={() => setPanelTab('confirmations')}>
                ⚑ confirmations{pendingFeatures.length ? ` (${pendingFeatures.length})` : ''}
              </button>
            </div>
          )}

          {(panelTab === 'sessions' || !isRegistrar) && (
            <>
          <div className="panel-section">
            <h3>
              {selRegion ? (
                <button className="btn tiny" onClick={() => setSelRegion(null)}>← {selCountry}</button>
              ) : selCountry ? (
                <button
                  className="btn tiny"
                  onClick={() => {
                    setSelCountry(null)
                    setSelRegion(null)
                  }}
                >
                  ← all countries
                </button>
              ) : (
                'scans'
              )}
            </h3>

            {!selCountry && (
              <>
                {countryTree.map((c) => (
                  <div
                    key={c.name}
                    className={`group-row ${c.name === '⏳ locating…' ? 'dim' : ''}`}
                    onClick={() => {
                      if (c.name !== '⏳ locating…') setSelCountry(c.name)
                    }}
                  >
                    <span className="group-name">{c.name}</span>
                    <span className="muted tiny">
                      {c.name === '⏳ locating…'
                        ? 'resolving scan locations'
                        : `${c.regions.length} region${c.regions.length > 1 ? 's' : ''} · ${c.buildings} bld`}
                    </span>
                    <span className="enter-hint tiny">
                      {c.name === '⏳ locating…' ? '' : 'enter country →'}
                    </span>
                  </div>
                ))}
              </>
            )}

            {selCountry && !selRegion && (() => {
              const c = countryTree.find((x) => x.name === selCountry)
              if (!c) return <p className="muted tiny">…</p>
              return c.regions.map((r) => (
                <div key={r.key} className="group-row" onClick={() => setSelRegion(r.key)}>
                  <span className="group-name">{r.name}</span>
                  <span className="muted tiny">
                    {r.scans.length} scan{r.scans.length > 1 ? 's' : ''} · {r.buildings} bld
                  </span>
                  <span className="enter-hint tiny">enter region →</span>
                </div>
              ))
            })()}

            {selCountry && selRegion && (() => {
              const c = countryTree.find((x) => x.name === selCountry)
              const r = c?.regions.find((x) => x.key === selRegion)
              if (!r) return null
              return (
                <>
                  {r.scans.map((s) => (
                    <div
                      key={s.sid}
                      className={`nav-row ${focusSid === s.sid ? 'active' : ''}`}
                      onClick={() => focusSession(s.sid)}
                    >
                      <span className="session-label" title={s.label}>{s.label}</span>
                      <span className="muted tiny">{s.count} bld</span>
                      <span className="enter-hint tiny">{focusSid === s.sid ? 'whole region' : 'zoom'}</span>
                      {canEdit && (
                        <button
                          className="btn danger tiny"
                          title="delete this session and its buildings"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeSession(s.sid)
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  <p className="muted tiny">click a scan to zoom to it — click again for the whole region.</p>
                </>
              )
            })()}
          </div>

            </>
          )}

          {isRegistrar && panelTab === 'confirmations' && (
            <div className="panel-section">
              <h3>pending confirmations ({pendingFeatures.length})</h3>
              {pendingFeatures.length ? (
                pendingFeatures.map((f) => {
                  const last = (f.properties.edit_history || []).slice(-1)[0]
                  return (
                    <div
                      key={f.properties.building_id}
                      className={`pending-row ${selectedId === f.properties.building_id ? 'active' : ''} ${
                        resolvingIds.has(f.properties.building_id) ? 'resolving' : ''
                      }`}
                      onClick={() => openPendingBuilding(f)}
                    >
                      <span className="mono tiny">{f.properties.building_id}</span>
                      <span className="muted tiny">{last ? `${last.change} — ${last.by}` : 'edited'}</span>
                      <span className="review-hint tiny">click to review →</span>
                    </div>
                  )
                })
              ) : (
                <p className="all-clear tiny">✓ nothing awaiting confirmation — all surveyor edits are resolved.</p>
              )}
            </div>
          )}

          {(panelTab === 'sessions' || !isRegistrar) && (
            <>
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
            </>
          )}

          {selected && (
            <div className="panel-section">
              <h3>building details</h3>
              <table className="kv">
                <tbody>
                  <tr><td>id</td><td className="mono">{selected.building_id}</td></tr>
                  {selected.name && <tr><td>name</td><td>{selected.name}</td></tr>}
                  <tr><td>height</td><td>{selected.height_m} m</td></tr>
                  <tr><td>storeys</td><td>{selected.stories}</td></tr>
                  <tr><td>basements</td><td>{selected.basements || 0}</td></tr>
                  <tr><td>ground Z</td><td>{selected.ground_z ?? '—'}</td></tr>
                  <tr><td>roof Z</td><td>{selected.roof_z ?? '—'}</td></tr>
                  <tr><td>LiDAR points</td><td>{selected.lidar_points}</td></tr>
                  <tr><td>source</td><td>{selected.height_source}</td></tr>
                  <tr>
                    <td>confirmation</td>
                    <td className={selected.edit_status === 'pending' ? 'status-pending' : selected.edit_status === 'confirmed' ? 'status-confirmed' : ''}>
                      {selected.edit_status === 'pending' ? '⏳ pending' : selected.edit_status === 'confirmed' ? '✓ confirmed' : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
              {editingBld ? (
                <div className="edit-form">
                  <label>
                    <span>storeys</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={editDraft.floors}
                      onChange={(e) => {
                        const fl = Math.max(1, parseInt(e.target.value) || 1)
                        setEditDraft({ ...editDraft, floors: fl, height: +(fl * 3).toFixed(2) })
                      }}
                    />
                  </label>
                  <label>
                    <span>basements</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={editDraft.basements ?? 0}
                      onChange={(e) => setEditDraft({ ...editDraft, basements: Math.max(0, parseInt(e.target.value) || 0) })}
                    />
                  </label>
                  <label>
                    <span>height (m)</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0.5"
                      value={editDraft.height}
                      onChange={(e) => {
                        const h = parseFloat(e.target.value) || 0
                        setEditDraft({ ...editDraft, height: e.target.value, floors: Math.max(1, Math.round(h / 3)) })
                      }}
                    />
                  </label>
                  <div className="btn-row">
                    <button className="btn primary" onClick={saveBuildingEdit}>save</button>
                    <button className="btn" onClick={() => { setEditingBld(false); setEditDraft(null) }}>cancel</button>
                  </div>
                </div>
              ) : canEditBuildings && (
                <div className="btn-row">
                  <button
                    className="btn primary"
                    onClick={() => { setEditDraft({ height: selected.height_m, floors: selected.stories, basements: selected.basements || 0 }); setEditingBld(true) }}
                  >
                    edit
                  </button>
                  {isRegistrar && selected.edit_status === 'pending' && (
                    <button
                      className="btn primary"
                      title="confirm this surveyor edit"
                      onClick={() => confirmBuilding(selected.building_id)}
                    >
                      ✓ confirm edit
                    </button>
                  )}
                  <button
                    className="btn danger"
                    title="delete this building from PostGIS"
                    onClick={() => removeBuilding(selected.building_id)}
                  >
                    delete
                  </button>
                </div>
              )}
              {selected.edit_status === 'pending' && (
                <div className="proposed-change">
                  <h3>proposed change</h3>
                  {proposedRows.length ? (
                    <table className="kv">
                      <tbody>
                        {proposedRows.map(([field, from, to]) => (
                          <tr key={field}>
                            <td>{field}</td>
                            <td>
                              <span className="old-val">{String(from)}</span> → <span className="new-val">{String(to)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="muted tiny">footprint change — see the history below for details.</p>
                  )}
                </div>
              )}
              {(selected.edit_history?.length || 0) > 0 && (
                <ul className="history">
                  {[...selected.edit_history].reverse().map((h, i) => (
                    <li key={i}>
                      <span className="who">{h.by} ({h.role})</span> — {h.change}
                      <span className="when">{new Date(h.at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
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
        <LidarMap
          canEdit={session.role !== 'citizen'} // surveyor or registrar
          user={{ name: session.name, role: session.role, username: session.username }}
        />
      </Suspense>
    </div>
  )
}
