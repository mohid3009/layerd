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

export const getParcels = () => req('/parcels')
export const login = (username, password, role) =>
  req('/login', { method: 'POST', body: JSON.stringify({ username, password, role }) })
export const getParcel = (ulpin, role) => req(`/parcels/${encodeURIComponent(ulpin)}?role=${role}`)
export const uploadFloorplan = (file, floorIndex) => {
  const fd = new FormData()
  fd.append('file', file)
  return req(`/floorplan/upload?floor_index=${floorIndex}`, { method: 'POST', body: fd })
}
export const generateUnits = (payload) => req('/units/generate', { method: 'POST', body: JSON.stringify(payload) })
export const validateParcel = (unitUlpin) => req(`/units/${encodeURIComponent(unitUlpin)}/validate`, { method: 'POST' })
export const getLedger = (unitUlpin) => req(`/units/${encodeURIComponent(unitUlpin)}/ledger`)
export const tamperTest = (unitUlpin) => req(`/ledger/tamper-test/${encodeURIComponent(unitUlpin)}`, { method: 'POST' })
export const getDisputes = () => req('/disputes')
export const createDispute = (payload) => req('/disputes', { method: 'POST', body: JSON.stringify(payload) })
export const resolveDispute = (id, payload) => req(`/disputes/${id}/resolve`, { method: 'POST', body: JSON.stringify(payload) })
export const markDisputeUnderReview = (id) => req(`/disputes/${id}/review`, { method: 'POST' })
export const publishNgdrs = (parcelUlpin) => req(`/registry/publish/${encodeURIComponent(parcelUlpin)}`, { method: 'POST' })
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
export const getSavedBuildings = () => req('/lidar/buildings')
export const getSavedStatus = () => req('/lidar/buildings/status')
export const syncSavedBuildings = (fc) =>
  req('/lidar/buildings/sync', { method: 'POST', body: JSON.stringify({ buildings: fc }) })

export function footprintBbox(footprintGeoJson) {
  const ring = footprintGeoJson.coordinates[0]
  const xs = ring.map((c) => c[0])
  const ys = ring.map((c) => c[1])
  return { xMin: Math.min(...xs), yMin: Math.min(...ys), xMax: Math.max(...xs), yMax: Math.max(...ys) }
}

export function makeLocalMapper(footprintGeoJson) {
  const ring = footprintGeoJson.coordinates[0]
  const lat0 = ring.reduce((s, c) => s + c[1], 0) / ring.length
  const M_LAT = 110574
  const M_LON = 111320 * Math.cos((lat0 * Math.PI) / 180)
  return {
    toMeters: ([lon, lat]) => [(lon - footprintBbox(footprintGeoJson).xMin) * M_LON, (lat - footprintBbox(footprintGeoJson).yMin) * M_LAT],
    fromMeters: ([mx, my]) => [footprintBbox(footprintGeoJson).xMin + mx / M_LON, footprintBbox(footprintGeoJson).yMin + my / M_LAT],
    bbox: footprintBbox(footprintGeoJson),
  }
}

export function mapNormalizedToFootprint(normPolygons, mapper) {
  const { bbox } = mapper
  const dx = bbox.xMax - bbox.xMin
  const dy = bbox.yMax - bbox.yMin
  return normPolygons.map((poly) => ({
    type: 'Polygon',
    coordinates: [
      poly.normalized.map(([nx, ny]) => [bbox.xMin + nx * dx, bbox.yMin + ny * dy]).concat([
        [bbox.xMin + poly.normalized[0][0] * dx, bbox.yMin + poly.normalized[0][1] * dy],
      ]),
    ],
  }))
}
