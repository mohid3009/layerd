import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ulpin.db")


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS parcels (
    ulpin TEXT PRIMARY KEY,
    footprint_geojson TEXT NOT NULL,
    state TEXT NOT NULL,
    district TEXT NOT NULL,
    floor_count INTEGER NOT NULL,
    basement_count INTEGER NOT NULL,
    floor_height_m REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS owners (
    owner_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact_info TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
    unit_ulpin TEXT PRIMARY KEY,
    parcel_ulpin TEXT NOT NULL REFERENCES parcels(ulpin),
    floor_index INTEGER NOT NULL,
    polygon_geojson TEXT NOT NULL,
    area_sqm REAL NOT NULL,
    rights_type TEXT NOT NULL CHECK (rights_type IN ('owned','leased','common','air-rights')),
    owner_id TEXT REFERENCES owners(owner_id),
    validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('valid','conflict','pending'))
);

CREATE TABLE IF NOT EXISTS ownership_ledger (
    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_ulpin TEXT NOT NULL REFERENCES units(unit_ulpin),
    event_type TEXT NOT NULL CHECK (event_type IN ('registration','transfer','dispute_resolution','correction')),
    owner_id TEXT REFERENCES owners(owner_id),
    timestamp TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
    dispute_id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_ulpin TEXT NOT NULL REFERENCES units(unit_ulpin),
    submitted_by TEXT NOT NULL,
    description TEXT NOT NULL,
    attachment_url TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','resolved','rejected')),
    resolution_reason TEXT
);
"""


def init_db():
    conn = get_connection()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
