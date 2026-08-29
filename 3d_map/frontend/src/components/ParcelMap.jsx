import React, { useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// ── Tile providers ────────────────────────────────────────────────────────────
// All providers are keyless. NOTE: no {r} placeholder — MapLibre does not expand
// it (unlike Leaflet), so every tile request would 404.
//   dark:      Esri World Dark Gray Base (keyless dark canvas)
//   light:     OpenStreetMap standard raster tiles (keyless)
//   satellite: Esri World Imagery (keyless)
const TILES = {
  dark: {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attr: '© Esri, HERE, Garmin, FAO, NOAA, USGS · © OpenStreetMap contributors',
    maxzoom: 16,
  },
  light: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  satellite: {
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: '© Esri, Maxar, Earthstar Geographics',
    maxzoom: 19,
  },
}

// ── Full initial MapLibre style ───────────────────────────────────────────────
// Parcel layers declared here so setStyle() is NEVER needed.
// Tile switching = raster layer visibility toggle  ·  Parcel update = source.setData()
// One raster source per provider so each can declare its true maxzoom —
// requesting tiles beyond a service's max LOD returns Esri "Map data not yet
// available" placeholder tiles.
const BASE_SOURCES = Object.fromEntries(
  Object.entries(TILES).map(([key, t]) => [
    `base-${key}`,
    { type: 'raster', tiles: [t.url], tileSize: 256, attribution: t.attr, maxzoom: t.maxzoom },
  ]),
)
const BASE_LAYERS = Object.keys(TILES).map((key, i) => ({
  id: `base-raster-${key}`,
  type: 'raster',
  source: `base-${key}`,
  layout: { visibility: i === 0 ? 'visible' : 'none' },
}))

const INITIAL_STYLE = {
  version: 8,
  // ❶ Light is REQUIRED for fill-extrusion to be visible.
  //    Without it, extrusion faces render pitch-black.
  light: {
    anchor: 'viewport',
    color: '#ffffff',
    intensity: 0.5,
  },
  // MapLibre's own font CDN — reliable, no key.
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    ...BASE_SOURCES,
    parcels: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    },
    lidar: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    },
  },
  layers: [
    // ── Base map tiles (one layer per provider, toggled via visibility) ─────
    ...BASE_LAYERS,

    // ── Parcel flat fill (always visible, even if extrusion fails) ──────────
    {
      id: 'parcel-flat',
      type: 'fill',
      source: 'parcels',
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': 0.25,
      },
    },

    // ── Parcel 3D fill-extrusion ────────────────────────────────────────────
    {
      id: 'parcel-fill',
      type: 'fill-extrusion',
      source: 'parcels',
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.85,
      },
    },

    // ── Parcel outline ──────────────────────────────────────────────────────
    {
      id: 'parcel-line',
      type: 'line',
      source: 'parcels',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['get', 'active'], 3, 1.2],
        'line-opacity': 0.95,
      },
    },

    // ── ULPIN labels ────────────────────────────────────────────────────────
    {
      id: 'parcel-label',
      type: 'symbol',
      source: 'parcels',
      layout: {
        'text-field': ['get', 'ulpin'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-offset': [0, -1.6],
        'text-anchor': 'bottom',
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1.8,
      },
    },

    // ── LiDAR-generated buildings (PostGIS) — hidden until toggled on ───────
    {
      id: 'lidar-extrude',
      type: 'fill-extrusion',
      source: 'lidar',
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'height_m'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.8,
      },
    },
    {
      id: 'lidar-line',
      type: 'line',
      source: 'lidar',
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#2fbf8f',
        'line-width': 1,
        'line-opacity': 0.6,
      },
    },
  ],
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function bboxCenter(geojson) {
  const ring = geojson.coordinates[0]
  const lats = ring.map((c) => c[1])
  const lons = ring.map((c) => c[0])
  return {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
  }
}

// Bounding box across ALL parcels — used to frame the whole neighbourhood.
function boundsOf(parcels) {
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90
  for (const p of parcels) {
    for (const [lon, lat] of p.footprint_geojson.coordinates[0]) {
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
  }
  return [[minLon, minLat], [maxLon, maxLat]]
}

function makeGeoJSON(parcels, selectedUlpin) {
  return {
    type: 'FeatureCollection',
    features: parcels.map((p) => ({
      type: 'Feature',
      properties: {
        ulpin: p.ulpin,
        active: p.ulpin === selectedUlpin,
        height:
          p.floor_count && p.floor_height_m
            ? Math.max(p.floor_count * p.floor_height_m, 3)
            : p.unit_count > 0 ? 12 + Math.min(p.unit_count * 2.5, 40) : 8,
        color: p.ulpin === selectedUlpin ? '#ffffff' : '#4e5a72',
      },
      geometry: p.footprint_geojson,
    })),
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function ParcelMap({ parcels, selectedUlpin, onSelect, lidarFeatures }) {
  const containerRef = useRef(null)
  const mapRef       = useRef(null)
  const loadedRef    = useRef(false)

  // Always-fresh props — callbacks read here, never from stale closures.
  const propsRef = useRef({ parcels, selectedUlpin, onSelect })
  useEffect(() => { propsRef.current = { parcels, selectedUlpin, onSelect } })

  const [tileStyle, setTileStyle] = useState('dark')
  const [pitch3d,   setPitch3d]   = useState(true)

  // ── Init map once ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new MapLibreMap({
      container: containerRef.current,
      style: INITIAL_STYLE,
      center: [80.2516, 13.0056],
      zoom: 15,
      pitch: 0,
      bearing: 0,
      attributionControl: false, // replaced by our .map-attrib div
    })

    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right')

    map.on('load', () => {
      loadedRef.current = true

      // Wire click / cursor interactions.
      map.on('click', 'parcel-fill', (e) => {
        const ulpin = e.features?.[0]?.properties?.ulpin
        if (ulpin) propsRef.current.onSelect(ulpin)
      })
      map.on('click', 'parcel-flat', (e) => {
        const ulpin = e.features?.[0]?.properties?.ulpin
        if (ulpin) propsRef.current.onSelect(ulpin)
      })
      map.on('mouseenter', 'parcel-fill', () => (map.getCanvas().style.cursor = 'pointer'))
      map.on('mouseleave', 'parcel-fill', () => (map.getCanvas().style.cursor = ''))

      // Populate parcels immediately after load: frame the WHOLE neighbourhood
      // on first paint (don't zoom straight into the selected parcel).
      const { parcels: ps } = propsRef.current
      if (ps.length) {
        map.getSource('parcels').setData(makeGeoJSON(ps, propsRef.current.selectedUlpin))
        map.fitBounds(boundsOf(ps), { padding: 70, duration: 1800, maxZoom: 15.6 })
        map.easeTo({ pitch: pitch3d ? 55 : 0, duration: 1800 })
      }
    })

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; loadedRef.current = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Switch tile style — update source in-place, never call setStyle() ─────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    // Toggle raster layers instead of setTiles() so each provider keeps its own maxzoom.
    for (const key of Object.keys(TILES)) {
      map.setLayoutProperty(`base-raster-${key}`, 'visibility', key === tileStyle ? 'visible' : 'none')
    }
  }, [tileStyle])

  // ── Pitch toggle ──────────────────────────────────────────────────────────
  useEffect(() => {
    mapRef.current?.easeTo({ pitch: pitch3d ? 55 : 0, duration: 700 })
  }, [pitch3d])

  // ── LiDAR buildings saved in PostGIS ──────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current || !lidarFeatures) return
    map.getSource('lidar')?.setData({ type: 'FeatureCollection', features: lidarFeatures })
  }, [lidarFeatures])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    const vis = lidarFeatures && lidarFeatures.length ? 'visible' : 'none'
    for (const id of ['lidar-extrude', 'lidar-line']) {
      map.setLayoutProperty(id, 'visibility', vis)
    }
  }, [lidarFeatures])

  // ── Update parcels / fly on selection change ──────────────────────────────
  const firstDataRef = useRef(true)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current || !parcels.length || !selectedUlpin) return

    map.getSource('parcels').setData(makeGeoJSON(parcels, selectedUlpin))

    // Initial data arrival: the load handler already framed the whole
    // neighbourhood — don't immediately zoom into the selected parcel.
    if (firstDataRef.current) {
      firstDataRef.current = false
      return
    }

    const sel = parcels.find((p) => p.ulpin === selectedUlpin)
    if (sel) {
      const c = bboxCenter(sel.footprint_geojson)
      map.flyTo({
        center: [c.lon, c.lat],
        zoom: 16.5,
        pitch: pitch3d ? 55 : 0,
        bearing: 0,
        duration: 1600,
        essential: true,
      })
    }
  }, [parcels, selectedUlpin, pitch3d, onSelect]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="map-wrap">
      <div className="map-controls">
        <label className="tile-toggle">
          <span>tiles</span>
          <select value={tileStyle} onChange={(e) => setTileStyle(e.target.value)}>
            <option value="dark">dark</option>
            <option value="light">light</option>
            <option value="satellite">satellite</option>
          </select>
        </label>
        <button
          className={`btn ${pitch3d ? 'primary' : ''}`}
          onClick={() => setPitch3d((v) => !v)}
          title="Toggle 3D perspective"
        >
          {pitch3d ? '3D on' : '3D off'}
        </button>
      </div>
      <div ref={containerRef} className="maplibre-map" />
      {/* Tiny legal attribution replacing the default obtrusive MapLibre control */}
      <div
        className="map-attrib"
        dangerouslySetInnerHTML={{ __html: TILES[tileStyle].attr }}
      />
    </div>
  )
}