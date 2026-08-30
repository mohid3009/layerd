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
  full property JSONB; every extraction run is stored as a **separate scan session**
  (`lidar_sessions` table) — sessions accumulate, nothing is overwritten
- the pipeline saves automatically as its final step ("Saving to PostGIS"); manual edits in
  the LiDAR view auto-sync (debounced) **within their own session**, and
  `POST /lidar/buildings/sync` reconciles only that session
- dashboard sidebar lists all scan sessions: tick/untick to show/hide each one on the map,
  ✕ deletes a session and its buildings (`DELETE /lidar/sessions/{id}`)
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
- **+ basement / − basement** — add or remove **below-ground levels** on any
  building (each one storey-height deep, rendered below the map plane in grey
  with its own B1/B2… slice); stored as `basements` in the building properties
  and persisted to PostGIS / the GeoJSON export like every other edit
- **edit footprint** — reshape the selected building's outline by **dragging
  its corner handles** (orange preview while dragging); each drag commits on
  mouse release
- **who can edit** — **surveyor or registrar** (citizens are view-only); the
  dashboard map highlights the selected building and shows the same data

### Change history (audit trail)

Every edit — building created, height/storeys/basements changed, footprint
reshaped — is appended to the building's `edit_history` property with
**who** (name + role) made it, **what** changed (e.g. `height 12→15 m`,
`basements 0→2`, `footprint adjusted (4 corners)`) and **when**. The trail is
shown in the **building details** panel ("change history", both in the scan
view and the dashboard) and is persisted to PostGIS + the GeoJSON export.

### Edit confirmation workflow (surveyor → registrar)

Buildings can be edited from **both** the LiDAR scan view and the main
dashboard (click a building → **edit**; surveyor or registrar). Every edit is
appended to the building's change history and carries a confirmation status:

- **surveyor** edits → `edit_status: pending` — the dashboard shows a
  **⚑ N edits awaiting confirmation** badge (for the registrar) plus a
  **pending confirmations** list; the details panel shows "⏳ pending".
- **registrar** → opens the dashboard, clicks a pending building (or a row in
  the pending list) and presses **✓ confirm edit** — status flips to
  "✓ confirmed" and a `edit confirmed by registrar` entry is added to the
  history. Registrar's own edits are confirmed automatically.

All of it persists in PostGIS (`props.edit_status` / `props.edit_history`) via
`POST /lidar/buildings/update` (single-building upsert) and
`POST /lidar/buildings/confirm`.

### Scans grouped by country & region

The dashboard sidebar's **scans** tab groups saved scans hierarchically:
**country → region → individual scans**. Each scan session is located by
reverse-geocoding its centroid (server-side via Nominatim, cached in memory
for a week — `GET /lidar/regions`). Click a country to show only its
buildings, then a region, then a scan to zoom right in; "←" breadcrumbs take
you back up a level. Surveyors/registrars can still delete sessions (✕) at
the scan level. While locations resolve, the group shows "⏳ locating…";
unresolvable points land under "Unknown area".

### 3D ULPIN units (per-building unit tree)

The **ulpin units** tab (top bar) is the 3D ULPIN explorer: pick a building →
generate its vertical unit tree → browse every unit in 3D with its ULPIN,
owner, area and rights type.

- **Base ULPIN**: a deterministic mock 14-digit ID (`XX-DD-DDDD-DDDD-DDDD`,
  e.g. `EE-26-2308-1979-6175`) hashed from the building id — stable across
  regenerations.
- **Unit ULPINs**: `{base}-F{floor}-U{unit}` — floors 1..N, basements negative
  (`F-1`, `F-2`), per the PRD.
- **Segmentation**: upload a floor plan image and **YOLOv11-seg** (`ultralytics`,
  weights `yolo11n-seg.pt` auto-downloaded on first use) segments it into unit
  rects; **without an image, or if the model is unavailable, a randomly
  generated plan is used as the fallback** (recursive plate subdivision).
  The result reports which source produced the layout.
- **Ownership**: each unit gets a deterministic demo owner (12-owner registry)
  and a rights type (owned / leased / common / air-rights; basements are
  leased/common). Topology check: units on a floor are tested for overlap and
  flagged `conflict` (PRD FR13).
- Everything persists in PostGIS (`ulpin_units` table) via
  `POST /lidar/units/generate`, `GET /lidar/units?building_id=`,
  `DELETE /lidar/units?building_id=`.

### Registrar notifications tab

The registrar's dashboard sidebar has two tabs: **scan sessions** and
**⚑ confirmations (n)**. The confirmations tab lists every building with a
pending edit; clicking a notification selects the building on the map (its
session is auto-ticked if hidden) and the details panel shows a highlighted
**proposed change** block — struck-through original values next to the
proposed ones — plus the **✓ confirm edit** button. Pending buildings are
outlined with an **amber dashed line** on the dashboard map.

### Deleting + redrawing footprints (surveyor / registrar)

- **delete** — the details panel on the dashboard (and the scan view) has a
  **delete** button that removes the building from PostGIS
  (`DELETE /lidar/buildings/{id}`) and from the working set.
- **free-draw footprint** — with a building selected, click **✏ free-draw
  footprint** (dashboard map-controls, or **redraw footprint** in the scan
  view) and click the corners of the new outline — as many points as you
  like. Close it by clicking the first point again, double-clicking, or
  pressing **Enter** (**Esc** cancels). The new geometry replaces the old one
  and is recorded as `footprint redrawn (n corners)` in the history, marked
  pending registrar confirmation for surveyors (registrar edits are
  auto-confirmed). For small tweaks, **edit footprint** (drag the corner
  handles) also works in the scan view.

### Basement indication on the map

Buildings with basements get a **dashed grey ground outline** plus the grey
below-ground extrusion slices; the details panel shows a **B×n** badge next to
the title and the legend/selected line shows `B×n` as well.
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

## Start the App (pick one)

### A. Mobile (Expo Go, same Wi-Fi)

The backend must listen on the LAN so the phone can reach it:

```powershell
cd 3d_map\backend
..\..\lidarvenv\Scripts\Activate.ps1
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Allow inbound port 8000 once (as Administrator):
`netsh advfirewall firewall add rule name="Layerd API 8000" dir=in action=allow protocol=TCP localport=8000`

Then run the Expo client (PC Wi-Fi IP is currently `172.16.98.188`):

```powershell
cd 3d_map\App
npm install
npm start
```

Scan the QR code with **Expo Go** (phone on the same Wi-Fi). The app:
- logs in against the backend (`POST /api/login`, demo credentials pre-filled per role),
- lists all saved buildings with sessions (pull-to-refresh),
- opens a building's **3D ULPIN unit tree**: base ULPIN, units grouped by floor
  with ULPIN + owner, tap a unit for area / rights / status / segmentation,
  and generate / re-segment units (surveyor or registrar) — including the
  YOLOv11-seg floor-plan path.
- The PC address is editable on the login screen (defaults to
  `172.16.98.188:8000/api`) and persisted on the device.

### B. Desktop app (Electron)

```powershell
cd 3d_map\desktop
npm install        # once (downloads Electron)
npm start          # spawns the backend + opens the Layerd window
```

- The shell starts the FastAPI backend from `lidarvenv` on a **free port** and
  loads the built UI served by that backend — everything shares one origin
  (the API is aliased under `/api/`, so the frontend needs no proxy).
- `npm run dev` — dev mode: expects the Vite dev server (`npm run dev` in
  `3d_map/frontend`) and runs the backend with `--reload`.
- PostgreSQL must be running (the app still opens without it — persistence is
  simply disabled).
- Requires a one-time `npm run build` in `3d_map/frontend` so `dist/` exists
  (the backend serves it).

### C. Web (two terminals)

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
