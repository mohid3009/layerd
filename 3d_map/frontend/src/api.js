const BASE = '/api'

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    let detail = res.statusText
    try { detail = (await res.json()).detail || detail } catch {}
    throw new Error(detail)
  }
  return res.json()
}

export const login = (username, password, role) =>
  req('/login', { method: 'POST', body: JSON.stringify({ username, password, role }) })

// ── LiDAR extraction ────────────────────────────────────────────────────────
export const startExtraction = (lazFile, { mode, bbox, bboxCrs, footprintsFile, epsg, floorHeight }) => {
  const fd = new FormData()
  fd.append('laz', lazFile)
  fd.append('mode', mode)
  if (mode === 'osm') {
    fd.append('xmin', String(bbox.xmin))
    fd.append('ymin', String(bbox.ymin))
    fd.append('xmax', String(bbox.xmax))
    fd.append('ymax', String(bbox.ymax))
    fd.append('bbox_crs', bboxCrs || 'laz')
  } else {
    fd.append('footprints', footprintsFile)
  }
  if (epsg) fd.append('epsg', String(epsg))
  fd.append('floor_height', String(floorHeight || 3.0))
  return req('/lidar/extract/start', { method: 'POST', body: fd })
}
export const getExtractionStatus = (jobId) => req(`/lidar/extract/${jobId}`)

// ── Saved buildings (PostGIS) ───────────────────────────────────────────────
export const getSavedBuildings = (sessionId) =>
  req(`/lidar/buildings${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`)
export const getSavedStatus = () => req('/lidar/buildings/status')
export const syncSavedBuildings = (fc, sessionId) =>
  req('/lidar/buildings/sync', { method: 'POST', body: JSON.stringify({ buildings: fc, session_id: sessionId }) })
export const getSessions = () => req('/lidar/sessions')
export const deleteSession = (sessionId) => req(`/lidar/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
