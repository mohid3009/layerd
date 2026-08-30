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

STEP_KEYS = ("load", "reproject", "footprints", "measure", "save")
STEP_LABELS = {
    "load": "Reading LiDAR point cloud",
    "reproject": "Reprojecting to WGS84",
    "footprints": "Fetching building footprints",
    "measure": "Measuring heights from LiDAR",
    "save": "Saving to PostGIS",
}
# steps for the no-LiDAR path (footprints only, heights from attributes)
NO_LIDAR_KEYS = ("footprints", "measure", "save")
NO_LIDAR_LABELS = {
    "footprints": "Fetching building footprints",
    "measure": "Deriving heights from attributes",
    "save": "Saving to PostGIS",
}

JOB_TTL_SECONDS = 3600


def create_job(mode, has_lidar=True):
    job_id = uuid.uuid4().hex[:12]
    if has_lidar:
        labels = dict(STEP_LABELS)
        keys = STEP_KEYS
    else:
        labels = dict(NO_LIDAR_LABELS)
        keys = NO_LIDAR_KEYS
    if mode == "footprints":
        labels["footprints"] = "Parsing footprint GeoJSON"
    job = {
        "job_id": job_id,
        "mode": mode,
        "lidar": has_lidar,
        "steps": [
            {"key": k, "label": labels[k], "state": "pending"} for k in keys
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


def _set_step(job, key, state, note=None):
    with _lock:
        for s in job["steps"]:
            if s["key"] == key:
                s["state"] = state
                if note is not None:
                    s["note"] = note
        if state == "running":
            job["state"] = "running"


def _fail(job, message):
    with _lock:
        for s in job["steps"]:
            if s["state"] == "running":
                s["state"] = "error"
        job["state"] = "error"
        job["error"] = message


def run_extraction(
    job, mode, laz_bytes, footprints_bytes, bbox, bbox_crs, footprints_crs, epsg, floor_height
):
    """Pipeline executed in a background thread; updates job in place."""
    from .lidar_buildings import (
        LidarExtractionError,
        bbox_to_geojson,
        extract_building_heights,
        fetch_osm_buildings,
        heights_from_attributes,
        read_las,
        to_wgs84,
        transform_bbox_to_wgs84,
        transform_geojson_to_wgs84,
    )

    has_lidar = bool(laz_bytes)
    try:
        points_wgs84 = None
        crs_desc = "EPSG:4326 (WGS84)"
        query_bbox = None

        if has_lidar:
            # ── step 1: read the point cloud ────────────────────────────────
            _set_step(job, "load", "running")
            las, points = read_las(io.BytesIO(laz_bytes))
            _set_step(job, "load", "done")

            # ── step 2: reproject to WGS84 (points + bbox) ──────────────────
            _set_step(job, "reproject", "running")
            points_wgs84, crs_desc = to_wgs84(las, points, epsg=epsg)
            if mode == "osm":
                if bbox_crs == "laz":
                    # bbox given in the .laz's projected CRS — transform to WGS84
                    query_bbox = transform_bbox_to_wgs84(las, bbox, epsg=epsg)
                else:
                    query_bbox = bbox
            _set_step(job, "reproject", "done")
        elif mode == "osm":
            query_bbox = bbox  # no LiDAR → bbox must already be WGS84

        # ── step 3: building footprints (OSM or uploaded GeoJSON) ───────────
        _set_step(job, "footprints", "running")
        if mode == "osm":
            def tile_progress(done, total):
                _set_step(job, "footprints", "running", note=f"{done}/{total} Overpass tiles")

            source_fc = fetch_osm_buildings(bbox_to_geojson(*query_bbox), progress=tile_progress)
            if not source_fc["features"]:
                raise LidarExtractionError("no OSM buildings found for this area")
        else:
            source_fc = json.loads(footprints_bytes)
            if footprints_crs == "laz":
                # GIS parcels exported in the .laz's projected CRS/units —
                # reproject every vertex to WGS84 so the footprints line up
                # with the (reprojected) point cloud.
                if not has_lidar:
                    raise LidarExtractionError(
                        "footprint coordinates set to 'same as .laz CRS' "
                        "but no .laz was uploaded — there is no CRS to borrow"
                    )
                _set_step(job, "footprints", "running", note="reprojecting to WGS84")
                source_fc = transform_geojson_to_wgs84(source_fc, las, epsg=epsg)
        _set_step(job, "footprints", "done")

        # ── step 4: measure heights ─────────────────────────────────────────
        _set_step(job, "measure", "running")
        if has_lidar:
            fc, stats = extract_building_heights(source_fc, points_wgs84, floor_height)
        else:
            fc, stats = heights_from_attributes(source_fc, floor_height)
        _set_step(job, "measure", "done")

        if mode == "osm":
            stats["osm_buildings_fetched"] = len(source_fc["features"])
            stats["query_bbox_wgs84"] = [round(v, 6) for v in query_bbox]
        else:
            stats["footprints_crs"] = (
                ".laz CRS → WGS84" if footprints_crs == "laz" and has_lidar else "WGS84"
            )

        # ── step 5: persist to PostGIS as a scan session (non-fatal) ────────
        _set_step(job, "save", "running")
        postgis_warning = None
        try:
            from .postgis import save_buildings

            if mode == "osm":
                label = f"OSM scan @ {query_bbox[0]:.3f}, {query_bbox[1]:.3f}"
            else:
                label = "GeoJSON import"
                if footprints_crs == "laz" and has_lidar:
                    label += " (.laz CRS)"
            if not has_lidar:
                label += " (no LiDAR)"
            stats["postgis_saved"] = save_buildings(
                fc,
                session_id=job["job_id"],
                label=label,
                mode=mode,
                crs=crs_desc,
                reconcile=True,
            )
        except Exception as e:  # noqa: BLE001 — degrade gracefully, keep result
            _set_step(job, "save", "error")
            postgis_warning = f"PostGIS save failed: {e}"
        else:
            _set_step(job, "save", "done")
        if postgis_warning:
            stats["postgis_warning"] = postgis_warning

        with _lock:
            job["state"] = "done"
            job["result"] = {
                "crs": crs_desc,
                "stats": stats,
                "buildings": fc,
                "session_id": job["job_id"],
            }

    except LidarExtractionError as e:
        _fail(job, str(e))
    except Exception as e:  # noqa: BLE001 — surface anything to the UI
        _fail(job, f"extraction failed: {e}")
