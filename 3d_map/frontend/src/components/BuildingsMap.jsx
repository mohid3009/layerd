import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { floorSlices } from '../floors.js'

// Keyless tile providers (no {r} placeholder — MapLibre does not expand it).
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

function bboxOf(features) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const f of features) {
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
  return x0 === Infinity ? null : [[x0, y0], [x1, y1]]
}

// Pannable/zoomable map of every building saved in PostGIS. Starts framed on
// the saved set; you can pan/zoom anywhere in the world afterwards.
// Surveyor/registrar can free-draw a replacement footprint for the selected
// building (click points, Enter / double-click / first-point to finish).
export default function BuildingsMap({
  features,
  selectedId,
  onSelect,
  canEdit = false,
  onFootprintDrawn = null,
}) {
  const [tileStyle, setTileStyle] = useState('satellite')
  const [drawMode, setDrawMode] = useState(false)
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const loadedRef = useRef(false)
  const featuresRef = useRef(features)
  featuresRef.current = features
  const drawPtsRef = useRef([]) // committed freeform vertices [lng, lat]
  const firstPixRef = useRef(null) // pixel pos of the first vertex (click-to-close)
  const drawModeRef = useRef(false)
  const finishRef = useRef(() => {})
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId

  // per-floor render slices — multi-storey buildings get one coloured extrusion
  // per storey; selection still works via the building_id kept on each slice
  const renderFeatures = useMemo(() => floorSlices(features), [features])
  const renderRef = useRef(renderFeatures)
  renderRef.current = renderFeatures

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
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
          draft: { type: 'geojson', data: EMPTY_FC }, // free-draw preview
        },
        layers: [
          ...Object.keys(TILES).map((key, i) => ({
            id: `base-raster-${key}`,
            type: 'raster',
            source: `base-${key}`,
            layout: { visibility: i === 0 ? 'visible' : 'none' },
          })),
          { id: 'bldg-flat', type: 'fill', source: 'buildings',
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } },
          { id: 'bldg-extrude', type: 'fill-extrusion', source: 'buildings',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'height_m'],
              'fill-extrusion-base': ['coalesce', ['get', 'base_m'], 0],
              'fill-extrusion-opacity': 0.85,
            } },
          { id: 'bldg-line', type: 'line', source: 'buildings',
            paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.45 } },
          { id: 'bldg-basement', type: 'line', source: 'buildings',
            // dashed grey outline marking buildings that have basements
            filter: ['any',
              ['<', ['coalesce', ['get', 'floor'], 0], 0],
              ['all', ['>=', ['coalesce', ['get', 'basements'], 0], 1], ['!', ['has', 'floor']]],
            ],
            paint: { 'line-color': '#9ba1ad', 'line-width': 1.5, 'line-dasharray': [2, 2] } },
          {
            id: 'bldg-selected',
            type: 'line',
            source: 'buildings',
            filter: ['==', ['get', 'building_id'], ''],
            paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.95 },
          },
          { id: 'bldg-pending', type: 'line', source: 'buildings',
            // amber dashed outline marking buildings with unconfirmed edits
            filter: ['==', ['get', 'edit_status'], 'pending'],
            paint: { 'line-color': '#ffb84d', 'line-width': 2.5, 'line-dasharray': [2, 2], 'line-opacity': 0.95 } },
          { id: 'draft-fill', type: 'fill', source: 'draft',
            paint: { 'fill-color': '#ff5533', 'fill-opacity': 0.2 } },
          { id: 'draft-line', type: 'line', source: 'draft',
            paint: { 'line-color': '#ff5533', 'line-width': 2 } },
        ],
      },
      center: [10, 25],
      zoom: 1.6,
      attributionControl: false,
    })
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-left')

    map.on('load', () => {
      loadedRef.current = true
      map.getSource('buildings')?.setData({ type: 'FeatureCollection', features: renderRef.current })
      const bb = bboxOf(featuresRef.current)
      if (bb) map.fitBounds(bb, { padding: 60, duration: 1400, maxZoom: 17 })
    })
    map.on('click', 'bldg-extrude', (e) => {
      if (drawModeRef.current) return // drawing — clicks add vertices, not select
      if (e.features?.length && onSelect) onSelect(e.features[0].properties.building_id)
    })
    map.on('mouseenter', 'bldg-extrude', () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', 'bldg-extrude', () => (map.getCanvas().style.cursor = ''))

    // ── free-draw footprint replacement for the selected building ──────────
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
        finishRef.current()
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
      // the double-click added two vertices — drop them, then finish
      drawPtsRef.current.length = Math.max(0, drawPtsRef.current.length - 2)
      updateDraft(null)
      finishRef.current()
    })

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; loadedRef.current = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // push updated features into the source
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    map.getSource('buildings')?.setData({ type: 'FeatureCollection', features: renderFeatures })
    const bb = bboxOf(features)
    if (bb) map.fitBounds(bb, { padding: 60, duration: 1200, maxZoom: 17 })
  }, [features, renderFeatures])

  // selection highlight
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    map.setFilter('bldg-selected', ['==', ['get', 'building_id'], selectedId || ''])
  }, [selectedId])

  // free-draw mode bookkeeping (cursor, dblclick-zoom, pending shape)
  useEffect(() => {
    drawModeRef.current = drawMode
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    if (drawMode) {
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

  // finish the free-draw: hand the new ring to the parent for persistence
  finishRef.current = () => {
    const pts = drawPtsRef.current
    drawPtsRef.current = []
    firstPixRef.current = null
    mapRef.current?.getSource('draft')?.setData(EMPTY_FC)
    setDrawMode(false)
    if (pts.length >= 3 && onFootprintDrawn && selectedIdRef.current) {
      onFootprintDrawn(selectedIdRef.current, pts)
    }
  }

  // Escape cancels the free-draw, Enter finishes it
  useEffect(() => {
    if (!drawMode) return
    const onKey = (e) => {
      if (e.key === 'Escape') setDrawMode(false)
      if (e.key === 'Enter') finishRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawMode])

  // selection changed mid-draw — cancel so the ring can't land on the wrong building
  const prevSelRef = useRef(selectedId)
  useEffect(() => {
    if (prevSelRef.current !== selectedId) {
      prevSelRef.current = selectedId
      if (drawModeRef.current) setDrawMode(false)
    }
  }, [selectedId])

  // tile style switch
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    for (const key of Object.keys(TILES)) {
      map.setLayoutProperty(`base-raster-${key}`, 'visibility', key === tileStyle ? 'visible' : 'none')
    }
    // white outlines vanish on the light basemap — switch to dark grey there
    map.setPaintProperty('bldg-line', 'line-color', tileStyle === 'light' ? '#3a3a3a' : '#ffffff')
  }, [tileStyle])

  return (
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
        {canEdit && selectedId && (
          <button
            className={`btn ${drawMode ? 'primary' : ''}`}
            title={
              drawMode
                ? 'click the corners of the new outline — close on the first point, double-click, or press Enter · Esc cancels'
                : 'free-draw a replacement footprint for the selected building'
            }
            onClick={() => setDrawMode((v) => !v)}
          >
            {drawMode ? 'drawing… (Enter to finish)' : '✏ free-draw footprint'}
          </button>
        )}
      </div>
      <div ref={containerRef} className="maplibre-map" />
    </>
  )
}
