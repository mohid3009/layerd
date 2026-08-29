import React, { useState } from 'react'
import { createDispute } from '../api.js'

export default function UnitPanel({ unit, role, onDisputeSubmitted }) {
  const [showForm, setShowForm] = useState(false)
  const [desc, setDesc] = useState('')
  const [msg, setMsg] = useState(null)

  if (!unit) {
    return (
      <div className="panel-placeholder">
        <p>Select a unit in the 3D view to inspect its derived ULPIN record.</p>
      </div>
    )
  }

  const floorLabel = unit.floor_index < 0 ? `Basement B${-unit.floor_index}` : `Floor F${unit.floor_index}`

  const submit = async () => {
    if (!desc.trim()) return setMsg('description required')
    try {
      await createDispute({ unit_ulpin: unit.unit_ulpin, description: desc, submitted_by: 'CITIZEN-GUEST' })
      setMsg('dispute submitted — registrar will review')
      setDesc('')
      setShowForm(false)
      onDisputeSubmitted?.()
    } catch (e) {
      setMsg(e.message)
    }
  }

  return (
    <div className="unit-panel">
      <div className="mono ulpin">{unit.unit_ulpin}</div>
      <div className="chips">
        <span className={`chip rights-${unit.rights_type}`}>{unit.rights_type}</span>
        <span className={`chip status-${unit.validation_status}`}>{unit.validation_status}</span>
        <span className="chip">{floorLabel}</span>
      </div>
      <table className="kv">
        <tbody>
          <tr>
            <td>area</td>
            <td>{unit.area_sqm} m²</td>
          </tr>
          <tr>
            <td>owner</td>
            <td>
              {unit.owner_name || '—'}{' '}
              {role === 'citizen' && unit.owner_name && <em className="muted">(masked)</em>}
            </td>
          </tr>
          <tr>
            <td>document</td>
            <td>
              {role === 'citizen' ? (
                <span className="muted">—</span>
              ) : (
                <a
                  href="#"
                  className="link mono tiny"
                  onClick={(e) => e.preventDefault()}
                  title="Mock document — no real file attached"
                >
                  {unit.unit_ulpin}.pdf ↗
                </a>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {role === 'citizen' && !showForm && (
        <button className="btn" onClick={() => setShowForm(true)}>
          report dispute on this unit
        </button>
      )}
      {showForm && (
        <div className="form-stack">
          <textarea
            placeholder="describe the issue (e.g. boundary overlaps neighboring unit)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="row-gap">
            <button className="btn primary" onClick={submit}>
              submit dispute
            </button>
            <button className="btn" onClick={() => setShowForm(false)}>
              cancel
            </button>
          </div>
        </div>
      )}
      {msg && <div className="muted">{msg}</div>}
    </div>
  )
}
