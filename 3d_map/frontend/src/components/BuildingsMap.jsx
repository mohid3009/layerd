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
export default function BuildingsMap({ features, selectedId, onSelect }) {
  const [tileStyle, setTileStyle] = useState('satellite')
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const loadedRef = useRef(false)
  const featuresRef = useRef(features)
  featuresRef.current = features

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
          {
            id: 'bldg-selected',
            type: 'line',
            source: 'buildings',
            filter: ['==', ['get', 'building_id'], ''],
            paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.95 },
          },
        ],
      },
      center: [10, 25],
      zoom: 1.6,
      attributionControl: false,
    })
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right')

    map.on('load', () => {
      loadedRef.current = true
      map.getSource('buildings')?.setData({ type: 'FeatureCollection', features: renderRef.current })
      const bb = bboxOf(featuresRef.current)
      if (bb) map.fitBounds(bb, { padding: 60, duration: 1400, maxZoom: 17 })
    })
    map.on('click', 'bldg-extrude', (e) => {
      if (e.features?.length && onSelect) onSelect(e.features[0].properties.building_id)
    })
    map.on('mouseenter', 'bldg-extrude', () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', 'bldg-extrude', () => (map.getCanvas().style.cursor = ''))

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

  // tile style switch
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    for (const key of Object.keys(TILES)) {
      map.setLayoutProperty(`base-raster-${key}`, 'visibility', key === tileStyle ? 'visible' : 'none')
    }
  }, [tileStyle])

  return (
    <>
      <div className="map-controls">
        <label className="tile-toggle">
          <span>tiles</span>
          <select value={tileStyle} onChange={(e) => setTileStyle(e.target.value)}>
            <option value="satellite">satellite</option>
            <option value="dark">dark</option>
          </select>
        </label>
      </div>
      <div ref={containerRef} className="maplibre-map" />
    </>
  )
}
