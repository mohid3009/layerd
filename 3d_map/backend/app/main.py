import json

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Body
from fastapi.middleware.cors import CORSMiddleware

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
    laz: UploadFile = File(...),
    mode: str = Form("osm"),
    footprints: UploadFile | None = File(None),
    xmin: float | None = Form(None),
    ymin: float | None = Form(None),
    xmax: float | None = Form(None),
    ymax: float | None = Form(None),
    bbox_crs: str = Form("laz"),  # 'laz' = bbox in the .laz's native CRS
    epsg: int | None = Form(None),
    floor_height: float = Form(3.0),
):
    """
    Start a LiDAR extraction job and return its id immediately. Poll
    GET /lidar/extract/{job_id} for step-wise progress and the final result.
    mode: 'osm' (footprints fetched for the xmin/ymin/xmax/ymax bbox) or
    'footprints' (footprints uploaded as a GeoJSON file).
    """
    import threading

    from .extract_jobs import create_job, run_extraction

    if mode not in ("osm", "footprints"):
        raise HTTPException(400, "mode must be 'osm' or 'footprints'")
    if floor_height <= 0:
        raise HTTPException(400, "floor_height must be positive")

    if mode == "osm":
        if None in (xmin, ymin, xmax, ymax):
            raise HTTPException(400, "bbox required: xmin, ymin, xmax, ymax")
        if xmin >= xmax or ymin >= ymax:
            raise HTTPException(400, "invalid bbox: need xmin < xmax and ymin < ymax")
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
        bbox = None

    laz_bytes = await laz.read()
    footprints_bytes = await footprints.read() if footprints else None

    job = create_job(mode)
    thread = threading.Thread(
        target=run_extraction,
        args=(job, mode, laz_bytes, footprints_bytes, bbox, bbox_crs, epsg, float(floor_height)),
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


# ---------------- PostGIS persistence (saved buildings) ----------------

@app.get("/lidar/buildings/status")
def lidar_saved_status():
    from .postgis import count_buildings, is_available
    if not is_available():
        return {"available": False, "count": 0}
    return {"available": True, "count": count_buildings()}


@app.get("/lidar/buildings")
def lidar_saved_buildings():
    """All saved buildings as GeoJSON straight from PostGIS."""
    from .postgis import fetch_buildings, is_available
    if not is_available():
        raise HTTPException(503, "PostGIS is not available")
    return fetch_buildings()


@app.post("/lidar/buildings/sync")
def lidar_sync_buildings(payload: dict = Body(...)):
    """
    Persist the (possibly manually edited) working set: upserts every feature
    and deletes rows missing from the payload, so PostGIS mirrors the editor.
    """
    from .postgis import save_buildings
    fc = payload.get("buildings")
    if not isinstance(fc, dict) or fc.get("type") != "FeatureCollection":
        raise HTTPException(400, "body must contain a FeatureCollection under 'buildings'")
    count = save_buildings(fc, job_id=payload.get("job_id"), reconcile=True)
    return {"status": "ok", "count": count}


@app.post("/lidar/buildings/clear")
def lidar_clear_buildings():
    from .postgis import clear_buildings
    clear_buildings()
    return {"status": "cleared"}


