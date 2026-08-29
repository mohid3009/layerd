import React, { useState } from 'react'
import { uploadFloorplan, generateUnits, mapNormalizedToFootprint, makeLocalMapper } from '../api.js'

export default function SurveyorPanel({ parcel, onUnitsChanged, setConflicts }) {
  const [file, setFile] = useState(null)
  const [floorIndex, setFloorIndex] = useState(0)
  const [rightsType, setRightsType] = useState('owned')
  const [segResult, setSegResult] = useState(null)
  const [genResult, setGenResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const floorOptions = []
  for (let f = -parcel.basement_count; f < parcel.floor_count; f++) floorOptions.push(f)

  const doUpload = async () => {
    if (!file) return
    setBusy(true)
    setErr(null)
    setGenResult(null)
    try {
      const r = await uploadFloorplan(file, floorIndex)
      setSegResult(r)
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }

  const doGenerate = async () => {
    if (!segResult) return
    setBusy(true)
    setErr(null)
    const mapper = makeLocalMapper(parcel.footprint_geojson)
    const polys = mapNormalizedToFootprint(segResult.polygons, mapper)
    try {
      const r = await generateUnits({
        parcel_ulpin: parcel.ulpin,
        floor_index: floorIndex,
        polygons: polys,
        default_rights_type: rightsType,
      })
      setGenResult(r)
      if (r.generated) {
        setSegResult(null)
        setConflicts(new Set())
        onUnitsChanged()
      } else {
        setConflicts(new Set(r.conflicts.flatMap((c) => c.units).filter((u) => !u.startsWith('CANDIDATE'))))
      }
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }

  return (
    <div className="panel-section">
      <h3>surveyor — upload floor plan</h3>
      <div className="form-stack">
        <select value={floorIndex} onChange={(e) => setFloorIndex(Number(e.target.value))}>
          {floorOptions.map((f) => (
            <option key={f} value={f}>
              {f < 0 ? `Basement B${-f}` : `Floor F${f}`}
            </option>
          ))}
        </select>
        <select value={rightsType} onChange={(e) => setRightsType(e.target.value)}>
          {['owned', 'leased', 'common', 'air-rights'].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <input type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files[0])} />
        <button className="btn primary" disabled={!file || busy} onClick={doUpload}>
          {busy ? 'working…' : '1. run AI segmentation'}
        </button>
      </div>

      {segResult && (
        <div className="seg-result">
          <div className="muted">
            detected {segResult.units_detected} unit boundaries ({segResult.width}×{segResult.height}px) → mapped to{' '}
            {floorIndex < 0 ? `B${-floorIndex}` : `F${floorIndex}`}
          </div>
          {segResult.overlay_png_base64 && (
            <img className="overlay-img" src={`data:image/png;base64,${segResult.overlay_png_base64}`} alt="segmentation overlay" />
          )}
          <button className="btn success" disabled={busy} onClick={doGenerate}>
            2. validate topology &amp; generate ULPINs
          </button>
        </div>
      )}

      {genResult && genResult.generated && (
        <div className="result ok">
          generated {genResult.unit_ulpsins.length} units:
          <ul className="mono tiny">
            {genResult.unit_ulpsins.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {genResult && !genResult.generated && (
        <div className="result fail">
          BLOCKED — topology validation failed:
          <ul className="tiny">
            {genResult.conflicts.map((c, i) => (
              <li key={i}>
                <b>{c.type}</b> {c.units.join(' ↔ ')} — {c.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  )
}
