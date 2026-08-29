# 3D ULPIN — Run Instructions

## Routes (React Router)

| URL | Description |
|-----|-------------|
| `/` | Landing page (redirects to `/dashboard` if logged in) |
| `/login?role=citizen|surveyor|registrar` | Login for the chosen role |
| `/dashboard` | Main cadastral dashboard — parcels map, units, disputes (protected) |
| `/lidar` | LiDAR scan — extraction + manual building editing (protected) |

Protected routes redirect to `/login` when there is no session; the session survives
page refreshes (stored in `sessionStorage`).

---

## PostgreSQL + PostGIS (generated buildings)

Generation results (and manual edits) are persisted to PostGIS and shown on the main
dashboard. Setup (one-time, already done on this machine):

```powershell
# creates the 'layerd' DB + postgis extension (uses local PostgreSQL 16, user postgres)
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

Dashboard: the **"LiDAR buildings (N)"** toggle in the view toolbar renders the saved set
as green extrusions on the parcels map (fetched from `GET /lidar/buildings`).

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
then rendered on a MapLibre map with `fill-extrusion` (blue = LiDAR-measured, orange = assumed,
**green = edited / manually added**).

### Manual editing (after generation)
- click any extruded building → **building details** panel
- **edit** — type a new height (storeys auto-derived from the storey height); the extrusion
  updates live and the building turns green
- **reset** — restore that building's original LiDAR-measured values
- **delete** — remove a building
- **+ add building** (map toolbar) — draw a **freeform footprint**: click each corner
  (rubber-band preview while drawing), then close it by clicking back on the first point,
  double-clicking, or pressing **Enter** (**Esc** cancels). It starts at 1 storey and is
  immediately editable
- **edit** lets you set the **number of floors** directly (height auto-syncs as
  floors × storey height) or type an exact height in metres
- **reset all edits** / **download GeoJSON** — export the edited set as
  `buildings_edited.geojson`

Optional: EPSG override (only if the `.laz` has no CRS) and storey-height parameter.

Endpoints:
- `POST /lidar/osm` (multipart: `laz`, `xmin`, `ymin`, `xmax`, `ymax`, optional `epsg`, `floor_height`)
- `POST /lidar/buildings` (multipart: `laz`, `footprints`, optional `epsg`, `floor_height`)

Validation script: `python test_lidar_buildings.py` from the repo root (synthesises footprints
from the cloud itself and checks both the measured and the 1-storey fallback paths).

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Python | ≥ 3.10 | Use `lidarvenv` (already created at repo root) |
| Node.js | ≥ 18 | `node_modules` already installed |
| npm | ≥ 9 | — |

---

## One-time Setup

### Backend (Python)

```powershell
# From repo root — activate the existing venv
.\lidarvenv\Scripts\Activate.ps1

# Install Python dependencies
pip install -r 3d_map\backend\requirements.txt
```

### Frontend

```powershell
# Already done (node_modules present), but if needed:
cd 3d_map\frontend
npm install
```

---

## Start the App (two terminals)

### Terminal 1 — Backend

```powershell
# From repo root
.\lidarvenv\Scripts\Activate.ps1
cd 3d_map\backend
uvicorn app.main:app --reload --port 8000
```

The DB seeds automatically on first start if empty.  
API docs available at: http://localhost:8000/docs

### Terminal 2 — Frontend

```powershell
cd 3d_map\frontend
npm run dev
```

Open: **http://localhost:5173**

---

## Demo Parcels (pre-loaded)

| ULPIN | Location | Floors | Notes |
|-------|----------|--------|-------|
| `TN-02-6001-2345-6789` | Adyar, Chennai | G+3 + B1 | **Main demo parcel** — Sarraswathi Apartments (real OSM Way 376515485), 4 units/floor, rotating owners |
| `TN-02-6002-3456-7890` | Adyar, Chennai | G+1 | Simpler backup parcel — real 2-storey house (OSM Way 628691058) |
| `TN-02-6003-4567-8901` | Adyar, Chennai | G+2 | **Conflict demo** — neighbouring house (OSM Way 628691059); Floor 1 has 2 overlapping units (pre-flagged), open dispute |

---

## Demo Script Quick Reference

| Step | Role | Action |
|------|------|--------|
| 1 | Citizen | Search `TN-02-6001` → click parcel → see "⚑ 3D vertical units" badge |
| 2 | Citizen | Switch to 3D view → click a unit → see masked owner + ULPIN |
| 3 | Citizen | Click "report dispute on this unit" → submit |
| 4 | Surveyor | Upload `conflict_floorplan.png` → see OpenCV overlay |
| 5 | Surveyor | Click "validate & generate" on Parcel B → passes |
| 6 | Registrar | Select Parcel C → 3D view → two red units visible → click dispute in queue → auto-jumps to 3D |
| 7 | Registrar | Approve dispute → new hash-chained ledger entry appears |
| 8 | Registrar | "push to NGDRS (mock)" → modal with JSON + checksum |
| 9 | Registrar | "simulate tampering" → chain shows TAMPERED (pulsing red) |

---

## Resetting the Database

```powershell
# From repo root, with venv active
cd 3d_map\backend
python app\reset_db.py
```

This drops all data and re-seeds from scratch.

---

## Conflict Demo Floor Plan

A pre-built test image is at:
```
3d_map\backend\assets\conflict_floorplan.png
```
Upload it in the **Surveyor panel** on **Parcel C, Floor 1** to demonstrate topology validation failure. The image contains two overlapping rooms — OpenCV will detect both contours and the topology check will flag the overlap.
