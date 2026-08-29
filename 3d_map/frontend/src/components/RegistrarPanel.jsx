import React, { useEffect, useState } from 'react'
import { getDisputes, resolveDispute, markDisputeUnderReview } from '../api.js'

const STATUS_CLASS = {
  open: 'status-conflict',
  under_review: 'status-pending',
  resolved: 'status-valid',
  rejected: 'chip-muted',
}

export default function RegistrarPanel({ onFocusUnit }) {
  const [disputes, setDisputes] = useState([])
  const [reasons, setReasons] = useState({})
  const [msg, setMsg] = useState(null)

  const load = () => {
    getDisputes()
      .then(setDisputes)
      .catch((e) => setMsg(e.message))
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const markReview = async (id) => {
    setMsg(null)
    try {
      await markDisputeUnderReview(id)
      load()
    } catch (e) {
      setMsg(e.message)
    }
  }

  const resolve = async (id, action) => {
    setMsg(null)
    try {
      await resolveDispute(id, { action, reason: reasons[id] || '' })
      load()
    } catch (e) {
      setMsg(e.message)
    }
  }

  return (
    <div className="panel-section">
      <h3>registrar — dispute queue</h3>
      {disputes.length === 0 && <div className="muted">no disputes filed</div>}
      {disputes.map((d) => (
        <div key={d.dispute_id} className="dispute-card">
          <div className="row-between">
            <b>#{d.dispute_id}</b>
            <span className={`chip ${STATUS_CLASS[d.status]}`}>{d.status.replace('_', ' ')}</span>
          </div>
          {/* FR21: clicking unit ULPIN focuses it in 3D view */}
          <button
            className="link mono"
            onClick={() => onFocusUnit(d.unit_ulpin, d.parcel_ulpin)}
          >
            {d.unit_ulpin}
          </button>
          <p className="tiny">{d.description}</p>
          {d.resolution_reason && <p className="tiny muted">reason: {d.resolution_reason}</p>}

          {/* Registrar actions by status */}
          {d.status === 'open' && (
            <div className="row-gap">
              <button className="btn" onClick={() => markReview(d.dispute_id)}>
                mark under review
              </button>
            </div>
          )}
          {d.status === 'under_review' && (
            <>
              <textarea
                placeholder="mandatory resolution reason"
                value={reasons[d.dispute_id] || ''}
                onChange={(e) => setReasons({ ...reasons, [d.dispute_id]: e.target.value })}
              />
              <div className="row-gap">
                <button className="btn success" onClick={() => resolve(d.dispute_id, 'approve')}>
                  approve &amp; write ledger
                </button>
                <button className="btn danger" onClick={() => resolve(d.dispute_id, 'reject')}>
                  reject
                </button>
              </div>
            </>
          )}
        </div>
      ))}
      {msg && <div className="error">{msg}</div>}
    </div>
  )
}
