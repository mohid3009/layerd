"""
Step-wise extraction jobs.

The LiDAR extraction pipeline runs in a background thread so the frontend can
poll GET /lidar/extract/{job_id} and show live progress. Each step moves
pending -> running -> done (or error, which fails the whole job):

  load        - reading the .laz point cloud (laspy + outlier filter)
  reproject   - CRS -> WGS84 (pyproj)
  footprints  - fetching OSM footprints (Overpass) or parsing uploaded GeoJSON
  measure     - per-footprint height extraction (points-in-polygon)
"""

import io
import json
import threading
import time
import uuid

_lock = threading.Lock()
JOBS = {}

STEP_KEYS = ("load", "reproject", "footprints", "measure")
STEP_LABELS = {
    "load": "Reading LiDAR point cloud",
    "reproject": "Reprojecting to WGS84",
    "footprints": "Fetching building footprints",
    "measure": "Measuring heights from LiDAR",
}

JOB_TTL_SECONDS = 3600


def create_job(mode):
    job_id = uuid.uuid4().hex[:12]
    labels = dict(STEP_LABELS)
    if mode == "footprints":
        labels["footprints"] = "Parsing footprint GeoJSON"
    job = {
        "job_id": job_id,
        "mode": mode,
        "steps": [
            {"key": k, "label": labels[k], "state": "pending"} for k in STEP_KEYS
        ],
        "state": "queued",  # queued | running | done | error
        "error": None,
        "result": None,
        "created": time.time(),
    }
    with _lock:
        # opportunistic cleanup of stale jobs
        now = time.time()
        for stale in [j for j in JOBS.values() if now - j["created"] > JOB_TTL_SECONDS]:
            JOBS.pop(stale["job_id"], None)
        JOBS[job_id] = job
    return job


def get_job(job_id):
    with _lock:
        return JOBS.get(job_id)


def _set_step(job, key, state):
    with _lock:
        for s in job["steps"]:
            if s["key"] == key:
                s["state"] = state
        if state == "running":
            job["state"] = "running"


def _fail(job, message):
    with _lock:
        for s in job["steps"]:
            if s["state"] == "running":
                s["state"] = "error"
        job["state"] = "error"
        job["error"] = message


def run_extraction(job, mode, laz_bytes, footprints_bytes, bbox, bbox_crs, epsg, floor_height):
    """Pipeline executed in a background thread; updates job in place."""
    from .lidar_buildings import (
        LidarExtractionError,
        bbox_to_geojson,
        extract_building_heights,
        fetch_osm_buildings,
        read_las,
        to_wgs84,
        transform_bbox_to_wgs84,
    )

    try:
        # ── step 1: read the point cloud ────────────────────────────────────
        _set_step(job, "load", "running")
        las, points = read_las(io.BytesIO(laz_bytes))
        _set_step(job, "load", "done")

        # ── step 2: reproject to WGS84 (points + bbox) ──────────────────────
        _set_step(job, "reproject", "running")
        points_wgs84, crs_desc = to_wgs84(las, points, epsg=epsg)
        query_bbox = None
        if mode == "osm":
            if bbox_crs == "laz":
                # bbox given in the .laz's projected CRS — transform to WGS84
                query_bbox = transform_bbox_to_wgs84(las, bbox, epsg=epsg)
            else:
                query_bbox = bbox
        _set_step(job, "reproject", "done")

        # ── step 3: building footprints (OSM or uploaded GeoJSON) ───────────
        _set_step(job, "footprints", "running")
        if mode == "osm":
            source_fc = fetch_osm_buildings(bbox_to_geojson(*query_bbox))
            if not source_fc["features"]:
                raise LidarExtractionError("no OSM buildings found for this area")
        else:
            source_fc = json.loads(footprints_bytes)
        _set_step(job, "footprints", "done")

        # ── step 4: measure heights ─────────────────────────────────────────
        _set_step(job, "measure", "running")
        fc, stats = extract_building_heights(source_fc, points_wgs84, floor_height)
        _set_step(job, "measure", "done")

        if mode == "osm":
            stats["osm_buildings_fetched"] = len(source_fc["features"])
            stats["query_bbox_wgs84"] = [round(v, 6) for v in query_bbox]

        with _lock:
            job["state"] = "done"
            job["result"] = {"crs": crs_desc, "stats": stats, "buildings": fc}

    except LidarExtractionError as e:
        _fail(job, str(e))
    except Exception as e:  # noqa: BLE001 — surface anything to the UI
        _fail(job, f"extraction failed: {e}")
