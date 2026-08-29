import React, { useEffect, useState } from 'react'
import { getLedger, tamperTest } from '../api.js'

const EVENT_COLORS = {
  registration: '#4da3ff',
  transfer: '#ffb84d',
  dispute_resolution: '#7ddc82',
  correction: '#b07aff',
}

export default function LedgerView({ unitUlpin, role = 'citizen' }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let live = true
    getLedger(unitUlpin)
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(e.message))
    return () => {
      live = false
    }
  }, [unitUlpin])

  if (err) return <div className="error">{err}</div>
  if (!data) return <div className="muted">loading ledger…</div>

  return (
    <div className="ledger">
      <div className={`chain-badge ${data.chain_intact ? 'ok' : 'broken'}`}>
        hash chain: {data.chain_intact ? 'intact' : 'TAMPERED — broken chain detected'}
      </div>
      {data.entries.length === 0 && <div className="muted">no entries</div>}
      {data.entries.map((e) => (
        <div key={e.entry_id} className="ledger-entry">
          <div className="ledger-head">
            <span className="dot" style={{ background: EVENT_COLORS[e.event_type] || '#999' }} />
            <b>#{e.entry_id}</b> {e.event_type}
            {e.owner_name ? ` → ${e.owner_name}` : ''}
          </div>
          <div className="mono muted">{e.timestamp.slice(0, 19)}Z</div>
          <div className="mono tiny">prev: {e.prev_hash.slice(0, 16)}…</div>
          <div className="mono tiny">hash: {e.entry_hash.slice(0, 16)}…</div>
        </div>
      ))}
      {role === 'registrar' && (
        <div className="row-gap">
          <button
            className="btn danger"
            onClick={() =>
              tamperTest(unitUlpin)
                .then(() =>
                  getLedger(unitUlpin).then((d) => {
                    setData(d)
                    setErr(null)
                  }),
                )
                .catch((e) => setErr(e.message))
            }
          >
            simulate tampering
          </button>
          <button className="btn" onClick={() => getLedger(unitUlpin).then(setData).catch((e) => setErr(e.message))}>
            re-verify chain
          </button>
        </div>
      )}
    </div>
  )
}
