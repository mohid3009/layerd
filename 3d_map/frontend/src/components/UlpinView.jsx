import React, { useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { getSavedBuildings, fetchUnits, generateUnits, deleteUnits } from '../api.js'

const FH = 3 // storey height used by the generator (m)

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
      position={[0, unit.floor_index * fh, 0]}
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
        opacity={selected ? 0.95 : 0.85}
      />
    </mesh>
  )
}

export default function UlpinView({ session }) {
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
  const [search, setSearch] = useState('')

  useEffect(() => {
    getSavedBuildings()
      .then((fc) => setBuildings(fc.features || []))
      .catch(() => {})
  }, [])

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

  const filtered = buildings.filter((b) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    const p = b.properties
    return `${p.building_id} ${p.name || ''}`.toLowerCase().includes(q)
  })

  return (
    <main className="workspace">
        <section className="viewport">
          {dims && selId && (
            <Canvas
              key={selId}
              camera={{
                position: [0, Math.max(dims.w, dims.d) * 1.5, Math.max(dims.w, dims.d) * 1.7],
                fov: 42,
                near: 0.1,
                far: 4000,
              }}
            >
              <ambientLight intensity={0.85} />
              <directionalLight position={[dims.w, dims.w * 2, dims.d]} intensity={0.9} />
              <gridHelper args={[Math.max(dims.w, dims.d) * 4, 24, '#2c2c2c', '#1c1c1c']} />
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
          )}
          {!selId && (
            <div className="lidar-empty muted">
              <h3>3D ULPIN explorer</h3>
              <p>choose a building from the sidebar — only that building is shown, with all of its sections, ULPINs and owners.</p>
            </div>
          )}
        </section>

        <aside className="sidebar">
          <div className="panel-section">
            <h3>buildings</h3>
            <input
              className="ulpin-search"
              placeholder="search buildings…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="ulpin-list">
              {filtered.map((b) => {
                const p = b.properties
                return (
                  <div
                    key={p.building_id}
                    className={`nav-row ${selId === p.building_id ? 'active' : ''}`}
                    onClick={() => selectBuilding(p.building_id)}
                  >
                    <span className="session-label" title={p.building_id}>
                      {p.name || p.building_id}
                    </span>
                    <span className="muted tiny">
                      {p.stories || 1} fl{p.basements ? ` · ${p.basements} B` : ''}
                    </span>
                  </div>
                )
              })}
              {!filtered.length && <p className="muted tiny">no matches</p>}
            </div>
          </div>

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
