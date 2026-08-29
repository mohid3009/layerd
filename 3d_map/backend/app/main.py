import json
import base64
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Body
from fastapi.middleware.cors import CORSMiddleware

from .database import get_connection, init_db
from .ulpin import make_unit_ulpin, parse_unit_ulpin
from .validation import validate_units
from .ledger import append_ledger_entry, verify_chain
from .segmentation import segment_floorplan, render_debug_overlay

app = FastAPI(title="3D ULPIN API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

VALID_ROLES = {"citizen", "surveyor", "registrar"}

# Mock demo accounts — separate login per role view.
DEMO_ACCOUNTS = {
    "citizen":   {"username": "ramesh",  "password": "citizen123", "name": "Ramesh Iyer"},
    "surveyor":  {"username": "priya",   "password": "survey123",  "name": "Priya Venkatesan"},
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


@contextmanager
def db():
    conn = get_connection()
    try:
        yield conn
    finally:
        conn.close()


def _mask_name(name: str) -> str:
    parts = name.split()
    return " ".join(p[0] + "***" for p in parts)


def _unit_view(row, role):
    d = dict(row)
    d["polygon_geojson"] = json.loads(d["polygon_geojson"])
    owner_id = d.get("owner_id")
    owner_name = None
    if owner_id:
        with db() as c:
            r = c.execute("SELECT name FROM owners WHERE owner_id = ?", (owner_id,)).fetchone()
            owner_name = r["name"] if r else None
    if role == "citizen":
        d["owner_name"] = _mask_name(owner_name) if owner_name else None
        d["owner_id"] = None
    else:
        d["owner_name"] = owner_name
    return d


@app.on_event("startup")
def startup():
    init_db()
    with db() as conn:
        if conn.execute("SELECT COUNT(*) AS n FROM parcels").fetchone()["n"] == 0:
            from .seed import seed
            seed(conn)
    try:
        from .postgis import init_postgis
        init_postgis()
        print("[startup] PostGIS ready")
    except Exception as e:  # PostGIS is optional — the app works without it
        print(f"[startup] PostGIS unavailable ({e}) — LiDAR persistence disabled")


# ---------------- Parcels ----------------

@app.get("/parcels")
def list_parcels():
    with db() as conn:
        rows = conn.execute("SELECT * FROM parcels").fetchall()
        out = []
        for r in rows:
            p = dict(r)
            p["footprint_geojson"] = json.loads(p["footprint_geojson"])
            n_units = conn.execute("SELECT COUNT(*) AS n FROM units WHERE parcel_ulpin = ?", (p["ulpin"],)).fetchone()["n"]
            p["unit_count"] = n_units
            out.append(p)
        return out


@app.get("/parcels/{ulpin}")
def get_parcel(ulpin: str, role: str = Query("citizen")):
    if role not in VALID_ROLES:
        raise HTTPException(400, f"role must be one of {sorted(VALID_ROLES)}")
    with db() as conn:
        row = conn.execute("SELECT * FROM parcels WHERE ulpin = ?", (ulpin,)).fetchone()
        if not row:
            raise HTTPException(404, f"Parcel {ulpin} not found")
        p = dict(row)
        p["footprint_geojson"] = json.loads(p["footprint_geojson"])
        unit_rows = conn.execute(
            "SELECT * FROM units WHERE parcel_ulpin = ? ORDER BY floor_index DESC, unit_ulpin", (ulpin,)
        ).fetchall()
        p["units"] = [_unit_view(u, role) for u in unit_rows]
        p["has_vertical_structure"] = len(unit_rows) > 0
        return p


@app.get("/parcels/{ulpin}/units/{unit_ulpin}")
def get_unit(ulpin: str, unit_ulpin: str, role: str = Query("citizen")):
    parsed = parse_unit_ulpin(unit_ulpin)
    if not parsed or parsed[0] != ulpin:
        raise HTTPException(400, f"{unit_ulpin} is not a valid derived ULPIN of parcel {ulpin}")
    with db() as conn:
        row = conn.execute("SELECT * FROM units WHERE unit_ulpin = ? AND parcel_ulpin = ?", (unit_ulpin, ulpin)).fetchone()
        if not row:
            raise HTTPException(404, f"Unit {unit_ulpin} not found")
        return _unit_view(row, role)


# ---------------- Segmentation & generation ----------------

@app.post("/floorplan/upload")
async def upload_floorplan(
    file: UploadFile = File(...),
    floor_index: int = Query(0),
    with_overlay: bool = Query(True),
):
    content = await file.read()
    try:
        result = segment_floorplan(content)
        if with_overlay:
            result["overlay_png_base64"] = base64.b64encode(render_debug_overlay(content)).decode()
    except ValueError as e:
        raise HTTPException(400, str(e))
    result["floor_index"] = floor_index
    return result


@app.post("/units/generate")
def generate_units(payload: dict = Body(...)):
    """
    payload: {
      parcel_ulpin, floor_index,
      polygons: [GeoJSON Polygon, ...]   (already mapped onto footprint coords),
      replace_existing: bool (default true for this floor)
      default_rights_type: owned|leased|common|air-rights
    }
    Runs topology validation; blocks generation on failure (FR16).
    """
    required = ["parcel_ulpin", "floor_index", "polygons"]
    for k in required:
        if k not in payload:
            raise HTTPException(400, f"missing field: {k}")
    parcel_ulpin = payload["parcel_ulpin"]
    floor_index = int(payload["floor_index"])
    polygons = payload["polygons"]
    rights_type = payload.get("default_rights_type", "owned")
    if rights_type not in ("owned", "leased", "common", "air-rights"):
        raise HTTPException(400, "invalid rights_type")

    with db() as conn:
        parcel = conn.execute("SELECT * FROM parcels WHERE ulpin = ?", (parcel_ulpin,)).fetchone()
        if not parcel:
            raise HTTPException(404, f"Parcel {parcel_ulpin} not found")

        # candidate units on this floor (existing + incoming) so overlap checks cover both
        existing = conn.execute(
            "SELECT unit_ulpin, floor_index, polygon_geojson FROM units WHERE parcel_ulpin = ? AND floor_index = ?",
            (parcel_ulpin, floor_index),
        ).fetchall()

        candidates = []
        for i, poly in enumerate(polygons):
            candidates.append({
                "unit_ulpin": f"CANDIDATE-{i + 1}",
                "floor_index": floor_index,
                "polygon_geojson": poly,
            })
        check_set = [
            {"unit_ulpin": e["unit_ulpin"], "floor_index": e["floor_index"], "polygon_geojson": e["polygon_geojson"]}
            for e in existing
        ] + candidates
        result = validate_units(parcel["footprint_geojson"], check_set)

        if not result["valid"]:
            return {
                "generated": False,
                "reason": "topology_validation_failed",
                **result,
            }

        created = []
        # FR17: ledger is append-only — never delete history when regenerating a floor.
        # Units with open disputes are blocked from regeneration until resolved.
        disputed = {
            r["unit_ulpin"]
            for r in conn.execute(
                "SELECT DISTINCT unit_ulpin FROM disputes WHERE status IN ('open','under_review')"
            ).fetchall()
        }
        floor_unit_ids = {
            r["unit_ulpin"]
            for r in conn.execute(
                "SELECT unit_ulpin FROM units WHERE parcel_ulpin = ? AND floor_index = ?",
                (parcel_ulpin, floor_index),
            ).fetchall()
        }
        blocked = sorted(disputed & floor_unit_ids)
        if payload.get("replace_existing", True):
            if blocked:
                conn.rollback()
                return {
                    "generated": False,
                    "reason": "open_disputes_block_regeneration",
                    "detail": f"resolve open disputes first: {', '.join(blocked)}",
                    "conflicts": [],
                }
            if floor_unit_ids:
                marks = ",".join("?" for _ in floor_unit_ids)
                conn.execute(f"DELETE FROM units WHERE unit_ulpin IN ({marks})", list(floor_unit_ids))
        for i, poly in enumerate(polygons):
            unit_ulpin = make_unit_ulpin(parcel_ulpin, floor_index, i + 1)
            xs = [pt[0] for pt in poly["coordinates"][0]]
            ys = [pt[1] for pt in poly["coordinates"][0]]
            area = abs(max(xs) - min(xs)) * 111320.0 * abs(max(ys) - min(ys)) * 110574.0
            conn.execute(
                "INSERT INTO units (unit_ulpin, parcel_ulpin, floor_index, polygon_geojson, area_sqm, rights_type, owner_id, validation_status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'valid')",
                (unit_ulpin, parcel_ulpin, floor_index, json.dumps(poly), round(area, 2), rights_type, None),
            )
            append_ledger_entry(conn, unit_ulpin, "registration", None)
            created.append(unit_ulpin)
        conn.commit()
        return {"generated": True, "unit_ulpsins": created, "conflicts": []}


# ---------------- Validation ----------------

@app.post("/units/{unit_ulpin}/validate")
def validate_unit(unit_ulpin: str):
    parsed = parse_unit_ulpin(unit_ulpin)
    if not parsed:
        raise HTTPException(400, "malformed unit ULPIN")
    parcel_ulpin = parsed[0]
    with db() as conn:
        parcel = conn.execute("SELECT * FROM parcels WHERE ulpin = ?", (parcel_ulpin,)).fetchone()
        if not parcel:
            raise HTTPException(404, f"Parcel {parcel_ulpin} not found")
        rows = conn.execute(
            "SELECT unit_ulpin, floor_index, polygon_geojson FROM units WHERE parcel_ulpin = ?",
            (parcel_ulpin,),
        ).fetchall()
        result = validate_units(parcel["footprint_geojson"], [dict(r) for r in rows])
        # update statuses (FR15/FR16)
        conflicted_ids = set()
        for c in result["conflicts"]:
            conflicted_ids.update(c.get("units", []))
        for r in rows:
            new_status = "conflict" if r["unit_ulpin"] in conflicted_ids else "valid"
            conn.execute("UPDATE units SET validation_status = ? WHERE unit_ulpin = ?", (new_status, r["unit_ulpin"]))
        conn.commit()
        result["parcel_ulpin"] = parcel_ulpin
        result["checked_units"] = len(rows)
        return result


# ---------------- Ledger ----------------

@app.get("/units/{unit_ulpin}/ledger")
def get_ledger(unit_ulpin: str):
    parsed = parse_unit_ulpin(unit_ulpin)
    if not parsed:
        raise HTTPException(400, "malformed unit ULPIN")
    with db() as conn:
        if not conn.execute("SELECT 1 FROM units WHERE unit_ulpin = ?", (unit_ulpin,)).fetchone():
            raise HTTPException(404, f"Unit {unit_ulpin} not found")
        rows = conn.execute(
            "SELECT l.*, o.name AS owner_name FROM ownership_ledger l "
            "LEFT JOIN owners o ON o.owner_id = l.owner_id "
            "WHERE l.unit_ulpin = ? ORDER BY l.entry_id ASC",
            (unit_ulpin,),
        ).fetchall()
        chain_status = verify_chain(conn, unit_ulpin)
        return {"unit_ulpin": unit_ulpin, "chain_intact": chain_status["intact"], "entries": [dict(r) for r in rows]}


@app.post("/ledger/tamper-test/{unit_ulpin}")
def tamper_test(unit_ulpin: str):
    """Demo helper: corrupts the latest entry's owner to show FR18 tamper detection."""
    with db() as conn:
        row = conn.execute(
            "SELECT entry_id FROM ownership_ledger WHERE unit_ulpin = ? ORDER BY entry_id DESC LIMIT 1",
            (unit_ulpin,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "No ledger entries for this unit")
        conn.execute(
            "INSERT OR REPLACE INTO owners (owner_id, name, contact_info) VALUES ('OWN-HACKER', 'Tampered Entry', 'attacker@evil.test')"
        )
        conn.execute("UPDATE ownership_ledger SET owner_id = 'OWN-HACKER' WHERE entry_id = ?", (row["entry_id"],))
        conn.commit()
        status = verify_chain(conn, unit_ulpin)
    return {"tampered": True, **status}


# ---------------- Disputes ----------------

@app.post("/disputes")
def create_dispute(payload: dict = Body(...)):
    for k in ("unit_ulpin", "description"):
        if k not in payload:
            raise HTTPException(400, f"missing field: {k}")
    submitted_by = payload.get("submitted_by") or "CITIZEN-GUEST"
    with db() as conn:
        if not conn.execute("SELECT 1 FROM units WHERE unit_ulpin = ?", (payload["unit_ulpin"],)).fetchone():
            raise HTTPException(404, f"Unit {payload['unit_ulpin']} not found")
        cur = conn.execute(
            "INSERT INTO disputes (unit_ulpin, submitted_by, description, attachment_url, status) VALUES (?, ?, ?, ?, 'open')",
            (payload["unit_ulpin"], submitted_by, payload["description"], payload.get("attachment_url")),
        )
        conn.commit()
        dispute_id = cur.lastrowid
        row = conn.execute("SELECT * FROM disputes WHERE dispute_id = ?", (dispute_id,)).fetchone()
        return dict(row)


@app.get("/disputes")
def list_disputes(status: str = Query(None)):
    with db() as conn:
        if status:
            rows = conn.execute("SELECT * FROM disputes WHERE status = ? ORDER BY dispute_id DESC", (status,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM disputes ORDER BY dispute_id DESC").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            unit = conn.execute("SELECT parcel_ulpin, floor_index FROM units WHERE unit_ulpin = ?", (d["unit_ulpin"],)).fetchone()
            if unit:
                d["parcel_ulpin"] = unit["parcel_ulpin"]
                d["floor_index"] = unit["floor_index"]
            out.append(d)
        return out


@app.post("/disputes/{dispute_id}/review")
def mark_under_review(dispute_id: int):
    """Mark a dispute as under_review (Registrar acknowledges it)."""
    with db() as conn:
        row = conn.execute("SELECT * FROM disputes WHERE dispute_id = ?", (dispute_id,)).fetchone()
        if not row:
            raise HTTPException(404, f"Dispute {dispute_id} not found")
        if row["status"] not in ("open",):
            raise HTTPException(409, f"Dispute is already in status '{row['status']}'")
        conn.execute("UPDATE disputes SET status = 'under_review' WHERE dispute_id = ?", (dispute_id,))
        conn.commit()
        updated = dict(conn.execute("SELECT * FROM disputes WHERE dispute_id = ?", (dispute_id,)).fetchone())
        return updated


@app.post("/disputes/{dispute_id}/resolve")
def resolve_dispute(dispute_id: int, payload: dict = Body(...)):
    action = payload.get("action")
    reason = payload.get("reason")
    if action not in ("approve", "reject"):
        raise HTTPException(400, "action must be approve or reject")
    if not reason or not str(reason).strip():
        raise HTTPException(400, "reason is mandatory")  # FR22
    with db() as conn:
        row = conn.execute("SELECT * FROM disputes WHERE dispute_id = ?", (dispute_id,)).fetchone()
        if not row:
            raise HTTPException(404, f"Dispute {dispute_id} not found")
        if row["status"] in ("resolved", "rejected"):
            raise HTTPException(409, "Dispute already closed")
        new_status = "resolved" if action == "approve" else "rejected"
        conn.execute(
            "UPDATE disputes SET status = ?, resolution_reason = ? WHERE dispute_id = ?",
            (new_status, reason, dispute_id),
        )
        ledger_hash = None
        if action == "approve":  # FR23
            ledger_hash = append_ledger_entry(conn, row["unit_ulpin"], "dispute_resolution", None)
        conn.commit()
        updated = dict(conn.execute("SELECT * FROM disputes WHERE dispute_id = ?", (dispute_id,)).fetchone())
        return {"dispute": updated, "ledger_entry_hash": ledger_hash}


# ---------------- LiDAR building extraction ----------------

@app.post("/lidar/buildings")
async def extract_lidar_buildings(
    laz: UploadFile = File(...),
    footprints: UploadFile = File(...),
    epsg: int | None = Form(None),
    floor_height: float = Form(3.0),
):
    """
    Measure building heights from a LiDAR .laz file (with embedded CRS) above
    each footprint polygon in a GeoJSON, and return a FeatureCollection whose
    features carry height_m / stories. Footprints with no LiDAR points above
    them are assumed to be 1-storey buildings.
    """
    from .lidar_buildings import (
        LidarExtractionError,
        extract_building_heights,
        load_laz_points,
    )

    if floor_height <= 0:
        raise HTTPException(400, "floor_height must be positive")

    geojson_bytes = await footprints.read()
    try:
        import json as _json
        geojson = _json.loads(geojson_bytes)
    except Exception:
        raise HTTPException(400, "footprints upload is not valid JSON/GeoJSON")

    try:
        points_wgs84, crs_desc = load_laz_points(laz.file, epsg=epsg)
        fc, stats = extract_building_heights(
            geojson, points_wgs84, floor_height=float(floor_height)
        )
    except LidarExtractionError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"LiDAR extraction failed: {e}")

    return {
        "crs": crs_desc,
        "stats": stats,
        "buildings": fc,
    }


# ---------------- LiDAR + OSM building extraction ----------------

@app.post("/lidar/osm")
def extract_lidar_osm_buildings(
    laz: UploadFile = File(...),
    xmin: float = Form(...),
    ymin: float = Form(...),
    xmax: float = Form(...),
    ymax: float = Form(...),
    epsg: int | None = Form(None),
    floor_height: float = Form(3.0),
):
    """
    Given a WGS84 bounding box (xmin, ymin, xmax, ymax): fetch all building
    footprints from OSM for that region, measure each footprint's height from
    the LiDAR points above it, and extrude. Footprints with no LiDAR points
    above them (or outside the cloud's coverage) are assumed to be 1-storey
    buildings.
    """
    from .lidar_buildings import (
        LidarExtractionError,
        extract_building_heights,
        fetch_osm_buildings,
        load_laz_points,
    )

    if floor_height <= 0:
        raise HTTPException(400, "floor_height must be positive")
    if xmin >= xmax or ymin >= ymax:
        raise HTTPException(400, "invalid bbox: need xmin < xmax and ymin < ymax")

    bbox_fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "area-of-interest"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax], [xmin, ymin],
                    ]],
                },
            }
        ],
    }

    try:
        points_wgs84, crs_desc = load_laz_points(laz.file, epsg=epsg)
        osm_fc = fetch_osm_buildings(bbox_fc)
        if not osm_fc["features"]:
            raise HTTPException(404, "no OSM buildings found for this area")
        fc, stats = extract_building_heights(
            osm_fc, points_wgs84, floor_height=float(floor_height)
        )
    except LidarExtractionError as e:
        raise HTTPException(400, str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"LiDAR/OSM extraction failed: {e}")

    stats["osm_buildings_fetched"] = len(osm_fc["features"])
    return {"crs": crs_desc, "stats": stats, "buildings": fc}


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
                "WGS84 lon/lat — set 'bbox coordinates' to 'same as .laz CRS'",
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


# ---------------- Mock NGDRS handoff ----------------

@app.post("/registry/publish/{parcel_ulpin}")
def publish_to_ngdrs(parcel_ulpin: str):
    with db() as conn:
        parcel = conn.execute("SELECT * FROM parcels WHERE ulpin = ?", (parcel_ulpin,)).fetchone()
        if not parcel:
            raise HTTPException(404, f"Parcel {parcel_ulpin} not found")
        units = conn.execute("SELECT * FROM units WHERE parcel_ulpin = ?", (parcel_ulpin,)).fetchall()
        payload = {
            "target_system": "NGDRS",
            "mode": "MOCK — no real integration",
            "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
            "source_system": "3D-ULPIN-Demo",
            "parcel": {
                "ulpin": parcel["ulpin"],
                "state": parcel["state"],
                "district": parcel["district"],
                "footprint_geojson": json.loads(parcel["footprint_geojson"]),
            },
            "vertical_units": [
                {
                    "unit_ulpin": u["unit_ulpin"],
                    "floor_index": u["floor_index"],
                    "area_sqm": u["area_sqm"],
                    "rights_type": u["rights_type"],
                    "owner_id": u["owner_id"],
                    "validation_status": u["validation_status"],
                }
                for u in units
            ],
            "checksum_sha256": None,
        }
        import hashlib
        blob = json.dumps(payload, sort_keys=True).encode()
        payload["checksum_sha256"] = hashlib.sha256(blob).hexdigest()
        return {
            "status": "accepted (mock)",
            "endpoint_would_be": "https://ngdrs.gov.in/api/v2/records",
            "payload": payload,
        }
