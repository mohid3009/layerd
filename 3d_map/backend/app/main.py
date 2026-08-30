import json
import os

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .postgis import init_postgis

app = FastAPI(title="Layerd API", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

VALID_ROLES = {"citizen", "surveyor", "registrar"}

# Role views for the demo â€” swap for real auth in production.
DEMO_ACCOUNTS = {
    "citizen":   {"username": "ramesh",  "password": "citizen123",  "name": "Ramesh Iyer"},
    "surveyor":  {"username": "priya",   "password": "survey123",   "name": "Priya Venkatesan"},
    "registrar": {"username": "arun",    "password": "register123", "name": "Arun Krishnan"},
}


@app.post("/login")
def login(payload: dict = Body(...)):
    username = str(payload.get("username", "")).strip().lower()
    password = str(payload.get("password", ""))
    role = str(payload.get("role", "")).strip().lower()
    if role not in VALID_ROLES:
        raise HTTPException(400, f"role must be one of {sorted(VALID_ROLES)}")
    acct = DEMO_ACCOUNTS[role]
    if username != acct["username"] or password != acct["password"]:
        raise HTTPException(401, "invalid username or password for this role")
    import hashlib
    token = hashlib.sha256(f"{username}:{password}:{role}".encode()).hexdigest()[:32]
    return {"token": token, "role": role, "username": username, "name": acct["name"]}


@app.on_event("startup")
def startup():
    try:
        init_postgis()
        print("[startup] PostGIS ready")
    except Exception as e:  # PostGIS is optional â€” the app works without it
        print(f"[startup] PostGIS unavailable ({e}) â€” LiDAR persistence disabled")


# ---------------- Step-wise extraction jobs ----------------

@app.post("/lidar/extract/start")
async def start_extraction(
    laz: UploadFile | None = File(None),
    mode: str = Form("osm"),
    footprints: UploadFile | None = File(None),
    xmin: float | None = Form(None),
    ymin: float | None = Form(None),
    xmax: float | None = Form(None),
    ymax: float | None = Form(None),
    bbox_crs: str = Form("laz"),  # 'laz' = bbox in the .laz's native CRS
    footprints_crs: str = Form("wgs84"),  # 'laz' = footprint GeoJSON in the .laz's native CRS
    epsg: int | None = Form(None),
    floor_height: float = Form(3.0),
):
    """
    Start a LiDAR extraction job and return its id immediately. Poll
    GET /lidar/extract/{job_id} for step-wise progress and the final result.
    mode: 'osm' (footprints fetched for the xmin/ymin/xmax/ymax bbox) or
    'footprints' (footprints uploaded as a GeoJSON file). bbox_crs /
    footprints_crs = 'laz' means the given coordinates are in the .laz's
    native projected CRS (transformed to WGS84 server-side); 'wgs84' means
    plain lon/lat degrees.
    """
    import threading

    from .extract_jobs import create_job, run_extraction

    if mode not in ("osm", "footprints"):
        raise HTTPException(400, "mode must be 'osm' or 'footprints'")
    if floor_height <= 0:
        raise HTTPException(400, "floor_height must be positive")

    # read uploads up-front; an empty part counts as "not provided" (some
    # FastAPI/python-multipart combos reject a multipart body in which an
    # optional file field is entirely absent, so the frontend sends an empty
    # placeholder part instead)
    laz_bytes = await laz.read() if laz else None
    footprints_bytes = await footprints.read() if footprints else None
    if laz_bytes == b"":
        laz_bytes = None
    if footprints_bytes == b"":
        footprints_bytes = None
    has_lidar = bool(laz_bytes)  # without a .laz, heights come from attributes

    if mode == "osm":
        if None in (xmin, ymin, xmax, ymax):
            raise HTTPException(400, "bbox required: xmin, ymin, xmax, ymax")
        if xmin >= xmax or ymin >= ymax:
            raise HTTPException(400, "invalid bbox: need xmin < xmax and ymin < ymax")
        if not has_lidar and bbox_crs == "laz":
            bbox_crs = "wgs84"  # no .laz CRS to borrow — bbox must be WGS84
        if bbox_crs not in ("laz", "wgs84"):
            raise HTTPException(400, "bbox_crs must be 'laz' or 'wgs84'")
        if bbox_crs == "wgs84" and not (
            -180 <= xmin <= 180 and -180 <= xmax <= 180
            and -90 <= ymin <= 90 and -90 <= ymax <= 90
        ):
            raise HTTPException(
                400,
                "these look like projected coordinates (e.g. metres), not "
                "WGS84 lon/lat â€” set 'bbox coordinates' to 'same as .laz CRS'",
            )
        bbox = (xmin, ymin, xmax, ymax)
    else:
        if footprints is None:
            raise HTTPException(400, "footprints file required for mode 'footprints'")
        if footprints_crs not in ("laz", "wgs84"):
            raise HTTPException(400, "footprints_crs must be 'laz' or 'wgs84'")
        if footprints_crs == "laz" and not has_lidar:
            raise HTTPException(
                400,
                "footprint coordinates set to 'same as .laz CRS' but no .laz was uploaded",
            )
        bbox = None

    job = create_job(mode, has_lidar=has_lidar)
    thread = threading.Thread(
        target=run_extraction,
        args=(job, mode, laz_bytes, footprints_bytes, bbox, bbox_crs, footprints_crs, epsg, float(floor_height)),
        daemon=True,
    )
    thread.start()
    return {"job_id": job["job_id"], "steps": job["steps"]}


@app.get("/lidar/extract/{job_id}")
def extraction_status(job_id: str):
    """Step-wise progress + (when finished) the full extraction result."""
    from .extract_jobs import get_job

    job = get_job(job_id)
    if not job:
        raise HTTPException(404, f"job {job_id} not found")
    return {
        "job_id": job["job_id"],
        "state": job["state"],
        "steps": job["steps"],
        "error": job["error"],
        "result": job["result"],
    }


# ---------------- PostGIS persistence (saved buildings + scan sessions) ----------------

@app.get("/lidar/buildings/status")
def lidar_saved_status():
    from .postgis import count_buildings, is_available
    if not is_available():
        return {"available": False, "count": 0}
    return {"available": True, "count": count_buildings()}


@app.get("/lidar/buildings")
def lidar_saved_buildings(session_id: str | None = Query(None)):
    """Saved buildings as GeoJSON — all scan sessions, or one via ?session_id=."""
    from .postgis import fetch_buildings, is_available
    if not is_available():
        raise HTTPException(503, "PostGIS is not available")
    return fetch_buildings(session_id=session_id)


@app.post("/lidar/buildings/sync")
def lidar_sync_buildings(payload: dict = Body(...)):
    """
    Persist the (possibly manually edited) working set of ONE scan session:
    upserts every feature into that session and deletes session rows missing
    from the payload. Other sessions are never touched.
    """
    import uuid

    from .postgis import save_buildings
    fc = payload.get("buildings")
    if not isinstance(fc, dict) or fc.get("type") != "FeatureCollection":
        raise HTTPException(400, "body must contain a FeatureCollection under 'buildings'")
    session_id = payload.get("session_id") or uuid.uuid4().hex[:12]
    count = save_buildings(fc, session_id=session_id, label=payload.get("label"), reconcile=True)
    return {"status": "ok", "session_id": session_id, "count": count}


@app.delete("/lidar/buildings/{building_id}")
def lidar_delete_building(building_id: str):
    """Delete a single building (surveyor/registrar editing)."""
    from .postgis import delete_building

    if not delete_building(building_id):
        raise HTTPException(404, f"building {building_id} not found")
    return {"status": "deleted", "building_id": building_id}


@app.get("/lidar/regions")
def lidar_region(lat: float, lon: float):
    """Reverse-geocode a scan centroid to {country, region} for the grouping UI."""
    from .regions import lookup_region

    return lookup_region(lat, lon)


@app.post("/lidar/buildings/update")
def lidar_update_building(payload: dict = Body(...)):
    """
    Upsert ONE (possibly edited) building feature without touching the rest of
    its session — used by the dashboard editor. The feature's properties must
    carry session_id (fetch_buildings includes it).
    """
    from .postgis import save_buildings

    fc = payload.get("buildings")
    feature = fc.get("features", [None])[0] if isinstance(fc, dict) else None
    props = (feature or {}).get("properties") or {}
    if not feature or not props.get("building_id"):
        raise HTTPException(400, "body must contain buildings.features[0] with building_id")
    session_id = props.get("session_id") or payload.get("session_id")
    if not session_id:
        raise HTTPException(400, "session_id missing (not in feature properties)")
    save_buildings({"type": "FeatureCollection", "features": [feature]}, session_id, reconcile=False)
    return {"status": "ok", "building_id": props.get("building_id")}


@app.post("/lidar/buildings/confirm")
def lidar_confirm_edit(payload: dict = Body(...)):
    """
    Registrar confirmation workflow: set edit_status ('confirmed' or 'pending')
    on one building and append the provided audit entry to its edit_history.
    """
    from .postgis import set_edit_status

    building_id = payload.get("building_id")
    status = payload.get("status", "confirmed")
    if not building_id:
        raise HTTPException(400, "building_id required")
    if status not in ("confirmed", "pending"):
        raise HTTPException(400, "status must be 'confirmed' or 'pending'")
    try:
        set_edit_status(building_id, status, payload.get("entry"))
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"status": "ok", "building_id": building_id, "edit_status": status}


@app.post("/lidar/buildings/clear")
def lidar_clear_buildings():
    from .postgis import clear_buildings
    clear_buildings()
    return {"status": "cleared"}


@app.get("/lidar/sessions")
def lidar_sessions():
    """All scan sessions with their live building counts."""
    from .postgis import is_available, list_sessions
    if not is_available():
        raise HTTPException(503, "PostGIS is not available")
    return list_sessions()


@app.delete("/lidar/sessions/{session_id}")
def lidar_delete_session(session_id: str):
    """Delete a scan session and all of its buildings."""
    from .postgis import delete_session, is_available
    if not is_available():
        raise HTTPException(503, "PostGIS is not available")
    delete_session(session_id)
    return {"status": "deleted", "session_id": session_id}


# ---------------- Desktop / production serving ----------------
# The Electron desktop shell spawns this backend and loads http://localhost:<port>
# directly, so the API is aliased under /api/ (the frontend's fetch base) and
# the built frontend (3d_map/frontend/dist) is served from the same origin.
# NOTE: this block must stay at the very END of the file — the SPA catch-all
# matches every GET path, so it has to be registered after all API routes.

_FRONTEND_DIST = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "frontend", "dist",
)

app.mount("/api", app)  # same-origin alias: /api/lidar/... -> /lidar/...

if os.path.isdir(_FRONTEND_DIST):
    _assets_dir = os.path.join(_FRONTEND_DIST, "assets")
    if os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """Serve the SPA (client-side routing needs index.html for every path)."""
        # never swallow API/asset paths — they must never return HTML
        if full_path == "api" or full_path.startswith(("api/", "assets/")):
            raise HTTPException(404, "not found")
        candidate = os.path.join(_FRONTEND_DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(_FRONTEND_DIST, "index.html"))


