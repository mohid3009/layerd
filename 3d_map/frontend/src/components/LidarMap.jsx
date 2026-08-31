import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { getExtractionStatus, getSavedStatus, startExtraction, syncSavedBuildings } from '../api.js'
import { floorSlices } from '../floors.js'

// Keyless tile providers (same set as ParcelMap — no {r} placeholder).
const TILES = {
  satellite: {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: '© Esri, Maxar, Earthstar Geographics',
    maxzoom: 19,
  },
  dark: {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attr: '© Esri, HERE, Garmin, FAO, NOAA, USGS · © OpenStreetMap contributors',
    maxzoom: 16,
  },
  light: {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attr: '© Esri, HERE, Garmin, FAO, NOAA, USGS · © OpenStreetMap contributors',
    maxzoom: 16,
  },
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] }

export default function LidarMap({ canEdit = true, user = null }) {
  const [lazFile, setLazFile] = useState(null)
  const [hasLidar, setHasLidar] = useState(true) // "LiDAR data available?" toggle
  const [footprintsFile, setFootprintsFile] = useState(null)
  const [sourceMode, setSourceMode] = useState('osm') // 'osm' | 'footprints'
  const [bbox, setBbox] = useState({ xmin: '', ymin: '', xmax: '', ymax: '' })
  const [bboxCrs, setBboxCrs] = useState('laz') // 'laz' = same CRS as the .laz file
  const [fpCrs, setFpCrs] = useState('wgs84') // footprint GeoJSON coords: 'laz' = same CRS as the .laz file
  const [epsg, setEpsg] = useState('')
  const [floorHeight, setFloorHeight] = useState('3.0')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [result, setResult] = useState(null)
  const [features, setFeatures] = useState([]) // editable building features
  const [selectedId, setSelectedId] = useState(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null) // { height } while editing
  const [drawMode, setDrawMode] = useState(false)
  const [footprintEdit, setFootprintEdit] = useState(false) // reshape the selected footprint
  const [redrawMode, setRedrawMode] = useState(false) // replace the selected footprint with a fresh polygon
  const [tileStyle, setTileStyle] = useState('satellite')
  const [job, setJob] = useState(null) // { state, steps, error, result }
  const [postgisMsg, setPostgisMsg] = useState(null)

  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const loadedRef = useRef(false)
  const pollRef = useRef(null)
  const featuresRef = useRef([])
  const originalsRef = useRef(new Map()) // building_id -> original feature
  const drawModeRef = useRef(false)
  const fpEditRef = useRef(null) // { id, ring } while reshaping a footprint
  const dragIdxRef = useRef(null) // index of the vertex being dragged
  const commitFootprintRef = useRef(() => {})
  const commitRedrawRef = useRef(() => {})
  const redrawTargetRef = useRef(null) // building_id whose footprint is being redrawn
  const drawPtsRef = useRef([]) // committed freeform vertices [lng, lat]
  const firstPixRef = useRef(null) // pixel pos of first vertex (click-to-close)
  const finishFreeformRef = useRef(() => {})
  const dirtyRef = useRef(false) // unsaved manual edits?
  const syncTimerRef = useRef(null)
  const tileStyleRef = useRef('satellite') // current tile style (read by map load)
  const sessionIdRef = useRef(null) // PostGIS scan session of the current job
  const floorHRef = useRef(3.0)
  const addBuildingRef = useRef(() => {})

  const stats = result?.stats ?? null
  const hasData = features.length > 0
  const floorH = parseFloat(floorHeight) || 3.0
  const lazBboxUnits = hasLidar && bboxCrs === 'laz' // bbox inputs shown in .laz projected units
  floorHRef.current = floorH
  featuresRef.current = features

  // per-floor render slices (multi-storey buildings get one extrusion + colour
  // per storey); building-level `features` stay untouched for sync/export
  const renderFeatures = useMemo(() => floorSlices(features), [features])
  const renderRef = useRef(renderFeatures)
  renderRef.current = renderFeatures

  const selectedFeature = useMemo(
    () => features.find((f) => f.properties.building_id === selectedId) || null,
    [features, selectedId],
  )
  const selected = selectedFeature?.properties ?? null
  const editedCount = useMemo(
    () =>
      features.filter((f) => ['edited', 'manual'].includes(f.properties.height_source))
        .length,
    [features],
  )

  const bboxValid =
    ['xmin', 'ymin', 'xmax', 'ymax'].every((k) => bbox[k] !== '' && isFinite(Number(bbox[k]))) &&
    Number(bbox.xmin) < Number(bbox.xmax) &&
    Number(bbox.ymin) < Number(bbox.ymax)

  // ── Upload + extract (start job, then poll step-wise progress) ─────────────
  const onExtract = async () => {
    if (busy || (hasLidar && !lazFile)) return
    if (sourceMode === 'osm' && !bboxValid) {
      setErr('enter a valid bounding box: xmin < xmax and ymin < ymax')
      return
    }
    if (sourceMode === 'footprints' && !footprintsFile) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setSelectedId(null)
    setEditing(false)
    setDrawMode(false)
    dirtyRef.current = false
    sessionIdRef.current = null
    setPostgisMsg(null)
    setJob({
      state: 'running',
      error: null,
      steps: hasLidar
        ? [
            { key: 'load', label: 'Reading LiDAR point cloud', state: 'pending' },
            { key: 'reproject', label: 'Reprojecting to WGS84', state: 'pending' },
            {
              key: 'footprints',
              label: sourceMode === 'osm' ? 'Fetching building footprints' : 'Parsing footprint GeoJSON',
              state: 'pending',
            },
            { key: 'measure', label: 'Measuring heights from LiDAR', state: 'pending' },
            { key: 'save', label: 'Saving to PostGIS', state: 'pending' },
          ]
        : [
            {
              key: 'footprints',
              label: sourceMode === 'osm' ? 'Fetching building footprints' : 'Parsing footprint GeoJSON',
              state: 'pending',
            },
            { key: 'measure', label: 'Deriving heights from attributes', state: 'pending' },
            { key: 'save', label: 'Saving to PostGIS', state: 'pending' },
          ],
    })
    try {
      const { job_id } = await startExtraction(hasLidar ? lazFile : null, {
        mode: sourceMode,
        bbox,
        bboxCrs: hasLidar ? bboxCrs : 'wgs84',
        footprintCrs: hasLidar ? fpCrs : 'wgs84',
        footprintsFile,
        epsg: epsg.trim() || null,
        floorHeight: parseFloat(floorHeight) || 3.0,
      })
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const st = await getExtractionStatus(job_id)
          setJob(st)
          if (st.state === 'done' || st.state === 'error') {
            clearInterval(pollRef.current)
            pollRef.current = null
            setBusy(false)
            if (st.state === 'done') {
              setResult(st.result)
              setFeatures(st.result.buildings.features)
              sessionIdRef.current = st.result.session_id ?? null
              originalsRef.current = new Map(
                st.result.buildings.features.map((f) => [
                  f.properties.building_id,
                  JSON.parse(JSON.stringify(f)),
                ]),
              )
              setSelectedId(null)
            } else {
              setErr(st.error || 'extraction failed')
            }
          }
        } catch {
          /* transient poll error — keep polling */
        }
      }, 600)
    } catch (e) {
      setBusy(false)
      setJob(null)
      setErr(e.message)
    }
  }

  const markDirty = () => { dirtyRef.current = true }

  // audit entry for the change history shown in the details panel
  const editEntry = (change) => ({
    at: new Date().toISOString(),
    by: user?.name ?? 'unknown',
    role: user?.role ?? '—',
    change,
  })

  // surveyor edits wait for registrar confirmation; registrar edits are final
  const newEditStatus = () => (user?.role === 'registrar' ? 'confirmed' : 'pending')

  // auto-sync manual edits to PostGIS (debounced) — surveyors only
  useEffect(() => {
    if (!canEdit || !dirtyRef.current) return
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(async () => {
      try {
        const r = await syncSavedBuildings(
          { type: 'FeatureCollection', features: featuresRef.current },
          sessionIdRef.current,
        )
        if (r.session_id) sessionIdRef.current = r.session_id
        dirtyRef.current = false
        setPostgisMsg(`saved to PostGIS · session ${r.session_id} (${r.count} buildings)`)
      } catch (e) {
        setPostgisMsg(`PostGIS sync failed: ${e.message}`)
      }
    }, 1200)
  }, [features])

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
  }, [])

  // ── Manual building editing ────────────────────────────────────────────────
  const addManualPolygon = (ring) => {
    const id = `manual-${Date.now()}`
    const h = floorHRef.current
    markDirty()
    setFeatures((prev) => [
      ...prev,
      {
        type: 'Feature',
        properties: {
          building_id: id,
          name: 'Manual building',
          height_m: h,
          stories: 1,
          ground_z: null,
          roof_z: null,
          lidar_points: 0,
          height_source: 'manual',
          color: '#2fbf8f',
          original_height_m: h,
          original_stories: 1,
          original_basements: 0,
          edit_status: newEditStatus(),
          edit_history: [editEntry('building created (manual footprint)')],
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
    ])
    setSelectedId(id)
    setDraft({ height: h, floors: 1, basements: 0 })
    setEditing(true)
    setDrawMode(false)
  }
  addBuildingRef.current = addManualPolygon

  const finishFreeform = () => {
    const pts = drawPtsRef.current
    if (pts.length < 3) return
    const ring = [...pts, pts[0]]
    drawPtsRef.current = []
    firstPixRef.current = null
    mapRef.current?.getSource('draft')?.setData(EMPTY_FC)
    if (redrawTargetRef.current) {
      // redraw mode: replace the target building's footprint
      commitRedrawRef.current(ring)
      redrawTargetRef.current = null
      setRedrawMode(false)
      return
    }
    addBuildingRef.current(ring)
  }
  finishFreeformRef.current = finishFreeform

  const saveEdit = () => {
    const stories = Math.max(1, parseInt(draft?.floors) || 1)
    const basements = Math.max(0, parseInt(draft?.basements) || 0)
    const h = Math.max(0.5, parseFloat(draft?.height) || stories * floorHRef.current)
    setFeatures((prev) =>
      prev.map((f) => {
        if (f.properties.building_id !== selectedId) return f
        const p = f.properties
        // record what actually changed for the audit trail
        const changes = []
        if (stories !== p.stories) changes.push(`storeys ${p.stories}→${stories}`)
        if (basements !== (p.basements || 0)) changes.push(`basements ${p.basements || 0}→${basements}`)
        if (h !== p.height_m) changes.push(`height ${p.height_m}→${h} m`)
        if (!changes.length) return f
        markDirty()
        return {
          ...f,
          properties: {
            ...p,
            original_height_m: p.original_height_m ?? p.height_m,
            original_stories: p.original_stories ?? p.stories,
            original_basements: p.original_basements ?? (p.basements || 0),
            original_height_source: p.original_height_source ?? p.height_source,
            height_m: h,
            stories,
            basements,
            roof_z: p.ground_z != null ? +(p.ground_z + h).toFixed(2) : p.roof_z,
            height_source: p.height_source === 'manual' ? 'manual' : 'edited',
            color: '#2fbf8f',
            edit_status: newEditStatus(),
            edit_history: [...(p.edit_history || []), editEntry(changes.join(', '))],
          },
        }
      }),
    )
    setEditing(false)
    setDraft(null)
  }

  // replace the selected building's footprint with a freshly drawn polygon
  commitRedrawRef.current = (ring) => {
    const bid = redrawTargetRef.current
    if (!bid) return
    markDirty()
    setFeatures((prev) =>
      prev.map((f) => {
        if (f.properties.building_id !== bid) return f
        const p = f.properties
        return {
          ...f,
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: {
            ...p,
            height_source: p.height_source === 'manual' ? 'manual' : 'edited',
            color: '#2fbf8f',
            edit_status: newEditStatus(),
            edit_history: [...(p.edit_history || []), editEntry(`footprint redrawn (${ring.length - 1} corners)`)],
          },
        }
      }),
    )
  }

  const resetBuilding = () => {
    const orig = originalsRef.current.get(selectedId)
    if (!orig) return
    markDirty()
    setFeatures((prev) =>
      prev.map((f) =>
        f.properties.building_id === selectedId ? JSON.parse(JSON.stringify(orig)) : f,
      ),
    )
    setEditing(false)
    setDraft(null)
  }

  const deleteBuilding = () => {
    markDirty()
    setFeatures((prev) => prev.filter((f) => f.properties.building_id !== selectedId))
    setSelectedId(null)
    setEditing(false)
    setDraft(null)
  }

  // add/remove below-ground (basement) levels — above-ground height is
  // untouched; each level is one storey-height deep
  const changeBasements = (delta) => {
    setFeatures((prev) =>
      prev.map((f) => {
        if (f.properties.building_id !== selectedId) return f
        const p = f.properties
        const basements = Math.max(0, (parseInt(p.basements) || 0) + delta)
        if (basements === (p.basements || 0)) return f // e.g. − at zero — nothing to record
        markDirty()
        return {
          ...f,
          properties: {
            ...p,
            original_height_m: p.original_height_m ?? p.height_m,
            original_stories: p.original_stories ?? p.stories,
            original_basements: p.original_basements ?? (p.basements || 0),
            original_height_source: p.original_height_source ?? p.height_source,
            basements,
            height_source: p.height_source === 'manual' ? 'manual' : 'edited',
            color: '#2fbf8f',
            edit_status: newEditStatus(),
            edit_history: [...(p.edit_history || []), editEntry(`basements ${p.basements || 0}→${basements}`)],
          },
        }
      }),
    )
  }

  // commit a reshaped footprint (called on drag end by the map handlers)
  commitFootprintRef.current = () => {
    const fp = fpEditRef.current
    if (!fp) return
    markDirty()
    setFeatures((prev) =>
      prev.map((f) => {
        if (f.properties.building_id !== fp.id) return f
        const p = f.properties
        return {
          ...f,
          geometry: { type: 'Polygon', coordinates: [[...fp.ring, fp.ring[0]]] },
          properties: {
            ...p,
            height_source: p.height_source === 'manual' ? 'manual' : 'edited',
            color: '#2fbf8f',
            edit_status: newEditStatus(),
            edit_history: [...(p.edit_history || []), editEntry(`footprint adjusted (${fp.ring.length} corners)`)],
          },
        }
      }),
    )
  }

  const resetAll = () => {
    markDirty()
    setFeatures([...originalsRef.current.values()].map((f) => JSON.parse(JSON.stringify(f))))
    setSelectedId(null)
    setEditing(false)
    setDraft(null)
    setDrawMode(false)
  }

  const exportGeoJSON = () => {
    const blob = new Blob(
      [JSON.stringify({ type: 'FeatureCollection', features }, null, 2)],
      { type: 'application/geo+json' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'buildings_edited.geojson'
    a.click()
    URL.revokeObjectURL(url)
  }

  // keep the map's building source in sync with edited features
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    map.getSource('buildings')?.setData({ type: 'FeatureCollection', features: renderFeatures })
  }, [renderFeatures])

  // highlight the selected building (yellow outline, incl. edit mode)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    map.setFilter('bldg-selected', ['==', ['get', 'building_id'], selectedId || ''])
  }, [selectedId])

  // footprint reshape mode: project the selected building's corners as
  // draggable handles + a live preview polygon
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    if (!footprintEdit || !selectedFeature || selectedFeature.geometry?.type !== 'Polygon') {
      fpEditRef.current = null
      map.getSource('handles')?.setData(EMPTY_FC)
      map.getSource('fpdraft')?.setData(EMPTY_FC)
      return
    }
    const ring = selectedFeature.geometry.coordinates[0].slice(0, -1) // drop closing vertex
    fpEditRef.current = { id: selectedFeature.properties.building_id, ring }
    pushFpSources(map, { ring })
  }, [footprintEdit, selectedFeature])

  // footprint reshape ↔ freeform draw are mutually exclusive; crosshair cursor
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (footprintEdit) {
      setDrawMode(false)
      setRedrawMode(false)
      map.getCanvas().style.cursor = 'crosshair'
    } else if (!drawMode) {
      map.getCanvas().style.cursor = ''
    }
  }, [footprintEdit]) // eslint-disable-line react-hooks/exhaustive-deps

  // draw-mode bookkeeping (cursor, dblclick-zoom, cancel pending shape)
  useEffect(() => {
    drawModeRef.current = drawMode
    const map = mapRef.current
    if (!map) return
    if (drawMode) {
      setFootprintEdit(false)
      setRedrawMode(false)
      map.doubleClickZoom.disable()
      map.getCanvas().style.cursor = 'crosshair'
    } else {
      drawPtsRef.current = []
      firstPixRef.current = null
      map.getSource('draft')?.setData(EMPTY_FC)
      map.doubleClickZoom.enable()
      map.getCanvas().style.cursor = ''
    }
  }, [drawMode])

  useEffect(() => {
    if (!drawMode) return
    const onKey = (e) => {
      if (e.key === 'Escape') setDrawMode(false)
      if (e.key === 'Enter') finishFreeformRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawMode])

  // redraw mode: replace the selected footprint with a freshly drawn polygon —
  // mutually exclusive with the other two drawing modes
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (redrawMode) {
      redrawTargetRef.current = selectedId
      setDrawMode(false)
      setFootprintEdit(false)
      map.doubleClickZoom.disable()
      map.getCanvas().style.cursor = 'crosshair'
    } else {
      redrawTargetRef.current = null
      drawPtsRef.current = []
      map.getSource('draft')?.setData(EMPTY_FC)
      if (!drawMode && !footprintEdit) {
        map.doubleClickZoom.enable()
        map.getCanvas().style.cursor = ''
      }
    }
  }, [redrawMode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!redrawMode) return
    const onKey = (e) => {
      if (e.key === 'Escape') setRedrawMode(false)
      if (e.key === 'Enter') finishFreeformRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [redrawMode])

  // ── Map init (the map is only mounted once we have data) ───────────────────
  useEffect(() => {
    if (!hasData || !containerRef.current || mapRef.current) return
    const map = new MapLibreMap({
      container: containerRef.current,
      style: {
        version: 8,
        light: { anchor: 'viewport', color: '#ffffff', intensity: 0.5 },
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          ...Object.fromEntries(
            Object.entries(TILES).map(([key, t]) => [
              `base-${key}`,
              { type: 'raster', tiles: [t.url], tileSize: 256, attribution: t.attr, maxzoom: t.maxzoom },
            ]),
          ),
          buildings: { type: 'geojson', data: EMPTY_FC },
          draft: { type: 'geojson', data: EMPTY_FC },
          fpdraft: { type: 'geojson', data: EMPTY_FC }, // footprint reshape preview
          handles: { type: 'geojson', data: EMPTY_FC }, // draggable corner handles
        },
        layers: [
          ...Object.keys(TILES).map((key, i) => ({
            id: `base-raster-${key}`,
            type: 'raster',
            source: `base-${key}`,
            layout: { visibility: i === 0 ? 'visible' : 'none' },
          })),
          { id: 'bldg-flat', type: 'fill', source: 'buildings',
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 } },
          { id: 'bldg-extrude', type: 'fill-extrusion', source: 'buildings',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'height_m'],
              'fill-extrusion-base': ['coalesce', ['get', 'base_m'], 0],
              'fill-extrusion-opacity': 0.95,
              'fill-extrusion-vertical-gradient': true,
            } },
          { id: 'bldg-line', type: 'line', source: 'buildings',
            paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.5 } },
          { id: 'bldg-basement', type: 'line', source: 'buildings',
            // dashed grey outline marking buildings that have basements
            // (basement slices with floor<0, or pass-through single-storeys)
            filter: ['any',
              ['<', ['coalesce', ['get', 'floor'], 0], 0],
              ['all', ['>=', ['coalesce', ['get', 'basements'], 0], 1], ['!', ['has', 'floor']]],
            ],
            paint: { 'line-color': '#9ba1ad', 'line-width': 1.5, 'line-dasharray': [2, 2] } },
          { id: 'bldg-selected', type: 'line', source: 'buildings',
            filter: ['==', ['get', 'building_id'], ''],
            paint: { 'line-color': '#ffd60a', 'line-width': 3, 'line-opacity': 0.9 } },
          { id: 'draft-fill', type: 'fill', source: 'draft',
            paint: { 'fill-color': '#2fbf8f', 'fill-opacity': 0.2 } },
          { id: 'draft-line', type: 'line', source: 'draft',
            paint: { 'line-color': '#2fbf8f', 'line-width': 2 } },
          { id: 'fp-draft', type: 'fill', source: 'fpdraft',
            paint: { 'fill-color': '#ff5533', 'fill-opacity': 0.25 } },
          { id: 'fp-draft-line', type: 'line', source: 'fpdraft',
            paint: { 'line-color': '#ff5533', 'line-width': 2 } },
          { id: 'fp-handles', type: 'circle', source: 'handles',
            paint: { 'circle-radius': 6, 'circle-color': '#ff5533', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } },
        ],
      },
      center: [175.47, -37.89],
      zoom: 15,
      pitch: 55,
      bearing: -18,
      attributionControl: false,
    })
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-left')

    map.on('load', () => {
      loadedRef.current = true
      // apply the selected tile style (the map may be recreated mid-session)
      for (const key of Object.keys(TILES)) {
        map.setLayoutProperty(`base-raster-${key}`, 'visibility', key === tileStyleRef.current ? 'visible' : 'none')
      }
      map.setPaintProperty('bldg-line', 'line-color', tileStyleRef.current === 'light' ? '#3a3a3a' : '#ffffff')
      map.getSource('buildings').setData({ type: 'FeatureCollection', features: renderRef.current })
      map.fitBounds(bboxOf({ type: 'FeatureCollection', features: featuresRef.current }), { padding: 60, duration: 1200 })
    })
    map.on('click', 'bldg-extrude', (e) => {
      if (drawModeRef.current || !e.features?.length) return
      setSelectedId(e.features[0].properties.building_id)
      setEditing(false)
    })
    map.on('mouseenter', 'bldg-extrude', () => {
      if (!drawModeRef.current) map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', 'bldg-extrude', () => {
      if (!drawModeRef.current) map.getCanvas().style.cursor = ''
    })

    // ── footprint vertex editing: drag the corner handles of the selected building ──
    map.on('mousedown', 'fp-handles', (e) => {
      if (!fpEditRef.current) return
      e.preventDefault()
      dragIdxRef.current = e.features[0].properties.idx
      map.getCanvas().style.cursor = 'grabbing'
      map.dragPan.disable()
    })
    map.on('touchstart', 'fp-handles', (e) => {
      if (!fpEditRef.current || e.points?.length !== 1) return
      e.preventDefault()
      dragIdxRef.current = e.features[0].properties.idx
      map.dragPan.disable()
    })
    const onFpDragMove = (e) => {
      const fp = fpEditRef.current
      if (!fp || dragIdxRef.current == null) return
      fp.ring = fp.ring.map((c, j) => (j === dragIdxRef.current ? [e.lngLat.lng, e.lngLat.lat] : c))
      pushFpSources(map, fp)
    }
    map.on('mousemove', onFpDragMove)
    map.on('touchmove', onFpDragMove)
    const onFpDragEnd = () => {
      if (dragIdxRef.current == null) return
      dragIdxRef.current = null
      map.dragPan.enable()
      map.getCanvas().style.cursor = fpEditRef.current ? 'crosshair' : ''
      commitFootprintRef.current()
    }
    map.on('mouseup', onFpDragEnd)
    map.on('touchend', onFpDragEnd)

    // freeform footprint drawing: click vertices, close via first point /
    // double-click / Enter; rubber-band line + fill preview while drawing
    const updateDraft = (cursor) => {
      const pts = drawPtsRef.current
      const feats = []
      if (pts.length) {
        feats.push({
          type: 'Feature',
          properties: { kind: 'line' },
          geometry: { type: 'LineString', coordinates: cursor ? [...pts, cursor] : [...pts] },
        })
      }
      if (pts.length >= 2) {
        const ring = cursor ? [...pts, cursor, pts[0]] : [...pts, pts[0]]
        feats.push({
          type: 'Feature',
          properties: { kind: 'poly' },
          geometry: { type: 'Polygon', coordinates: [ring] },
        })
      }
      map.getSource('draft')?.setData({ type: 'FeatureCollection', features: feats })
    }

    map.on('click', (e) => {
      if (!drawModeRef.current) return
      const pts = drawPtsRef.current
      // clicking back on the first vertex closes the shape
      if (pts.length >= 3 && firstPixRef.current && e.point.dist(firstPixRef.current) < 12) {
        finishFreeformRef.current()
        return
      }
      pts.push([e.lngLat.lng, e.lngLat.lat])
      if (pts.length === 1) firstPixRef.current = e.point
      updateDraft([e.lngLat.lng, e.lngLat.lat])
    })
    map.on('mousemove', (e) => {
      if (!drawModeRef.current || !drawPtsRef.current.length) return
      updateDraft([e.lngLat.lng, e.lngLat.lat])
    })
    map.on('dblclick', (e) => {
      if (!drawModeRef.current) return
      e.preventDefault()
      // the two clicks of the double-click were added as vertices — drop them
      drawPtsRef.current.length = Math.max(0, drawPtsRef.current.length - 2)
      updateDraft(null)
      finishFreeformRef.current()
    })

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; loadedRef.current = false }
  }, [hasData]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    tileStyleRef.current = tileStyle
    for (const key of Object.keys(TILES)) {
      map.setLayoutProperty(`base-raster-${key}`, 'visibility', key === tileStyle ? 'visible' : 'none')
    }
    // white outlines vanish on the light basemap — switch to dark grey there
    map.setPaintProperty('bldg-line', 'line-color', tileStyle === 'light' ? '#3a3a3a' : '#ffffff')
  }, [tileStyle])

  return (
    <main className="workspace">
      <section className="viewport">
        {hasData ? (
          <>
            <div className="map-controls">
              <label className="tile-toggle">
                <span>tiles</span>
                <select value={tileStyle} onChange={(e) => setTileStyle(e.target.value)}>
                  <option value="satellite">satellite</option>
                  <option value="dark">dark</option>
                  <option value="light">light</option>
                </select>
              </label>
              {canEdit && (
                <button
                  className={`btn ${drawMode ? 'primary' : ''}`}
                  onClick={() => setDrawMode((v) => !v)}
                  title={drawMode ? 'click to add corners · close by clicking the first point, double-clicking, or pressing Enter · Esc cancels' : 'draw a freeform footprint by clicking its corners'}
                >
                  {drawMode ? 'drawing… (dblclick / Enter to finish)' : '+ add building'}
                </button>
              )}
            </div>
            <div ref={containerRef} className="maplibre-map" />
            <div className="legend">
              <span><i style={{ background: '#4da3ff' }} /> measured height (LiDAR / tag)</span>
              <span><i style={{ background: '#ffb84d' }} /> assumed 1 storey (no points)</span>
              <span><i style={{ background: '#2fbf8f' }} /> edited / manual</span>
              <span><i style={{ background: '#595969' }} /> basement (below ground)</span>
              <span>
                <i style={{ background: 'linear-gradient(90deg, #193c7a, #3f6ac2, #9fc4ef)' }} /> storeys (ground → roof)
              </span>
              {!canEdit && <span className="muted tiny">view-only — surveyors and registrars can edit</span>}
              {selected && (
                <span className="mono tiny">
                  {selected.building_id} · {selected.height_m} m · {selected.stories} storeys
                  {(selected.basements || 0) > 0 ? ` · B×${selected.basements}` : ''}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="lidar-empty muted">
            <h3>LiDAR → 3D buildings</h3>
            <p>have a <span className="mono">.laz</span> point cloud? upload it, enter a bounding box (or use your own footprint GeoJSON), and every footprint is extruded by the height of the LiDAR points above it.</p>
            <p>no LiDAR data? pick “no — GIS parcels only” and buildings are built from GIS parcel / OSM footprints, with heights from <span className="mono">height</span> or storey tags where available (otherwise 1 storey).</p>
          </div>
        )}
      </section>

      <aside className="sidebar">
        <div className="panel-section">
          <h3>data source</h3>
          <div className="upload-row">
            <label className="upload-field">
              <span>Is LiDAR point-cloud data (.laz) available for this area?</span>
              <span className="btn-row" role="group">
                <button
                  type="button"
                  className={`btn ${hasLidar ? 'primary' : ''}`}
                  onClick={() => setHasLidar(true)}
                >
                  yes — use .laz
                </button>
                <button
                  type="button"
                  className={`btn ${!hasLidar ? 'primary' : ''}`}
                  title="no point cloud: buildings come from GIS parcels / OSM footprints, heights from height or storey tags (else 1 storey)"
                  onClick={() => setHasLidar(false)}
                >
                  no — GIS parcels only
                </button>
              </span>
            </label>
            {hasLidar ? (
              <>
                <label className="upload-field">
                  <span>LiDAR point cloud (.laz)</span>
                  <input type="file" accept=".laz,.las" onChange={(e) => setLazFile(e.target.files[0] || null)} />
                </label>
                <div className="upload-options">
                  <label>
                    <span>EPSG override <span className="muted tiny">(only if .laz has no CRS)</span></span>
                    <input type="text" placeholder="e.g. 2193" value={epsg} onChange={(e) => setEpsg(e.target.value)} />
                  </label>
                  <label>
                    <span>storey height (m)</span>
                    <input type="number" step="0.1" min="1" value={floorHeight} onChange={(e) => setFloorHeight(e.target.value)} />
                  </label>
                </div>
              </>
            ) : (
              <div className="upload-options">
                <label>
                  <span>storey height (m) <span className="muted tiny">(for storey-tagged parcels)</span></span>
                  <input type="number" step="0.1" min="1" value={floorHeight} onChange={(e) => setFloorHeight(e.target.value)} />
                </label>
              </div>
            )}
            <div className="upload-options">
              <label>
                <span>footprint source</span>
                <select value={sourceMode} onChange={(e) => setSourceMode(e.target.value)}>
                  <option value="osm">fetch from OSM (bounding box)</option>
                  <option value="footprints">use footprint GeoJSON</option>
                </select>
              </label>
            </div>
            {sourceMode === 'osm' ? (
              <div className="upload-options">
                <label>
                  <span>bbox coordinates</span>
                  <select
                    value={hasLidar ? bboxCrs : 'wgs84'}
                    onChange={(e) => setBboxCrs(e.target.value)}
                  >
                    {hasLidar && <option value="laz">same as .laz CRS (auto)</option>}
                    <option value="wgs84">WGS84 lon/lat</option>
                  </select>
                </label>
                <label>
                  <span>&nbsp;</span>
                  <span className="muted tiny" style={{ padding: '7px 0' }}>
                    {lazBboxUnits
                      ? 'projected coords (e.g. metres) — transformed to WGS84 for OSM'
                      : 'degrees: lon −180…180, lat −90…90'}
                  </span>
                </label>
                <label>
                  <span>xmin {lazBboxUnits ? '(easting)' : '(lon)'}</span>
                  <input type="number" step="any" placeholder={lazBboxUnits ? 'e.g. 1789608.96' : 'e.g. 175.4674'} value={bbox.xmin}
                    onChange={(e) => setBbox({ ...bbox, xmin: e.target.value })} />
                </label>
                <label>
                  <span>ymin {lazBboxUnits ? '(northing)' : '(lat)'}</span>
                  <input type="number" step="any" placeholder={lazBboxUnits ? 'e.g. 5857822.67' : 'e.g. -37.8975'} value={bbox.ymin}
                    onChange={(e) => setBbox({ ...bbox, ymin: e.target.value })} />
                </label>
                <label>
                  <span>xmax {lazBboxUnits ? '(easting)' : '(lon)'}</span>
                  <input type="number" step="any" placeholder={lazBboxUnits ? 'e.g. 1791080.39' : 'e.g. 175.4747'} value={bbox.xmax}
                    onChange={(e) => setBbox({ ...bbox, xmax: e.target.value })} />
                </label>
                <label>
                  <span>ymax {lazBboxUnits ? '(northing)' : '(lat)'}</span>
                  <input type="number" step="any" placeholder={lazBboxUnits ? 'e.g. 5859009.34' : 'e.g. -37.8933'} value={bbox.ymax}
                    onChange={(e) => setBbox({ ...bbox, ymax: e.target.value })} />
                </label>
              </div>
            ) : (
              <>
                <label className="upload-field">
                  <span>building footprints (GeoJSON)</span>
                  <input type="file" accept=".geojson,.json" onChange={(e) => setFootprintsFile(e.target.files[0] || null)} />
                </label>
                {hasLidar && (
                  <div className="upload-options">
                    <label>
                      <span>footprint coordinates</span>
                      <select value={fpCrs} onChange={(e) => setFpCrs(e.target.value)}>
                        <option value="laz">same as .laz CRS (auto)</option>
                        <option value="wgs84">WGS84 lon/lat</option>
                      </select>
                    </label>
                    <label>
                      <span>&nbsp;</span>
                      <span className="muted tiny" style={{ padding: '7px 0' }}>
                        {fpCrs === 'laz'
                          ? 'projected coords (e.g. metres) — transformed to WGS84 to match the cloud'
                          : 'degrees: lon −180…180, lat −90…90'}
                      </span>
                    </label>
                  </div>
                )}
              </>
            )}
            <button
              className="btn primary"
              disabled={(hasLidar && !lazFile) || busy || (sourceMode === 'osm' ? !bboxValid : !footprintsFile)}
              onClick={onExtract}
            >
              {busy ? 'extracting…' : 'extract buildings'}
            </button>
            {err && <div className="error">{err}</div>}
            {job && (
              <div className={`steps ${job.state}`}>
                {job.steps.map((s) => (
                  <div key={s.key} className={`step ${s.state}`}>
                    <span className="step-dot" />
                    <span>{s.label}</span>
                    <span className="step-state muted tiny">
                      {s.state === 'done' ? '✓' : s.state === 'error' ? '✕' : s.note || (s.state === 'running' ? '…' : '')}
                    </span>
                  </div>
                ))}
                {job.state === 'done' && <span className="muted tiny">done — map updated</span>}
                {job.state === 'error' && <span className="step-error tiny">{job.error}</span>}
              </div>
            )}
          </div>
        </div>

        {result && (
          <div className="panel-section">
            <h3>extraction result</h3>
            <p className="muted tiny mono">{result.crs}</p>
            <table className="kv">
              <tbody>
                <tr><td>OSM footprints</td><td>{stats.osm_buildings_fetched ?? '—'}</td></tr>
                <tr><td>buildings</td><td>{features.length}</td></tr>
                {stats.from_lidar != null && <tr><td>from LiDAR</td><td>{stats.from_lidar}</td></tr>}
                {stats.from_height_tag != null && <tr><td>height tag</td><td>{stats.from_height_tag}</td></tr>}
                {stats.from_levels != null && <tr><td>levels tag</td><td>{stats.from_levels}</td></tr>}
                <tr><td>assumed 1 storey</td><td>{stats.assumed_1_story}</td></tr>
                <tr><td>edited / manual</td><td>{editedCount}</td></tr>
                <tr><td>tallest</td><td>{stats.max_height_m} m</td></tr>
                <tr><td>mean height</td><td>{stats.mean_height_m} m</td></tr>
                <tr><td>storey height</td><td>{stats.floor_height_m} m</td></tr>
                <tr><td>PostGIS</td><td>{postgisMsg ?? (stats.postgis_saved != null ? `saved (${stats.postgis_saved})` : '—')}</td></tr>
              </tbody>
            </table>
            {stats.postgis_warning && <div className="error">{stats.postgis_warning}</div>}
            <div className="btn-row">
              {canEdit && (
                <button className="btn" onClick={resetAll} disabled={!editedCount && features.length === originalsRef.current.size}>
                  reset all edits
                </button>
              )}
              <button className="btn" onClick={exportGeoJSON} disabled={!features.length}>
                download GeoJSON
              </button>
            </div>
          </div>
        )}

        {selected && (
          <div className="panel-section">
            <h3>
              building details
              {(selected.basements || 0) > 0 && (
                <span className="b-badge" title="has below-ground levels">B×{selected.basements}</span>
              )}
            </h3>
            {editing ? (
              <div className="edit-form">
                <label>
                  <span>floors (storeys)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    autoFocus
                    value={draft.floors}
                    onChange={(e) => {
                      const fl = Math.max(1, parseInt(e.target.value) || 1)
                      setDraft({ ...draft, floors: fl, height: +(fl * floorH).toFixed(2) })
                    }}
                  />
                </label>
                <label>
                  <span>basements</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={draft.basements ?? 0}
                    onChange={(e) => {
                      const b = Math.max(0, parseInt(e.target.value) || 0)
                      setDraft({ ...draft, basements: b })
                    }}
                  />
                </label>
                <label>
                  <span>height (m)</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.5"
                    value={draft.height}
                    onChange={(e) => {
                      const h = parseFloat(e.target.value) || 0
                      setDraft({ ...draft, height: e.target.value, floors: Math.max(1, Math.round(h / floorH)) })
                    }}
                  />
                </label>
                <div className="btn-row">
                  <button className="btn primary" onClick={saveEdit}>save</button>
                  <button className="btn" onClick={() => { setEditing(false); setDraft(null) }}>cancel</button>
                </div>
              </div>
            ) : (
              <>
                <table className="kv">
                  <tbody>
                    <tr><td>id</td><td className="mono">{selected.building_id}</td></tr>
                    {selected.name && <tr><td>name</td><td>{selected.name}</td></tr>}
                    <tr><td>height</td><td>{selected.height_m} m</td></tr>
                    <tr><td>storeys</td><td>{selected.stories}</td></tr>
                    <tr><td>basements</td><td>{selected.basements || 0}</td></tr>
                    <tr><td>ground Z</td><td>{selected.ground_z ?? '—'}</td></tr>
                    <tr><td>roof Z</td><td>{selected.roof_z ?? '—'}</td></tr>
                    <tr><td>LiDAR points</td><td>{selected.lidar_points}</td></tr>
                    <tr><td>source</td><td>{selected.height_source}</td></tr>
                    <tr>
                      <td>confirmation</td>
                      <td className={selected.edit_status === 'pending' ? 'status-pending' : selected.edit_status === 'confirmed' ? 'status-confirmed' : ''}>
                        {selected.edit_status === 'pending' ? '⏳ pending' : selected.edit_status === 'confirmed' ? '✓ confirmed' : '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
                {canEdit && (
                  <div className="btn-row">
                    <button className="btn primary" onClick={() => { setDraft({ height: selected.height_m, floors: selected.stories, basements: selected.basements || 0 }); setEditing(true) }}>
                      edit
                    </button>
                    {selected.geometry?.type === 'Polygon' && (
                      <button
                        className={`btn ${footprintEdit ? 'primary' : ''}`}
                        title={footprintEdit ? 'drag the corner handles, then click done' : 'drag the corner handles to reshape the footprint'}
                        onClick={() => setFootprintEdit((v) => !v)}
                      >
                        {footprintEdit ? 'done reshaping' : 'edit footprint'}
                      </button>
                    )}
                    {selected.geometry?.type === 'Polygon' && (
                      <button
                        className={`btn ${redrawMode ? 'primary' : ''}`}
                        title={redrawMode ? 'click the corners of the new outline — Enter / double-click to finish, Esc cancels' : 'draw a brand-new outline to replace this footprint'}
                        onClick={() => setRedrawMode((v) => !v)}
                      >
                        {redrawMode ? 'redrawing…' : 'redraw footprint'}
                      </button>
                    )}
                    <button
                      className="btn"
                      title="add one below-ground level (depth = storey height)"
                      onClick={() => changeBasements(1)}
                    >
                      + basement
                    </button>
                    {(selected.basements || 0) > 0 && (
                      <button
                        className="btn"
                        title="remove the deepest basement level"
                        onClick={() => changeBasements(-1)}
                      >
                        − basement
                      </button>
                    )}
                    {originalsRef.current.has(selectedId) && (
                      <button className="btn" onClick={resetBuilding}>reset</button>
                    )}
                    <button className="btn danger" onClick={deleteBuilding}>delete</button>
                  </div>
                )}
              </>
            )}
            {(selected.edit_history?.length || 0) > 0 && (
              <div className="history-block">
                <h3>change history</h3>
                <ul className="history">
                  {[...selected.edit_history].reverse().map((h, i) => (
                    <li key={i}>
                      <span className="who">{h.by} ({h.role})</span> — {h.change}
                      <span className="when">{new Date(h.at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </aside>
    </main>
  )
}

function pushFpSources(map, fp) {
  map.getSource('handles')?.setData({
    type: 'FeatureCollection',
    features: fp.ring.map((c, i) => ({
      type: 'Feature',
      properties: { idx: i },
      geometry: { type: 'Point', coordinates: c },
    })),
  })
  map.getSource('fpdraft')?.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[...fp.ring, fp.ring[0]]] },
    }],
  })
}

function bboxOf(featureCollection) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const f of featureCollection.features) {
    const g = f.geometry
    if (!g) continue
    const coords = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates.flat()
    for (const [x, y] of coords) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return [[x0, y0], [x1, y1]]
}

