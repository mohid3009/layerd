# Layerd — Run Instructions

## Routes (React Router)

| URL | Description |
|-----|-------------|
| `/` | Landing page (redirects to `/dashboard` if logged in) |
| `/login?role=citizen|surveyor|registrar` | Login for the chosen role |
| `/dashboard` | Main dashboard — every building saved in PostGIS, pannable worldwide (protected) |
| `/lidar` | LiDAR scan — extraction + manual building editing (protected) |

Protected routes redirect to `/login` when there is no session; the session survives
page refreshes (stored in `sessionStorage`).

---

## PostgreSQL + PostGIS (generated buildings)

All generated buildings (and manual edits) are persisted to PostGIS and rendered on the
main dashboard. One-time setup (already done on this machine — local PostgreSQL 16,
user `postgres`):

```powershell
# creates the 'layerd' DB + postgis extension
python setup_db.py
```

- DSN: default `postgresql://postgres:postgres@localhost:5432/layerd`, override with the
  `POSTGRES_DSN` env var
- table `lidar_buildings`: `geometry(Polygon,4326)` + GIST index, heights/stories/sources,
  full property JSONB
- the pipeline saves automatically as its final step ("Saving to PostGIS"); manual edits in
  the LiDAR view auto-sync (debounced), and `POST /lidar/buildings/sync` reconciles the
  table with the edited set (deletes removed buildings)
- if PostGIS is down, extraction still works — the save step shows an error and the stats
  carry a warning

Dashboard: framed on the saved buildings' extent — **pan/zoom anywhere in the world**;
every building generated from any country's LiDAR scan shows up here (green outline when
selected). Click a building for its details panel.

---

## LiDAR mode (real-data pipeline)

Log in, then click **LiDAR scan** in the topbar. Upload a `.laz` point cloud **with its CRS
embedded in the header** (e.g. `lidar/points (1).laz` — NZTM2000 / EPSG:2193), then either:

- enter a **bounding box** (xmin, ymin, xmax, ymax) — building footprints
  inside the box are fetched from **OSM** via the Overpass API. Coordinates
  can be in the **.laz's native CRS** (default; auto-transformed to WGS84,
  e.g. NZTM easting/northing metres) or **WGS84 lon/lat**. Keep the box under
  ~0.02 deg² (~14 km × 14 km) — public Overpass servers reject larger areas, or
- switch the source to **footprint GeoJSON** and upload a footprints file (WGS84).

The backend (`3d_map/backend/app/lidar_buildings.py`, pipeline modelled on `lidar/lidar.py`)
reprojects the cloud to WGS84, measures ground/roof height of the LiDAR points above each
footprint, and returns `height_m` + `stories` per building. Footprints with **no LiDAR points
above them are assumed to be 1-storey buildings** (flagged `assumed-1-story`). Buildings are
rendered with `fill-extrusion` (blue = LiDAR-measured, orange = assumed,
**green = edited / manually added**).

### Manual editing (after generation)
- click any extruded building → **building details** panel
- **edit** — set the **number of floors** directly (height auto-syncs as
  floors × storey height) or type an exact height in metres; the extrusion
  updates live and the building turns green
- **reset** — restore that building's original LiDAR-measured values
- **delete** — remove a building
- **+ add building** (map toolbar) — draw a **freeform footprint**: click each corner
  (rubber-band preview while drawing), then close it by clicking back on the first point,
  double-clicking, or pressing **Enter** (**Esc** cancels). It starts at 1 storey and is
  immediately editable
- **reset all edits** / **download GeoJSON** — export the edited set as
  `buildings_edited.geojson`

Optional: EPSG override (only if the `.laz` has no CRS) and storey-height parameter.

Validation script: `python test_lidar_buildings.py` from the repo root (synthesises footprints
from the cloud itself and checks both the measured and the 1-storey fallback paths).

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Python | ≥ 3.10 | Use `lidarvenv` (already created at repo root) |
| Node.js | ≥ 18 | `node_modules` already installed |
| npm | ≥ 9 | — |
| PostgreSQL + PostGIS | 16 / 3.6 | see setup above |

---

## Start the App (two terminals)

### Terminal 1 — Backend

```powershell
# From repo root
.\lidarvenv\Scripts\Activate.ps1
cd 3d_map\backend
uvicorn app.main:app --reload --port 8000
```

API docs available at: http://localhost:8000/docs

### Terminal 2 — Frontend

```powershell
cd 3d_map\frontend
npm run dev
```

Open: **http://localhost:5173**
