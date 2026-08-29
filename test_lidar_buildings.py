"""
Quick validation of lidar_buildings against the real points (1).laz.

Synthesises footprints from the point cloud itself:
  - the densest grid cells  -> expect real LiDAR-measured heights
  - one empty grid cell     -> expect the 1-storey assumption
"""
import json
import sys
import time

import numpy as np

sys.path.insert(0, "3d_map/backend")
from app.lidar_buildings import load_laz_points, extract_building_heights

LAZ = "lidar/points (1).laz"

t0 = time.time()
pts, crs_desc = load_laz_points(LAZ)
print(f"loaded {len(pts):,} WGS84 points in {time.time()-t0:.1f}s")
print("CRS:", crs_desc)
print("lon range:", pts[:, 0].min(), "->", pts[:, 0].max())
print("lat range:", pts[:, 1].min(), "->", pts[:, 1].max())

# --- grid the cloud, find dense + empty cells -------------------------------
lon0, lat0 = pts[:, 0].min(), pts[:, 1].min()
NC = 60
lon_w = (pts[:, 0].max() - lon0) / NC
lat_w = (pts[:, 1].max() - lat0) / NC
cols = np.clip(((pts[:, 0] - lon0) / lon_w).astype(int), 0, NC - 1)
rows = np.clip(((pts[:, 1] - lat0) / lat_w).astype(int), 0, NC - 1)
counts = np.zeros((NC, NC), dtype=int)
np.add.at(counts, (rows, cols), 1)

# top 8 dense cells (require a healthy point count)
dense = [(r, c) for r, c in zip(*np.unravel_index(np.argsort(counts, axis=None)[::-1], counts.shape)) if counts[r, c] > 500][:8]
# an empty cell near the middle
empty = None
for r in range(NC // 2 - 5, NC // 2 + 5):
    for c in range(NC // 2 - 5, NC // 2 + 5):
        if counts[r, c] == 0:
            empty = (r, c)
            break
    if empty:
        break

def cell_poly(r, c, shrink=0.15):
    x0 = lon0 + c * lon_w + lon_w * shrink
    x1 = lon0 + (c + 1) * lon_w - lon_w * shrink
    y0 = lat0 + r * lat_w + lat_w * shrink
    y1 = lat0 + (r + 1) * lat_w - lat_w * shrink
    return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]

features = []
for i, (r, c) in enumerate(dense):
    features.append({
        "type": "Feature",
        "properties": {"name": f"dense-{i}"},
        "geometry": {"type": "Polygon", "coordinates": cell_poly(r, c)},
    })
if empty:
    features.append({
        "type": "Feature",
        "properties": {"name": "empty-area"},
        "geometry": {"type": "Polygon", "coordinates": cell_poly(*empty)},
    })

geojson = {"type": "FeatureCollection", "features": features}

t0 = time.time()
fc, stats = extract_building_heights(geojson, pts, floor_height=3.0)
print(f"\nextracted in {time.time()-t0:.1f}s")
print(json.dumps(stats, indent=2))
for f in fc["features"]:
    p = f["properties"]
    print(f"  {p['building_id']:<12} h={p['height_m']:6.2f} m  stories={p['stories']}  "
          f"pts={p['lidar_points']:6d}  ground={p['ground_z']:8.2f} roof={p['roof_z']:8.2f}  [{p['height_source']}]")

# sanity: every dense cell got a lidar measurement, empty cell assumed 1 story
assert all(f["properties"]["height_source"] == "lidar" for f in fc["features"] if f["properties"]["building_id"].startswith("dense"))
if empty:
    e = [f for f in fc["features"] if f["properties"]["building_id"] == "empty-area"][0]
    assert e["properties"]["height_source"] == "assumed-1-story" and e["properties"]["stories"] == 1
print("\nOK")
