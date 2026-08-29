import laspy
import numpy as np
import open3d as o3d


FILE = "points (1).laz"


# ============================================================
# LOAD
# ============================================================

print("Loading LiDAR...")

las = laspy.read(FILE)

points = np.column_stack([
    las.x,
    las.y,
    las.z
])

print(f"Total points: {len(points):,}")

print("\nCoordinate range:")

print("X:", points[:, 0].min(), "->", points[:, 0].max())
print("Y:", points[:, 1].min(), "->", points[:, 1].max())
print("Z:", points[:, 2].min(), "->", points[:, 2].max())


# ============================================================
# CLASSIFICATION INFORMATION
# ============================================================

if hasattr(las, "classification"):

    classes, counts = np.unique(
        las.classification,
        return_counts=True
    )

    print("\nLiDAR classifications:")

    for c, count in zip(classes, counts):

        print(
            f"Class {c}: {count:,} points"
        )


# ============================================================
# CENTER THE POINT CLOUD
# ============================================================

print("\nCentering point cloud...")

center = np.mean(points, axis=0)

points = points - center


# ============================================================
# REMOVE EXTREME OUTLIERS
# ============================================================

print("Removing extreme outliers...")

distance = np.linalg.norm(
    points,
    axis=1
)

limit = np.percentile(
    distance,
    99.9
)

points = points[
    distance < limit
]


# ============================================================
# DOWNSAMPLE
# ============================================================

print("Downsampling...")

pcd = o3d.geometry.PointCloud()

pcd.points = o3d.utility.Vector3dVector(
    points
)

pcd = pcd.voxel_down_sample(
    voxel_size=0.2
)


# ============================================================
# HEIGHT COLORING
# ============================================================

points = np.asarray(
    pcd.points
)

z = points[:, 2]

z_min = np.percentile(z, 2)
z_max = np.percentile(z, 98)

normalized = (
    z - z_min
) / (
    z_max - z_min + 1e-9
)

colors = np.zeros(
    (len(points), 3)
)

# Blue → green → red
colors[:, 0] = normalized
colors[:, 1] = 1 - normalized
colors[:, 2] = 1 - normalized * 0.5

pcd.colors = (
    o3d.utility.Vector3dVector(
        colors
    )
)


# ============================================================
# BOUNDING BOX
# ============================================================

bbox = pcd.get_axis_aligned_bounding_box()

bbox.color = np.array([
    1,
    1,
    1
])


# ============================================================
# AXES
# ============================================================

axes = o3d.geometry.TriangleMesh.create_coordinate_frame(
    size=10
)


# ============================================================
# SAVE
# ============================================================

o3d.io.write_point_cloud(
    "full_lidar_centered.ply",
    pcd
)


# ============================================================
# DISPLAY
# ============================================================

print("\nOpening viewer...")

o3d.visualization.draw_geometries(
    [
        pcd,
        bbox,
        axes
    ],
    window_name="FULL AERIAL LiDAR",
    width=1400,
    height=900
)