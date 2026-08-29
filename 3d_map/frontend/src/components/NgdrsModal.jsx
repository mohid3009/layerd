import React, { useEffect, useState } from 'react'
import { publishNgdrs } from '../api.js'

export default function NgdrsModal({ parcelUlpin, onClose }) {
  const [payload, setPayload] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    publishNgdrs(parcelUlpin).then(setPayload).catch((e) => setErr(e.message))
  }, [parcelUlpin])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h3>NGDRS handoff — mock payload</h3>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {payload && (
          <>
            <p className="muted tiny">
              would POST to <span className="mono">{payload.endpoint_would_be}</span> — status:{' '}
              <b>{payload.status}</b>. No real integration.
            </p>
            <pre className="json">{JSON.stringify(payload.payload, null, 2)}</pre>
            <button
              className="btn primary"
              onClick={() => navigator.clipboard?.writeText(JSON.stringify(payload.payload, null, 2))}
            >
              copy payload JSON
            </button>
          </>
        )}
      </div>
    </div>
  )
}
