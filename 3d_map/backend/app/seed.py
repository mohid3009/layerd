import hashlib
import json
import os
import sys

# Support both `python seed.py` (standalone) and import via main.py (module)
if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from database import get_connection, init_db
    from ulpin import make_unit_ulpin
    from ledger import append_ledger_entry
else:
    from .database import get_connection, init_db
    from .ulpin import make_unit_ulpin
    from .ledger import append_ledger_entry

# Parcel A: main worked example — Sarraswathi Apartments, Adyar, Chennai
# (real OSM Way 376515485, building=apartments, building:levels=4)
PARCEL_A = {
    "ulpin": "TN-02-6001-2345-6789",
    "state": "Tamil Nadu",
    "district": "Chennai",
    "floor_count": 4,        # G + 3 (per OSM building:levels=4)
    "basement_count": 1,
    "floor_height_m": 3.0,
    "footprint_geojson": {
        "type": "Polygon",
        "coordinates": [[
            [80.2528930, 13.0085692],
            [80.2528894, 13.0082434],
            [80.2530396, 13.0082419],
            [80.2530431, 13.0085677],
            [80.2528930, 13.0085692]
        ]],
    },
}

# Parcel B: simpler backup — real 2-storey house, Adyar, Chennai (OSM Way 628691058)
PARCEL_B = {
    "ulpin": "TN-02-6002-3456-7890",
    "state": "Tamil Nadu",
    "district": "Chennai",
    "floor_count": 2,
    "basement_count": 0,
    "floor_height_m": 3.2,
    "footprint_geojson": {
        "type": "Polygon",
        "coordinates": [[
            [80.2501780, 13.0037477],
            [80.2501798, 13.0036005],
            [80.2502686, 13.0036074],
            [80.2502669, 13.0037555],
            [80.2501780, 13.0037477]
        ]],
    },
}

# Parcel C: conflict demo — neighbouring house, Adyar, Chennai (OSM Way 628691059)
# Real building has 2 levels; modeled with 3 so the Floor-1 overlap demo works
# (two OVERLAPPING units on Floor 1).
PARCEL_C = {
    "ulpin": "TN-02-6003-4567-8901",
    "state": "Tamil Nadu",
    "district": "Chennai",
    "floor_count": 3,
    "basement_count": 0,
    "floor_height_m": 3.0,
    "footprint_geojson": {
        "type": "Polygon",
        "coordinates": [[
            [80.2501337, 13.0039190],
            [80.2501435, 13.0037554],
            [80.2502981, 13.0037632],
            [80.2502884, 13.0039260],
            [80.2501337, 13.0039190]
        ]],
    },
}

OWNERS = [
    {"owner_id": "OWN-001", "name": "M. Ramesh Iyer", "contact_info": "+91-98xxxxxx01"},
    {"owner_id": "OWN-002", "name": "Priya Venkatesan", "contact_info": "+91-98xxxxxx02"},
    {"owner_id": "OWN-003", "name": "S. Kamala Lakshmi", "contact_info": "+91-98xxxxxx03"},
    {"owner_id": "OWN-004", "name": "A. Mohamed Rafiq", "contact_info": "+91-98xxxxxx04"},
]


def _rect(x0, y0, x1, y1):
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def _grid_split(footprint_coords, cols, rows, inset=0.08):
    """Split a rectangular footprint into cols x rows rectangles with a small gutter."""
    xs = [c[0] for c in footprint_coords]
    ys = [c[1] for c in footprint_coords]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    dx = (x_max - x_min) / cols
    dy = (y_max - y_min) / rows
    ix = dx * inset
    iy = dy * inset
    polys = []
    for r in range(rows):
        for c in range(cols):
            polys.append(_rect(
                x_min + c * dx + ix, y_min + r * dy + iy,
                x_min + (c + 1) * dx - ix, y_min + (r + 1) * dy - iy,
            ))
    return polys


def _area_sqm(poly_geojson):
    coords = poly_geojson["coordinates"][0]
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return abs((max(xs) - min(xs)) * 111320.0) * abs((max(ys) - min(ys)) * 110574.0)


def _insert_unit(conn, base_ulpin, floor_index, unit_num, polygon, rights_type, owner_id, status="valid"):
    unit_ulpin = make_unit_ulpin(base_ulpin, floor_index, unit_num)
    area = round(_area_sqm(polygon), 2)
    conn.execute(
        "INSERT OR REPLACE INTO units (unit_ulpin, parcel_ulpin, floor_index, polygon_geojson, "
        "area_sqm, rights_type, owner_id, validation_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (unit_ulpin, base_ulpin, floor_index, json.dumps(polygon), area, rights_type, owner_id, status),
    )
    if owner_id and status == "valid":
        append_ledger_entry(conn, unit_ulpin, "registration", owner_id)
    return unit_ulpin


def _bulk_ulpin(osm_id: int) -> str:
    """Deterministic, plausible-looking base ULPIN derived from the OSM way id."""
    h = hashlib.sha256(f"TN02-CHENNAI-{osm_id}".encode()).digest()
    a, b, c = (int.from_bytes(h[i:i + 2], "big") % 9000 + 1000 for i in (0, 2, 4))
    return f"TN-02-{a}-{b}-{c}"


def seed_neighbourhood(conn):
    """Bulk-seed real OSM buildings around the featured Adyar parcels so the
    3D map shows a populated neighbourhood. Footprints/levels are real; the
    vertical unit splits are synthetic demo data."""
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chennai_buildings.json")
    if not os.path.exists(src):
        print("chennai_buildings.json missing; skipping neighbourhood seed")
        return 0
    with open(src) as f:
        buildings = json.load(f)

    featured_ways = {376515485, 628691058, 628691059}
    used_ulpins = {PARCEL_A["ulpin"], PARCEL_B["ulpin"], PARCEL_C["ulpin"]}
    count = 0
    for b in buildings:
        if b["osm_id"] in featured_ways:
            continue
        ulpin = _bulk_ulpin(b["osm_id"])
        if ulpin in used_ulpins:  # astronomically unlikely, but stay safe
            continue
        used_ulpins.add(ulpin)

        floors = b["levels"]
        is_house = b["building"] == "house"
        parcel = {
            "ulpin": ulpin,
            "state": "Tamil Nadu",
            "district": "Chennai",
            "floor_count": floors,
            "basement_count": 1 if (floors >= 4 and b["area_m2"] > 140) else 0,
            "floor_height_m": 3.2 if is_house else 3.0,
            "footprint_geojson": {"type": "Polygon", "coordinates": [b["coords"]]},
        }
        conn.execute(
            "INSERT OR REPLACE INTO parcels (ulpin, footprint_geojson, state, district, floor_count, basement_count, floor_height_m) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (parcel["ulpin"], json.dumps(parcel["footprint_geojson"]), parcel["state"], parcel["district"],
             parcel["floor_count"], parcel["basement_count"], parcel["floor_height_m"]),
        )

        fp = b["coords"]
        area = b["area_m2"]
        if area > 200:
            cells = _grid_split(fp, 2, 2)
        elif area > 90:
            cells = _grid_split(fp, 2, 1)
        else:
            cells = [_rect(*_bbox(fp))]

        if parcel["basement_count"]:
            _insert_unit(conn, ulpin, -1, 1, _rect(*_bbox(fp)), "common", None)
        for floor in range(floors):
            is_top = floor == floors - 1
            for i, poly in enumerate(cells):
                if is_top and floors >= 4:
                    # top floor of taller buildings: leased / air-rights variety
                    rights = "leased" if i % 2 == 0 else "air-rights"
                    owner = OWNERS[i % len(OWNERS)]["owner_id"] if rights == "leased" else None
                else:
                    rights = "owned"
                    owner = OWNERS[(floor + i) % len(OWNERS)]["owner_id"]
                _insert_unit(conn, ulpin, floor, i + 1, poly, rights, owner)
        count += 1
    return count


def seed(conn):
    fp_a = PARCEL_A["footprint_geojson"]["coordinates"][0]
    fp_b = PARCEL_B["footprint_geojson"]["coordinates"][0]
    fp_c = PARCEL_C["footprint_geojson"]["coordinates"][0]

    for p in (PARCEL_A, PARCEL_B, PARCEL_C):
        conn.execute(
            "INSERT OR REPLACE INTO parcels (ulpin, footprint_geojson, state, district, floor_count, basement_count, floor_height_m) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (p["ulpin"], json.dumps(p["footprint_geojson"]), p["state"], p["district"],
             p["floor_count"], p["basement_count"], p["floor_height_m"]),
        )

    for o in OWNERS:
        conn.execute(
            "INSERT OR REPLACE INTO owners (owner_id, name, contact_info) VALUES (?, ?, ?)",
            (o["owner_id"], o["name"], o["contact_info"]),
        )

    # ---- Parcel A: Sarraswathi Apartments tower ----
    # Basement: single common parking level
    _insert_unit(conn, PARCEL_A["ulpin"], -1, 1, _rect(*_bbox(fp_a)), "common", None)
    # Ground to second-from-top floor: 4 owned units per floor, rotating owners
    quads = _grid_split(fp_a, 2, 2)
    for floor in range(0, PARCEL_A["floor_count"] - 1):
        for i, poly in enumerate(quads):
            owner = OWNERS[(floor + i) % len(OWNERS)]["owner_id"]
            _insert_unit(conn, PARCEL_A["ulpin"], floor, i + 1, poly, "owned", owner)
    # Top floor: one leased unit + one air-rights terrace unit
    halves = _grid_split(fp_a, 2, 1)
    _insert_unit(conn, PARCEL_A["ulpin"], PARCEL_A["floor_count"] - 1, 1, halves[0], "leased", OWNERS[0]["owner_id"])
    _insert_unit(conn, PARCEL_A["ulpin"], PARCEL_A["floor_count"] - 1, 2, halves[1], "air-rights", None)

    # ---- Parcel B: small block, 2 units/floor ----
    halves_b = _grid_split(fp_b, 2, 1)
    for floor in range(0, 2):
        for i, poly in enumerate(halves_b):
            owner = OWNERS[i % len(OWNERS)]["owner_id"]
            _insert_unit(conn, PARCEL_B["ulpin"], floor, i + 1, poly, "owned", owner)

    # ---- Parcel C: conflict demo ----
    # Floor 0: two valid non-overlapping units
    halves_c = _grid_split(fp_c, 2, 1)
    _insert_unit(conn, PARCEL_C["ulpin"], 0, 1, halves_c[0], "owned", OWNERS[0]["owner_id"])
    _insert_unit(conn, PARCEL_C["ulpin"], 0, 2, halves_c[1], "owned", OWNERS[1]["owner_id"])

    # Floor 1: two OVERLAPPING units (deliberately conflict) — each spans 60% of footprint width
    xs = [c[0] for c in fp_c]
    ys = [c[1] for c in fp_c]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    dx = x_max - x_min
    inset = (y_max - y_min) * 0.05
    # Unit C-F1-U1: left 65% of footprint
    poly_c1 = _rect(x_min, y_min + inset, x_min + dx * 0.65, y_max - inset)
    # Unit C-F1-U2: right 65% (overlaps left unit by ~30%)
    poly_c2 = _rect(x_min + dx * 0.35, y_min + inset, x_max, y_max - inset)
    _insert_unit(conn, PARCEL_C["ulpin"], 1, 1, poly_c1, "owned", OWNERS[2]["owner_id"], status="conflict")
    _insert_unit(conn, PARCEL_C["ulpin"], 1, 2, poly_c2, "owned", OWNERS[3]["owner_id"], status="conflict")

    # Floor 2: one valid common area
    _insert_unit(conn, PARCEL_C["ulpin"], 2, 1, _rect(*_bbox(fp_c)), "common", None)

    # ---- Bulk: real OSM neighbourhood around the featured parcels ----
    n = seed_neighbourhood(conn)
    print(f"Seeded {n} neighbourhood buildings from OSM.")

    # Pre-seed an open dispute on the first conflict unit
    conflict_ulpin_1 = make_unit_ulpin(PARCEL_C["ulpin"], 1, 1)
    conn.execute(
        "INSERT INTO disputes (unit_ulpin, submitted_by, description, status) VALUES (?, ?, ?, 'open')",
        (conflict_ulpin_1, "OWN-003",
         "My unit boundary overlaps with the adjacent unit on Floor 1. "
         "The registered polygon for TN-02-6003 F1-U1 and F1-U2 share a ~30% overlapping zone. "
         "Requesting Registrar review and correction."),
    )

    conn.commit()


def _bbox(coords):
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return min(xs), min(ys), max(xs), max(ys)


if __name__ == "__main__":
    import sys
    init_db()
    conn = get_connection()
    if "--rebuild" in sys.argv:
        conn.executescript(
            "DELETE FROM disputes; DELETE FROM ownership_ledger; DELETE FROM units; "
            "DELETE FROM owners; DELETE FROM parcels;"
        )
    count = conn.execute("SELECT COUNT(*) AS n FROM parcels").fetchone()["n"]
    if count == 0 or "--rebuild" in sys.argv:
        seed(conn)
        print("Seeded mock data.")
    else:
        print(f"DB already has {count} parcel(s); skipping seed (use --rebuild to reset).")
    conn.close()
