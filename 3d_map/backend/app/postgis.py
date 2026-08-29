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
import psycopg2.extras

DSN = os.environ.get("POSTGRES_DSN", "postgresql://postgres:postgres@localhost:5432/layerd")

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS lidar_buildings (
    building_id TEXT PRIMARY KEY,
    session_id TEXT,
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

-- one row per extraction run; buildings reference their scan session
CREATE TABLE IF NOT EXISTS lidar_sessions (
    session_id TEXT PRIMARY KEY,
    label TEXT,
    mode TEXT,
    crs TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE lidar_buildings ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS lidar_buildings_session_idx ON lidar_buildings (session_id);
UPDATE lidar_buildings SET session_id = COALESCE(job_id, 'legacy')
WHERE session_id IS NULL;
INSERT INTO lidar_sessions (session_id, label)
SELECT DISTINCT session_id, 'Imported scan'
FROM lidar_buildings WHERE session_id IS NOT NULL
ON CONFLICT (session_id) DO NOTHING;
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


def _row_from_feature(feature, session_id):
    p = dict(feature.get("properties") or {})
    geom = feature.get("geometry")
    return {
        "building_id": p.get("building_id"),
        "session_id": session_id,
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
    (building_id, session_id, name, height_m, stories, ground_z, roof_z, lidar_points,
     height_source, original_height_m, original_stories, original_height_source,
     props, geom)
VALUES (
    %(building_id)s, %(session_id)s, %(name)s, %(height_m)s, %(stories)s, %(ground_z)s,
    %(roof_z)s, %(lidar_points)s, %(height_source)s, %(original_height_m)s,
    %(original_stories)s, %(original_height_source)s, %(props)s::jsonb,
    ST_SetSRID(ST_GeomFromGeoJSON(%(geom)s), 4326))
ON CONFLICT (building_id) DO UPDATE SET
    session_id = EXCLUDED.session_id,
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


def save_session(session_id, label=None, mode=None, crs=None):
    """Register/refresh a scan session row."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO lidar_sessions (session_id, label, mode, crs)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (session_id) DO UPDATE SET
                    label = COALESCE(EXCLUDED.label, lidar_sessions.label),
                    mode = COALESCE(EXCLUDED.mode, lidar_sessions.mode),
                    crs = COALESCE(EXCLUDED.crs, lidar_sessions.crs)
                """,
                (session_id, label, mode, crs),
            )


def save_buildings(featurecollection, session_id, label=None, mode=None, crs=None, reconcile=True):
    """
    Upsert every Feature of the FeatureCollection into the given scan session.
    With reconcile=True, rows belonging to THIS session that are missing from
    the payload are deleted (e.g. buildings removed while editing) — other
    sessions are never touched.
    Returns the number of buildings now in the session.
    """
    if not session_id:
        raise ValueError("session_id is required")
    features = featurecollection.get("features", [])
    save_session(session_id, label=label, mode=mode, crs=crs)
    with _conn() as conn:
        with conn.cursor() as cur:
            rows = [
                _row_from_feature(f, session_id)
                for f in features
                if f.get("properties", {}).get("building_id") and f.get("geometry")
            ]
            if rows:
                psycopg2.extras.execute_batch(cur, UPSERT, rows, page_size=1000)
            if reconcile and rows:
                ids = [
                    f["properties"]["building_id"]
                    for f in features
                    if f.get("properties", {}).get("building_id")
                ]
                cur.execute(
                    "DELETE FROM lidar_buildings "
                    "WHERE session_id = %s AND building_id <> ALL(%s)",
                    (session_id, ids),
                )
            cur.execute(
                "SELECT COUNT(*) FROM lidar_buildings WHERE session_id = %s",
                (session_id,),
            )
            return cur.fetchone()[0]


def fetch_buildings(session_id=None):
    """Saved buildings as a GeoJSON FeatureCollection (WGS84), all sessions or one."""
    with _conn() as conn:
        with conn.cursor() as cur:
            if session_id:
                cur.execute(
                    "SELECT building_id, session_id, props, ST_AsGeoJSON(geom) "
                    "FROM lidar_buildings WHERE session_id = %s "
                    "ORDER BY updated_at DESC",
                    (session_id,),
                )
            else:
                cur.execute(
                    "SELECT building_id, session_id, props, ST_AsGeoJSON(geom) "
                    "FROM lidar_buildings ORDER BY updated_at DESC"
                )
            rows = cur.fetchall()
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {**r[2], "session_id": r[1]},
                "geometry": json.loads(r[3]),
            }
            for r in rows
        ],
    }


def list_sessions():
    """All scan sessions with live building counts, newest first."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT s.session_id, s.label, s.mode, s.crs, s.created_at,
                       COUNT(b.building_id) AS buildings
                FROM lidar_sessions s
                LEFT JOIN lidar_buildings b ON b.session_id = s.session_id
                GROUP BY s.session_id, s.label, s.mode, s.crs, s.created_at
                ORDER BY s.created_at DESC
                """
            )
            rows = cur.fetchall()
    return [
        {
            "session_id": r[0],
            "label": r[1],
            "mode": r[2],
            "crs": r[3],
            "created_at": r[4].isoformat() if r[4] else None,
            "buildings": r[5],
        }
        for r in rows
    ]


def delete_session(session_id):
    """Remove a scan session and all of its buildings."""
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM lidar_buildings WHERE session_id = %s", (session_id,))
            cur.execute("DELETE FROM lidar_sessions WHERE session_id = %s", (session_id,))


def count_buildings():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM lidar_buildings")
            return cur.fetchone()[0]


def clear_buildings():
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM lidar_buildings")
