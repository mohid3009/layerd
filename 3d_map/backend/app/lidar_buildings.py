"""
LiDAR building-height extraction.

Pipeline (modelled on lidar/lidar.py):
  1. read a .laz with laspy -> X/Y/Z numpy columns (same as lidar.py)
  2. drop extreme outliers with the same 99.9th-percentile distance filter
  3. reproject to WGS84 (EPSG:4326) using the CRS embedded in the LAS header;
     if the header has no CRS, an explicit EPSG supplied by the caller is used
  4. for every footprint polygon in the corresponding GeoJSON:
       - gather LiDAR points that fall inside the polygon
       - ground_z = low percentile of Z, roof_z = high percentile of Z
       - height_m = roof_z - ground_z
       - stories  = round(height_m / floor_height)
       - NO lidar points above the footprint -> assume a 1-storey building
"""

import copy
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request

import laspy
import numpy as np
import pyproj
import shapely
from shapely.geometry import shape

# Minimum points inside a footprint before we trust the LiDAR measurement.
MIN_POINTS_FOR_HEIGHT = 3

# Percentiles used to separate ground from roof within a footprint.
GROUND_PERCENTILE = 5
# 95 (not 98) so sparse aerial returns (masts, birds, noise) inside the
# footprint don't blow up the roof estimate.
ROOF_PERCENTILE = 95

# ~10 m ground-search buffer around an empty footprint (degrees).
BUFFER_DEG = 0.0001

# Overpass API endpoints tried in order when fetching OSM footprints.
OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)

# Large bboxes are auto-split into tiles of at most this area (deg²).
TILE_AREA_DEG2 = 0.02        # ~14 km × 14 km per Overpass query
MIN_TILE_AREA_DEG2 = 0.0005  # below this a failing tile is not split further
MAX_TILES = 60               # hard cap → ~1.2 deg² (~110 km × 110 km) max

# Server-side transient failures worth retrying.
RETRYABLE_CODES = {429, 500, 502, 503, 504}

UA = "3d-ulpin-lidar-demo/1.0"


class LidarExtractionError(ValueError):
    pass


def _horizontal_crs(crs):
    """Reduce a compound CRS (horizontal + vertical) to its horizontal part."""
    if crs is None:
        return None
    sub = getattr(crs, "sub_crs_list", None)
    if sub:
        return sub[0]
    return crs


def read_crs(las):
    """Parse the CRS from the LAS header; return (crs, description)."""
    try:
        crs = las.header.parse_crs()
    except Exception:
        crs = None
    if crs is None:
        return None, None
    try:
        desc = crs.name
    except Exception:
        desc = str(crs)
    return crs, desc


def read_las(fileobj):
    """
    Read a .laz/.las file and return (las, points) where points is an (N, 3)
    array of [x, y, z] in the file's native CRS, after dropping NaNs and
    extreme outliers (same 99.9th-percentile filter as lidar.py).
    """
    las = laspy.read(fileobj)

    points = np.column_stack([las.x, las.y, las.z])  # same as lidar.py
    points = points[np.isfinite(points).all(axis=1)]
    if len(points) == 0:
        raise LidarExtractionError("LiDAR file contains no usable points")

    # Extreme-outlier removal — same 99.9th-percentile filter as lidar.py,
    # applied to the horizontal plane so Z spikes are handled separately.
    center = points[:, :2].mean(axis=0)
    dist = np.linalg.norm(points[:, :2] - center, axis=1)
    keep = dist < np.percentile(dist, 99.9)
    points = points[keep]

    return las, points


def to_wgs84(las, points, epsg=None):
    """
    Reproject native-CRS points to WGS84. Returns (points_wgs84, crs_desc)
    where points_wgs84 is an (N, 3) array of [lon, lat, z] in EPSG:4326, with
    z kept in the file's vertical datum (only differences within a footprint
    are used, so the vertical datum does not matter).
    """
    crs, desc = read_crs(las)
    hcrs = _horizontal_crs(crs)
    if hcrs is not None:
        transformer = pyproj.Transformer.from_crs(hcrs, "EPSG:4326", always_xy=True)
        crs_desc = desc
    elif epsg:
        transformer = pyproj.Transformer.from_crs(
            f"EPSG:{int(epsg)}", "EPSG:4326", always_xy=True
        )
        crs_desc = f"EPSG:{int(epsg)} (caller-supplied)"
    else:
        raise LidarExtractionError(
            "LiDAR file has no embedded CRS — pass an explicit epsg (e.g. 2193)"
        )

    lon, lat = transformer.transform(points[:, 0], points[:, 1])
    return np.column_stack([lon, lat, points[:, 2]]), crs_desc


def load_laz_points(fileobj, epsg=None):
    """Convenience: read + reproject in one call (see read_las / to_wgs84)."""
    las, points = read_las(fileobj)
    return to_wgs84(las, points, epsg=epsg)


def _wgs84_transformer(las, epsg, what):
    """
    Build a pyproj transformer from the LAS's native horizontal CRS (or an
    explicit epsg) to WGS84. Raises a friendly LidarExtractionError when no
    CRS is available. `what` names the thing being transformed for the error.
    """
    crs, _ = read_crs(las)
    hcrs = _horizontal_crs(crs)
    if hcrs is not None:
        return pyproj.Transformer.from_crs(hcrs, "EPSG:4326", always_xy=True)
    if epsg:
        return pyproj.Transformer.from_crs(
            f"EPSG:{int(epsg)}", "EPSG:4326", always_xy=True
        )
    raise LidarExtractionError(
        f"no CRS available to interpret {what} — choose WGS84, "
        "pass an epsg, or use a .laz with an embedded CRS"
    )


def transform_bbox_to_wgs84(las, bbox, epsg=None):
    """
    Transform a bbox given in the LAS's native CRS (or an explicit epsg) into
    a WGS84 lon/lat bbox. All four corners are transformed and min/max taken,
    since a projected rectangle is generally not a rectangle in WGS84.
    Returns (xmin, ymin, xmax, ymax) in EPSG:4326 degrees.
    """
    transformer = _wgs84_transformer(las, epsg, "the bounding box")
    xmin, ymin, xmax, ymax = bbox
    lons, lats = transformer.transform(
        (xmin, xmax, xmin, xmax), (ymin, ymin, ymax, ymax)
    )
    return min(lons), min(lats), max(lons), max(lats)


def _reproject_coords(coords, transformer):
    """
    Recursively reproject every [x, y, ...] vertex of a GeoJSON coordinate
    structure (Position → ring → polygon → multipolygon nesting).
    """
    if isinstance(coords, list):
        if coords and isinstance(coords[0], (int, float)):
            lon, lat = transformer.transform(coords[0], coords[1])
            return [lon, lat, *coords[2:]]
        return [_reproject_coords(c, transformer) for c in coords]
    return coords


def transform_geojson_to_wgs84(geojson, las, epsg=None):
    """
    Reproject the vertices of a GeoJSON FeatureCollection given in the LAS's
    native CRS (or an explicit epsg) into WGS84 lon/lat. Used when GIS parcel
    footprints are exported in the same projected CRS/units as the .laz —
    the document is deep-copied and only coordinates (plus a FeatureCollection-
    level bbox, if present) are touched; properties are left untouched.
    """
    transformer = _wgs84_transformer(las, epsg, "the footprint GeoJSON")

    out = copy.deepcopy(geojson)
    items = out.get("features") if isinstance(out, dict) else None
    if items is None:
        items = [out] if isinstance(out, dict) else []
    for f in items:
        geom = f.get("geometry") if isinstance(f, dict) else None
        if not geom:
            continue
        if "coordinates" in geom:
            geom["coordinates"] = _reproject_coords(geom["coordinates"], transformer)
        for sub in geom.get("geometries") or []:
            if "coordinates" in sub:
                sub["coordinates"] = _reproject_coords(sub["coordinates"], transformer)

    # FeatureCollection-level bbox, if present (x0, y0, x1, y1)
    if isinstance(out, dict) and isinstance(out.get("bbox"), list) and len(out["bbox"]) == 4:
        x0, y0, x1, y1 = out["bbox"]
        lons, lats = transformer.transform((x0, x1, x0, x1), (y0, y0, y1, y1))
        out["bbox"] = [min(lons), min(lats), max(lons), max(lats)]
    return out


def bbox_to_geojson(xmin, ymin, xmax, ymax):
    """A WGS84 bounding box as a single-polygon FeatureCollection."""
    return {
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


def _collect_polygons(geojson):
    """
    Flatten any GeoJSON (FeatureCollection / Feature / bare geometry) into a
    list of (feature_index, name, shapely polygon, original properties).
    Multi-geometries are exploded into their parts.
    """
    if isinstance(geojson, (str, bytes)):
        geojson = json.loads(geojson)

    gtype = geojson.get("type")
    if gtype == "FeatureCollection":
        items = geojson.get("features", [])
    elif gtype == "Feature":
        items = [geojson]
    elif gtype:
        items = [{"type": "Feature", "properties": {}, "geometry": geojson}]
    else:
        raise LidarExtractionError("unrecognised GeoJSON document")

    out = []
    for idx, f in enumerate(items):
        geom = f.get("geometry")
        if not geom:
            continue
        props = f.get("properties") or {}
        name = (
            props.get("name")
            or props.get("id")
            or props.get("ulpin")
            or props.get("osm_id")
            or (str(props.get("way_id")) if props.get("way_id") is not None else None)
            or f"feature-{idx}"
        )
        try:
            sgeom = shape(geom)
        except Exception:
            continue
        parts = sgeom.geoms if sgeom.geom_type.startswith("Multi") else [sgeom]
        part_i = 0
        for g in parts:
            if g.is_empty or g.geom_type != "Polygon":
                continue
            label = name if part_i == 0 else f"{name}-{part_i + 1}"
            out.append((idx, label, g, props))
            part_i += 1
    return out


def _height_from_points(zi, floor_height):
    """Ground/roof/height/stories from the Z values above one footprint."""
    ground_z = float(np.percentile(zi, GROUND_PERCENTILE))
    roof_z = float(np.percentile(zi, ROOF_PERCENTILE))
    height = max(roof_z - ground_z, 0.0)
    stories = max(1, int(round(height / floor_height))) if height > 0 else 1
    return ground_z, roof_z, height, stories


def extract_building_heights(geojson, points_wgs84, floor_height=3.0):
    """
    For every footprint polygon, measure building height from the LiDAR
    points above it.

    Returns (featurecollection, stats):
      - FeatureCollection with original geometry + properties enriched with
        height_m / stories / ground_z / roof_z / lidar_points / height_source
      - stats dict summarising the run
    """
    polys = _collect_polygons(geojson)
    if not polys:
        raise LidarExtractionError("no Polygon features found in the footprint GeoJSON")

    pts = points_wgs84
    lons, lats, z = pts[:, 0], pts[:, 1], pts[:, 2]

    # spatial index over the whole cloud once — per-building point lookups
    # become ~instant even with tens of thousands of footprints
    tree = shapely.STRtree(shapely.points(lons, lats))

    features = []
    n_lidar = 0
    n_assumed = 0
    heights = []

    for idx, label, geom, props in polys:
        # predicate is evaluated as contains(geom, point) → points inside the
        # footprint (STRtree argument order: input geometry first)
        hit_idx = tree.query(geom, predicate="contains")
        zi = z[hit_idx]

        if len(zi) >= MIN_POINTS_FOR_HEIGHT:
            ground_z, roof_z, height_m, stories = _height_from_points(zi, floor_height)
            source = "lidar"
            n_lidar += 1
        else:
            # No (or too few) LiDAR points above the footprint:
            # assume a 1-storey building. Estimate the local ground from
            # points in a small buffer around the polygon (~10 m) so the
            # reported ground/roof Z values are sensible.
            buf = geom.buffer(BUFFER_DEG)
            bminx, bminy, bmaxx, bmaxy = buf.bounds
            bcand = (
                (lons >= bminx) & (lons <= bmaxx) & (lats >= bminy) & (lats <= bmaxy)
            )
            zi_buf = z[bcand]
            ground_z = (
                float(np.percentile(zi_buf, GROUND_PERCENTILE))
                if len(zi_buf) >= MIN_POINTS_FOR_HEIGHT
                else 0.0
            )
            roof_z = ground_z + floor_height
            height_m = floor_height
            stories = 1
            source = "assumed-1-story"
            n_assumed += 1

        heights.append(height_m)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    **props,
                    "building_id": label,
                    "height_m": round(height_m, 2),
                    "stories": stories,
                    "ground_z": round(ground_z, 2),
                    "roof_z": round(roof_z, 2),
                    "lidar_points": int(len(zi)),
                    "height_source": source,
                    "color": "#4da3ff" if source == "lidar" else "#ffb84d",
                },
                "geometry": geom.__geo_interface__,
            }
        )

    fc = {"type": "FeatureCollection", "features": features}
    stats = {
        "buildings": len(features),
        "from_lidar": n_lidar,
        "assumed_1_story": n_assumed,
        "max_height_m": round(max(heights), 2) if heights else 0,
        "mean_height_m": round(sum(heights) / len(heights), 2) if heights else 0,
        "floor_height_m": floor_height,
    }
    return fc, stats


def heights_from_attributes(geojson, floor_height=3.0):
    """
    No-LiDAR path: derive building heights purely from footprint attributes —
    an explicit `height` tag first, then `building:levels` × storey height,
    otherwise assume a 1-storey building. Returns (featurecollection, stats)
    with the same shape as extract_building_heights so the rest of the
    pipeline (PostGIS save, map rendering, editing) is unchanged.
    """
    polys = _collect_polygons(geojson)
    if not polys:
        raise LidarExtractionError("no Polygon features found in the footprint GeoJSON")

    features = []
    n_height = 0
    n_levels = 0
    n_assumed = 0
    heights = []

    for idx, label, geom, props in polys:
        raw_height = props.get("osm_height") or props.get("height")
        raw_levels = props.get("building_levels") or props.get("building:levels")

        height = None
        stories = 1
        source = "assumed-1-story"
        try:  # explicit height tag wins ("12", "12.5", "12 m")
            height = float(str(raw_height).rstrip("m").strip())
            stories = max(1, int(round(height / floor_height)))
            source = "tag-height"
            n_height += 1
        except (TypeError, ValueError):
            pass
        if height is None:
            try:  # fall back to a storey count
                stories = max(1, int(round(float(str(raw_levels).strip()))))
                height = stories * floor_height
                source = "tag-levels"
                n_levels += 1
            except (TypeError, ValueError):
                height = floor_height
                n_assumed += 1

        heights.append(height)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    **props,
                    "building_id": label,
                    "height_m": round(height, 2),
                    "stories": stories,
                    "ground_z": None,
                    "roof_z": None,
                    "lidar_points": 0,
                    "height_source": source,
                    "color": "#4da3ff" if source != "assumed-1-story" else "#ffb84d",
                },
                "geometry": geom.__geo_interface__,
            }
        )

    fc = {"type": "FeatureCollection", "features": features}
    stats = {
        "buildings": len(features),
        "from_height_tag": n_height,
        "from_levels": n_levels,
        "assumed_1_story": n_assumed,
        "max_height_m": round(max(heights), 2) if heights else 0,
        "mean_height_m": round(sum(heights) / len(heights), 2) if heights else 0,
        "floor_height_m": floor_height,
    }
    return fc, stats


def _aoi_bounds(geojson):
    """Bounding box (south, west, north, east) of the area-of-interest GeoJSON."""
    polys = _collect_polygons(geojson)
    if not polys:
        raise LidarExtractionError("no Polygon found in the area-of-interest GeoJSON")
    union = shapely.union_all([g for _, _, g, _ in polys])
    minx, miny, maxx, maxy = union.bounds
    return miny, minx, maxy, maxx


class _OverpassBusy(Exception):
    """Tile query failed with a transient/server-side error — caller may split."""

    def __init__(self, detail):
        super().__init__(detail)
        self.detail = detail


def _overpass_query(s, w, n, e, timeout):
    """Run one Overpass query for a bbox; returns parsed JSON on success."""
    query = (
        f"[out:json][timeout:{timeout}];"
        f'way["building"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});'
        "out geom;"
    )
    data = urllib.parse.urlencode({"data": query}).encode()
    last_err = None
    for url in OVERPASS_ENDPOINTS:
        host = url.split("/")[2]
        for attempt in range(2):
            try:
                req = urllib.request.Request(
                    url, data=data, headers={"User-Agent": UA}
                )
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read())
                remark = payload.get("remark") or ""
                if "runtime error" in remark:
                    raise _OverpassBusy(f"runtime error: {remark}")
                return payload
            except urllib.error.HTTPError as err:
                last_err = f"HTTP {err.code} from {host}"
                if err.code not in RETRYABLE_CODES:
                    raise LidarExtractionError(
                        f"Overpass rejected the query ({last_err})"
                    ) from err
            except _OverpassBusy:
                raise
            except Exception as err:  # timeouts, DNS, connection resets
                last_err = f"{type(err).__name__}: {err}"
            if attempt == 0:
                time.sleep(1.5)
    raise _OverpassBusy(last_err)


def _fetch_tile(s, w, n, e, timeout, elements, depth):
    """
    Fetch one tile; on a transient/server failure, split it into quadrants and
    retry each (dense cities choke on big tiles, quadrants usually succeed).
    Results are merged into `elements` keyed by OSM element id.
    """
    try:
        payload = _overpass_query(s, w, n, e, timeout)
    except _OverpassBusy as err:
        if depth < 3 and (n - s) * (e - w) / 4 >= MIN_TILE_AREA_DEG2:
            latm, lonm = (s + n) / 2, (w + e) / 2
            for quad in (
                (s, w, latm, lonm),
                (s, lonm, latm, e),
                (latm, w, n, lonm),
                (latm, lonm, n, e),
            ):
                _fetch_tile(*quad, timeout, elements, depth + 1)
            return
        raise LidarExtractionError(
            f"Overpass unavailable (last error: {err.detail}). The public servers "
            "are often transiently overloaded — try again in a moment."
        ) from err
    for el in payload.get("elements", []):
        elements[el.get("id")] = el


def fetch_osm_buildings(geojson, timeout=90, progress=None):
    """
    Fetch building footprints from OSM (Overpass API) for the region covered
    by the area-of-interest GeoJSON. Large areas are automatically split into
    tiles (and tiles further split when a server refuses them); results are
    deduplicated by OSM way id. Returns a GeoJSON FeatureCollection whose
    features carry the original OSM tags as properties.
    """
    s, w, n, e = _aoi_bounds(geojson)
    side = math.sqrt(TILE_AREA_DEG2)
    nx = max(1, math.ceil((e - w) / side))
    ny = max(1, math.ceil((n - s) / side))
    if nx * ny > MAX_TILES:
        raise LidarExtractionError(
            f"bounding box too large ({(n - s) * (e - w):.3f} deg² — would need "
            f"{nx * ny} Overpass tiles; keep it under {MAX_TILES} tiles "
            f"(~{math.sqrt(MAX_TILES * TILE_AREA_DEG2):.2f} deg², "
            f"roughly a 110 km × 110 km box))"
        )

    tiles = [
        (
            s + i * (n - s) / ny,
            w + j * (e - w) / nx,
            s + (i + 1) * (n - s) / ny,
            w + (j + 1) * (e - w) / nx,
        )
        for i in range(ny)
        for j in range(nx)
    ]

    elements = {}
    done = 0
    for ts, tw, tn, te in tiles:
        _fetch_tile(ts, tw, tn, te, timeout, elements, 0)
        done += 1
        if progress:
            progress(done, len(tiles))
        time.sleep(0.4)  # be polite to the public mirrors

    features = []
    for el in elements.values():
        if el.get("type") != "way":
            continue
        coords = [[pt["lon"], pt["lat"]] for pt in (el.get("geometry") or [])]
        if len(coords) < 4:
            continue
        if coords[0] != coords[-1]:  # close the ring
            coords.append(coords[0])
        tags = el.get("tags") or {}
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "osm_id": f"way/{el.get('id')}",
                    "name": tags.get("name"),
                    "building": tags.get("building"),
                    "building_levels": tags.get("building:levels"),
                    "osm_height": tags.get("height"),
                },
                "geometry": {"type": "Polygon", "coordinates": [coords]},
            }
        )
    return {"type": "FeatureCollection", "features": features}

    features = []
    for el in payload.get("elements", []):
        if el.get("type") != "way":
            continue
        coords = [[pt["lon"], pt["lat"]] for pt in (el.get("geometry") or [])]
        if len(coords) < 4:
            continue
        if coords[0] != coords[-1]:  # close the ring
            coords.append(coords[0])
        tags = el.get("tags") or {}
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "osm_id": f"way/{el.get('id')}",
                    "name": tags.get("name"),
                    "building": tags.get("building"),
                    "building_levels": tags.get("building:levels"),
                    "osm_height": tags.get("height"),
                },
                "geometry": {"type": "Polygon", "coordinates": [coords]},
            }
        )
    return {"type": "FeatureCollection", "features": features}
