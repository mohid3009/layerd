"""
PostGIS persistence for generated LiDAR buildings.

Connection: the DSN is read from the POSTGRES_DSN env var, defaulting to
postgresql://postgres:postgres@localhost:5432/layerd

All geometries are stored as Polygon, SRID 4326 (the pipeline reprojects to
WGS84 before persisting). `save_buildings(fc)` upserts by building_id;
`save_buildings(fc, reconcile=True)` additionally deletes rows missing from
the payload — used when the user edits the generated set manually so the
table mirrors the working set exactly.
"""

import json
import os
from contextlib import contextmanager

import psycopg2

DSN = os.environ.get("POSTGRES_DSN", "postgresql://postgres:postgres@localhost:5432/layerd")

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS lidar_buildings (
    building_id TEXT PRIMARY KEY,
    job_id TEXT,
    name TEXT,
    height_m DOUBLE PRECISION,
    stories INTEGER,
    ground_z DOUBLE PRECISION,
    roof_z DOUBLE PRECISION,
    lidar_points INTEGER,
    height_source TEXT,
    original_height_m DOUBLE PRECISION,
    original_stories INTEGER,
    original_height_source TEXT,
    props JSONB NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(Polygon, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lidar_buildings_geom_gix
    ON lidar_buildings USING GIST (geom);
CREATE INDEX IF NOT EXISTS lidar_buildings_job_idx ON lidar_buildings (job_id);
"""


@contextmanager
def _conn():
    conn = psycopg2.connect(DSN, connect_timeout=5)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_postgis():
    """Create the extension (if present) and the lidar_buildings table."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(SCHEMA)


def is_available():
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        return True
    except Exception:
        return False


def _row_from_feature(feature, job_id):
    p = dict(feature.get("properties") or {})
    geom = feature.get("geometry")
    return {
        "building_id": p.get("building_id"),
        "job_id": job_id,
        "name": p.get("name"),
        "height_m": p.get("height_m"),
        "stories": p.get("stories"),
        "ground_z": p.get("ground_z"),
        "roof_z": p.get("roof_z"),
        "lidar_points": p.get("lidar_points"),
        "height_source": p.get("height_source"),
        "original_height_m": p.get("original_height_m"),
        "original_stories": p.get("original_stories"),
        "original_height_source": p.get("original_height_source"),
        "props": json.dumps(p),
        "geom": json.dumps(geom),
    }


UPSERT = """
INSERT INTO lidar_buildings
    (building_id, job_id, name, height_m, stories, ground_z, roof_z, lidar_points,
     height_source, original_height_m, original_stories, original_height_source,
     props, geom)
VALUES (
    %(building_id)s, %(job_id)s, %(name)s, %(height_m)s, %(stories)s, %(ground_z)s,
    %(roof_z)s, %(lidar_points)s, %(height_source)s, %(original_height_m)s,
    %(original_stories)s, %(original_height_source)s, %(props)s::jsonb,
    ST_SetSRID(ST_GeomFromGeoJSON(%(geom)s), 4326))
ON CONFLICT (building_id) DO UPDATE SET
    job_id = EXCLUDED.job_id,
    name = EXCLUDED.name,
    height_m = EXCLUDED.height_m,
    stories = EXCLUDED.stories,
    ground_z = EXCLUDED.ground_z,
    roof_z = EXCLUDED.roof_z,
    lidar_points = EXCLUDED.lidar_points,
    height_source = EXCLUDED.height_source,
    original_height_m = EXCLUDED.original_height_m,
    original_stories = EXCLUDED.original_stories,
    original_height_source = EXCLUDED.original_height_source,
    props = EXCLUDED.props,
    geom = EXCLUDED.geom,
    updated_at = now();
"""


def save_buildings(featurecollection, job_id=None, reconcile=False):
    """
    Upsert every Feature of the FeatureCollection. With reconcile=True, rows
    whose building_id is not in the payload are deleted, so the table mirrors
    the (possibly manually edited) working set.
    Returns the number of rows now in the table.
    """
    features = featurecollection.get("features", [])
    with _conn() as conn:
        with conn.cursor() as cur:
            for f in features:
                row = _row_from_feature(f, job_id)
                if not row["building_id"] or not row["geom"]:
                    continue
                cur.execute(UPSERT, row)
            if reconcile and features:
                ids = [
                    f["properties"]["building_id"]
                    for f in features
                    if f.get("properties", {}).get("building_id")
                ]
                cur.execute(
                    "DELETE FROM lidar_buildings WHERE building_id <> ALL(%s)",
                    (ids,),
                )
            cur.execute("SELECT COUNT(*) FROM lidar_buildings")
            return cur.fetchone()[0]


def fetch_buildings():
    """All saved buildings as a GeoJSON FeatureCollection (WGS84)."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT building_id, props, ST_AsGeoJSON(geom) "
                "FROM lidar_buildings ORDER BY updated_at DESC"
            )
            rows = cur.fetchall()
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": r[1],
                "geometry": json.loads(r[2]),
            }
            for r in rows
        ],
    }


def count_buildings():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM lidar_buildings")
            return cur.fetchone()[0]


def clear_buildings():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM lidar_buildings")
