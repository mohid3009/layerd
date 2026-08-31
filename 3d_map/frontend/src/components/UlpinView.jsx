import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { getSavedBuildings, fetchUnits, generateUnits, deleteUnits } from '../api.js'
import BuildingsMap from './BuildingsMap.jsx'

const FH = 3 // storey height used by the generator (m)
const FLOOR_GAP = 0.7 // vertical gap between floors (m) — keeps every level visible in 3D

function floorColor(floorIndex, maxFloor) {
  if (floorIndex < 0) return '#595969' // basement grey
  const t = maxFloor <= 1 ? 0 : (floorIndex - 1) / (maxFloor - 1)
  return `hsl(216, 68%, ${28 + t * 30}%)`
}

function UnitMesh({ unit, w, d, fh, color, selected, onPick }) {
  const geo = useMemo(() => {
    const shape = new THREE.Shape(
      unit.polygon.map(([x, y]) => new THREE.Vector2(x * w - w / 2, y * d - d / 2)),
    )
    const g = new THREE.ExtrudeGeometry(shape, { depth: fh * 0.88, bevelEnabled: false })
    g.rotateX(-Math.PI / 2) // extrude upward, footprint flat on the ground plane
    return g
  }, [unit, w, d, fh])
  return (
    <mesh
      geometry={geo}
      position={[0, unit.floor_index * (fh + FLOOR_GAP), 0]}
      castShadow
      receiveShadow
      onClick={(e) => {
        e.stopPropagation()
        onPick(unit)
      }}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = 'auto')}
    >
      <meshLambertMaterial
        color={selected ? '#ffffff' : unit.validation_status === 'conflict' ? '#e05252' : color}
        transparent
        opacity={selected ? 1 : 0.96}
      />
    </mesh>
  )
}

export default function UlpinView({ session, initialBuilding = null }) {
  const bootstrappedRef = useRef(false)
  const canManage = session.role !== 'citizen'
  const [buildings, setBuildings] = useState([])
  const [selId, setSelId] = useState(null)
  const [units, setUnits] = useState([])
  const [selUlpin, setSelUlpin] = useState(null)
  const [floors, setFloors] = useState(3)
  const [basements, setBasements] = useState(0)
  const [fh, setFh] = useState(3)
  const [planFile, setPlanFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [err, setErr] = useState(null)
  const [query, setQuery] = useState('') // building picker search

  useEffect(() => {
    getSavedBuildings()
      .then((fc) => setBuildings(fc.features || []))
      .catch(() => {})
  }, [])

  // searchable list of buildings for the picker (name or id, case-insensitive)
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const props = buildings.map((b) => b.properties)
    if (!needle) return props
    return props.filter(
      (p) =>
        (p.name || '').toLowerCase().includes(needle) ||
        (p.building_id || '').toLowerCase().includes(needle),
    )
  }, [buildings, query])

  const selected = buildings.find((b) => b.properties.building_id === selId) || null

  const selectBuilding = (bid) => {
    setSelId(bid)
    setSelUlpin(null)
    setUnits([])
    setMsg(null)
    setErr(null)
    fetchUnits(bid)
      .then((r) => setUnits(r.units || []))
      .catch(() => setUnits([]))
  }

  // deep link (dashboard → /ulpin?building=<id>): select and open that building
  useEffect(() => {
    if (bootstrappedRef.current || !buildings.length || !initialBuilding) return
    bootstrappedRef.current = true
    selectBuilding(initialBuilding)
  }, [buildings, initialBuilding]) // eslint-disable-line react-hooks/exhaustive-deps

  const generate = () => {
    if (!selId) return
    setBusy(true)
    setErr(null)
    setMsg(null)
    generateUnits(selId, { floors, basements, floorHeight: fh, planFile })
      .then((r) => {
        setUnits(r.units)
        setMsg(
          `${r.unit_count} units generated via ${r.segmentation} segmentation — base ULPIN ${r.base_ulpin}`,
        )
        setBusy(false)
      })
      .catch((e) => {
        setErr(e.message)
        setBusy(false)
      })
  }

  const clear = () => {
    deleteUnits(selId)
      .then(() => {
        setUnits([])
        setSelUlpin(null)
        setMsg('units cleared')
      })
      .catch(() => {})
  }

  // footprint dimensions in metres (for the 3D mapping)
  const dims = useMemo(() => {
    if (!selected) return null
    const ring = selected.geometry.coordinates[0]
    const lons = ring.map((c) => c[0])
    const lats = ring.map((c) => c[1])
    const latMid = (Math.min(...lats) + Math.max(...lats)) / 2
    return {
      w: Math.max(1, (Math.max(...lons) - Math.min(...lons)) * 111320 * Math.cos((latMid * Math.PI) / 180)),
      d: Math.max(1, (Math.max(...lats) - Math.min(...lats)) * 110540),
    }
  }, [selected])

  const selUnit = units.find((u) => u.unit_ulpin === selUlpin) || null

  // before units are generated, show the building's sections as mock slabs —
  // the chosen building is always fully visible in 3D
  const mockSlabs = useMemo(() => {
    if (!selected || units.length) return []
    const stories = selected.properties.stories || 1
    const basements = selected.properties.basements || 0
    const out = []
    for (let f = -basements; f <= stories; f++) {
      if (f === 0) continue
      out.push({
        unit_ulpin: `section-F${f}`,
        floor_index: f,
        unit_no: 0,
        polygon: [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98], [0.02, 0.02]],
        area_sqm: null,
        mock: true,
      })
    }
    return out
  }, [selected, units.length])

  const displayUnits = units.length ? units : mockSlabs
  const selSlab = mockSlabs.find((s) => s.unit_ulpin === selUlpin) || null
  const maxFloor = displayUnits.reduce((m, u) => Math.max(m, u.floor_index), 1)
  const minFloor = displayUnits.reduce((m, u) => Math.min(m, u.floor_index), 0)
  // exploded stack size — drives camera framing and the shadow camera bounds
  const totalH = (maxFloor - minFloor + 2) * (FH + FLOOR_GAP)
  const span = Math.max(dims ? Math.max(dims.w, dims.d) : 10, totalH) * 2.2
  const baseUlpin = units[0]?.base_ulpin || null

  // units grouped by floor for the sidebar list
  const byFloor = useMemo(() => {
    const m = new Map()
    for (const u of units) {
      if (!m.has(u.floor_index)) m.set(u.floor_index, [])
      m.get(u.floor_index).push(u)
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [units])

  return (
    <main className="workspace">
        <section className="viewport">
          <BuildingsMap
            features={buildings}
            selectedId={selId}
            onSelect={(bid) => selectBuilding(bid)}
          />
          {!selId && (
            <div className="map-note muted tiny">
              click a building on the map to open its 3D ULPIN unit tree
            </div>
          )}
          {selId && dims && (
            <div className="ulpin-3d">
              <div className="ulpin-3d-bar">
                <button className="btn tiny" onClick={() => setSelId(null)}>← choose on map</button>
                <span className="mono tiny">{selected?.properties.name || selId}</span>
                {baseUlpin && <span className="muted tiny mono">base {baseUlpin}</span>}
              </div>
              <div className="ulpin-3d-stage">
                <Canvas
                  shadows
                  camera={{
                    position: [
                      0,
                      Math.max(dims.w, dims.d) * 1.3 + totalH * 0.9,
                      Math.max(dims.w, dims.d) * 1.6 + totalH * 0.55,
                    ],
                    fov: 42,
                    near: 0.1,
                    far: 12000,
                  }}
                >
                  <ambientLight intensity={0.8} />
                  <directionalLight
                    position={[dims.w * 1.2, (maxFloor + 4) * (FH + FLOOR_GAP) + dims.d, dims.d * 1.2]}
                    intensity={1.05}
                    castShadow
                    shadow-mapSize-width={2048}
                    shadow-mapSize-height={2048}
                    shadow-camera-near={1}
                    shadow-camera-far={span * 8}
                    shadow-camera-left={-span}
                    shadow-camera-right={span}
                    shadow-camera-top={span}
                    shadow-camera-bottom={-span}
                  />
                  <gridHelper args={[Math.max(dims.w, dims.d) * 4, 24, '#2c2c2c', '#1c1c1c']} />
                  {/* shadow catcher — a plane just below the lowest level */}
                  <mesh
                    receiveShadow
                    rotation={[-Math.PI / 2, 0, 0]}
                    position={[0, minFloor * (FH + FLOOR_GAP) - 0.02, 0]}
                  >
                    <planeGeometry args={[span * 8, span * 8]} />
                    <shadowMaterial transparent opacity={0.38} />
                  </mesh>
                  {displayUnits.map((u) => (
                    <UnitMesh
                      key={u.unit_ulpin}
                      unit={u}
                      w={dims.w}
                      d={dims.d}
                      fh={FH}
                      color={floorColor(u.floor_index, maxFloor)}
                      selected={selUlpin === u.unit_ulpin}
                      onPick={(unit) => setSelUlpin(unit.unit_ulpin)}
                    />
                  ))}
                  <OrbitControls />
                </Canvas>
              </div>
            </div>
          )}
        </section>

        <aside className="sidebar">
          {!selId && (
            <div className="panel-section">
              <h3>3D ULPIN explorer</h3>
              {buildings.length === 0 ? (
                <>
                  <p className="muted tiny">
                    no saved buildings yet — run a LiDAR scan first, then come back here to open a
                    building in 3D and mint its ULPIN unit tree.
                  </p>
                  <div className="btn-row">
                    {canManage && (
                      <Link to="/lidar" className="btn primary">
                        run a LiDAR scan
                      </Link>
                    )}
                    <Link to="/dashboard" className="btn">
                      open dashboard
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="muted tiny">
                    pick a building below or click it on the map — it opens in 3D with all of its
                    sections, ULPINs, owners and details.
                  </p>
                  <input
                    className="search"
                    placeholder="search by name or id…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="picker-list">
                    {candidates.map((p) => (
                      <div
                        key={p.building_id}
                        className="nav-row"
                        onClick={() => selectBuilding(p.building_id)}
                      >
                        <span className="session-label" title={p.building_id}>
                          {p.name || p.building_id}
                        </span>
                        <span className="muted tiny">{p.stories ?? '—'} str</span>
                        <span className="enter-hint tiny">open →</span>
                      </div>
                    ))}
                    {!candidates.length && (
                      <p className="muted tiny">no building matches “{query}”.</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          {selected && (
            <div className="panel-section">
              <h3>base ULPIN</h3>
              <p className="ulpin">{baseUlpin || '— generate units to mint the base ULPIN —'}</p>
              {canManage && (
                <>
                  <div className="edit-form">
                    <label>
                      <span>floors</span>
                      <input type="number" min="1" max="60" value={floors} onChange={(e) => setFloors(Math.max(1, parseInt(e.target.value) || 1))} />
                    </label>
                    <label>
                      <span>basements</span>
                      <input type="number" min="0" max="6" value={basements} onChange={(e) => setBasements(Math.max(0, parseInt(e.target.value) || 0))} />
                    </label>
                    <label>
                      <span>floor h (m)</span>
                      <input type="number" min="0.5" step="0.1" value={fh} onChange={(e) => setFh(Math.max(0.5, parseFloat(e.target.value) || 3))} />
                    </label>
                  </div>
                  <label className="upload-field">
                    <span>floor plan image (YOLOv11-seg)</span>
                    <input type="file" accept=".png,.jpg,.jpeg" onChange={(e) => setPlanFile(e.target.files[0] || null)} />
                  </label>
                  <div className="btn-row">
                    <button className="btn primary" disabled={busy} onClick={generate}>
                      {busy ? 'generating…' : 'generate units'}
                    </button>
                    {units.length > 0 && (
                      <button className="btn danger" onClick={clear}>clear units</button>
                    )}
                  </div>
                  {msg && <p className="all-clear tiny">{msg}</p>}
                  {err && <div className="error mono tiny">{err}</div>}
                </>
              )}
            </div>
          )}

          {byFloor.length > 0 && (
            <div className="panel-section">
              <h3>units ({units.length})</h3>
              {byFloor.map(([floor, us]) => (
                <div key={floor}>
                  <div className="ulpin-floor-head">
                    {floor < 0 ? `basement ${-floor}` : `floor ${floor}`}
                  </div>
                  {us.map((u) => (
                    <div
                      key={u.unit_ulpin}
                      className={`nav-row ${selUlpin === u.unit_ulpin ? 'active' : ''}`}
                      onClick={() => setSelUlpin(u.unit_ulpin)}
                    >
                      <span className="session-label mono tiny" title={u.unit_ulpin}>
                        {u.unit_ulpin}
                      </span>
                      <span className="muted tiny">{u.owner_name}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {selUnit && (
            <div className="panel-section">
              <h3>unit details</h3>
              <table className="kv">
                <tbody>
                  <tr><td>ULPIN</td><td className="mono">{selUnit.unit_ulpin}</td></tr>
                  <tr><td>floor</td><td>{selUnit.floor_index < 0 ? `basement ${-selUnit.floor_index}` : `floor ${selUnit.floor_index}`}</td></tr>
                  <tr><td>unit no.</td><td>U{selUnit.unit_no}</td></tr>
                  <tr><td>area</td><td>{selUnit.area_sqm} m²</td></tr>
                  <tr><td>rights</td><td>{selUnit.rights_type}</td></tr>
                  <tr><td>owner</td><td>{selUnit.owner_name}</td></tr>
                  <tr><td>owner id</td><td className="mono">{selUnit.owner_id}</td></tr>
                  <tr><td>status</td><td className={selUnit.validation_status === 'conflict' ? 'status-pending' : 'status-confirmed'}>{selUnit.validation_status}</td></tr>
                  <tr><td>segmentation</td><td>{selUnit.segmentation}</td></tr>
                </tbody>
              </table>
            </div>
          )}

          {selSlab && (
            <div className="panel-section">
              <h3>section details</h3>
              <table className="kv">
                <tbody>
                  <tr><td>section</td><td>{selSlab.floor_index < 0 ? `basement ${-selSlab.floor_index}` : `floor ${selSlab.floor_index}`}</td></tr>
                  <tr><td>z-range</td><td>{selSlab.floor_index * FH} m → {(selSlab.floor_index + 1) * FH} m</td></tr>
                  <tr><td>ULPINs</td><td>generate units to populate this section</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </aside>
      </main>
  )
}
