import json
from shapely.geometry import shape, Polygon
from shapely.errors import GeometryTypeError

M_PER_DEG_LAT = 110574.0
M_PER_DEG_LON = 111320.0


def _to_shapely(geojson_str_or_dict):
    if isinstance(geojson_str_or_dict, str):
        geojson_str_or_dict = json.loads(geojson_str_or_dict)
    geom = geojson_str_or_dict.get("geometry", geojson_str_or_dict)
    return shape(geom)


def _project_to_meters(geom, lat0):
    """Equirectangular projection around latitude lat0 so areas/overlaps are in m²."""
    def proj(x, y):
        return ((x * M_PER_DEG_LON) * _cos(lat0), y * M_PER_DEG_LAT)
    return _transform_geom(geom, proj)


def _cos(lat_deg):
    import math
    return math.cos(math.radians(lat_deg))


def _transform_geom(geom, fn):
    from shapely.ops import transform as shp_transform
    return shp_transform(lambda x, y: fn(x, y), geom)


def validate_units(parcel_footprint_geojson, units):
    """
    units: list of dicts with keys: unit_ulpin, floor_index, polygon_geojson
    All geometry is projected to local meters (origin = footprint centroid) before checks,
    so overlap thresholds and reported areas are in m².
    FR13: no two units on the same floor overlap in X-Y.
    FR14: all units fully contained within footprint.
    """
    conflicts = []
    fp_ll = _to_shapely(parcel_footprint_geojson)
    lat0 = fp_ll.centroid.y
    footprint = _project_to_meters(fp_ll, lat0)

    by_floor = {}
    parsed = []
    for u in units:
        try:
            poly_ll = _to_shapely(u["polygon_geojson"])
        except (GeometryTypeError, ValueError, KeyError, json.JSONDecodeError) as e:
            conflicts.append({
                "type": "invalid_geometry",
                "units": [u.get("unit_ulpin", "?")],
                "detail": f"Unparseable polygon: {e}",
            })
            continue
        if not isinstance(poly_ll, Polygon) or poly_ll.is_empty:
            conflicts.append({
                "type": "invalid_geometry",
                "units": [u.get("unit_ulpin", "?")],
                "detail": "Geometry is not a non-empty polygon",
            })
            continue
        poly = _project_to_meters(poly_ll, lat0)
        parsed.append((u["unit_ulpin"], u["floor_index"], poly))
        by_floor.setdefault(u["floor_index"], []).append((u["unit_ulpin"], poly))

    for floor_idx, floor_units in by_floor.items():
        n = len(floor_units)
        for i in range(n):
            id_a, poly_a = floor_units[i]
            for j in range(i + 1, n):
                id_b, poly_b = floor_units[j]
                inter = poly_a.intersection(poly_b)
                # overlap = shared positive area; mere touching edges are fine
                if inter.area > 0.01:
                    conflicts.append({
                        "type": "overlap",
                        "units": [id_a, id_b],
                        "floor_index": floor_idx,
                        "detail": f"Overlap area {inter.area:.2f} m² on floor {floor_idx}",
                    })

    for unit_id, floor_idx, poly in parsed:
        if not footprint.covers(poly):
            outside = poly.difference(footprint)
            conflicts.append({
                "type": "outside_footprint",
                "units": [unit_id],
                "floor_index": floor_idx,
                "detail": f"{outside.area:.2f} m² extends beyond parcel footprint",
            })

    return {"valid": len(conflicts) == 0, "conflicts": conflicts}
