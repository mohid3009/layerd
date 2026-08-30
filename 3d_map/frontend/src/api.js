const BASE = '/api'

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      const d = body.detail ?? body.message ?? detail
      // FastAPI validation errors arrive as an array of {loc, msg} objects —
      // flatten them so the UI never shows "[object Object]"
      detail = typeof d === 'string'
        ? d
        : Array.isArray(d)
          ? d.map((e) => `${(e.loc || []).filter((p) => p !== 'body').join('.')}: ${e.msg}`).join('; ')
          : JSON.stringify(d)
    } catch {}
    throw new Error(detail)
  }
  return res.json()
}

export const login = (username, password, role) =>
  req('/login', { method: 'POST', body: JSON.stringify({ username, password, role }) })

// ── Extraction (LiDAR or GIS-parcels-only) ──────────────────────────────────
// lazFile may be null → heights are derived from footprint attributes only.
export const startExtraction = (lazFile, { mode, bbox, bboxCrs, footprintCrs, footprintsFile, epsg, floorHeight }) => {
  const fd = new FormData()
  // always send a laz part — some FastAPI/python-multipart combos reject a
  // multipart body where an optional file field is entirely absent; an empty
  // placeholder is treated as "no LiDAR" server-side
  fd.append('laz', lazFile || new Blob([]), lazFile ? lazFile.name : '')
  fd.append('mode', mode)
  if (mode === 'osm') {
    fd.append('xmin', String(bbox.xmin))
    fd.append('ymin', String(bbox.ymin))
    fd.append('xmax', String(bbox.xmax))
    fd.append('ymax', String(bbox.ymax))
    fd.append('bbox_crs', bboxCrs || 'laz')
  } else {
    fd.append('footprints', footprintsFile)
    fd.append('footprints_crs', footprintCrs || 'wgs84')
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

// ── Edit-confirmation workflow (surveyor edits → registrar confirms) ────────
export const updateBuilding = (feature) =>
  req('/lidar/buildings/update', {
    method: 'POST',
    body: JSON.stringify({ buildings: { type: 'FeatureCollection', features: [feature] } }),
  })
export const confirmBuildingEdit = (buildingId, status, entry) =>
  req('/lidar/buildings/confirm', {
    method: 'POST',
    body: JSON.stringify({ building_id: buildingId, status, entry }),
  })
export const deleteBuilding = (buildingId) =>
  req(`/lidar/buildings/${encodeURIComponent(buildingId)}`, { method: 'DELETE' })
export const getRegion = (lat, lon) => req(`/lidar/regions?lat=${lat}&lon=${lon}`)

// ── 3D ULPIN units ──────────────────────────────────────────────────────────
export const fetchUnits = (buildingId) =>
  req(`/lidar/units?building_id=${encodeURIComponent(buildingId)}`)
export const deleteUnits = (buildingId) =>
  req(`/lidar/units?building_id=${encodeURIComponent(buildingId)}`, { method: 'DELETE' })
export const generateUnits = (buildingId, { floors, basements, floorHeight, planFile }) => {
  const fd = new FormData()
  fd.append('building_id', buildingId)
  fd.append('floors', String(floors))
  fd.append('basements', String(basements))
  fd.append('floor_height', String(floorHeight))
  if (planFile) fd.append('plan', planFile)
  return req('/lidar/units/generate', { method: 'POST', body: fd })
}
