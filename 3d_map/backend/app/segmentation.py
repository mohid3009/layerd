"""
Floor-plan segmentation.

Primary: YOLOv11 segmentation (ultralytics) on an uploaded floor plan image —
weights default to `yolo11n-seg.pt` (auto-downloaded by ultralytics on first
use; override with the YOLO_WEIGHTS env var). Requires `pip install ultralytics`.

Fallback: a randomly generated floor plan — the floor plate is subdivided by
recursive splitting into plausible unit cells. Used when no image is uploaded,
or when ultralytics/torch is unavailable or inference fails. Every unit rect is
in normalized 0..1 floor-plan coordinates (x0, y0, x1, y1).
"""
import hashlib
import os

import numpy as np

_MODEL = None


def yolo_available():
    try:
        import ultralytics  # noqa: F401
        return True
    except Exception:
        return False


def _get_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    from ultralytics import YOLO

    weights = os.environ.get("YOLO_WEIGHTS", "yolo11n-seg.pt")
    _MODEL = YOLO(weights)
    return _MODEL


def _yolo_units(image_bytes, max_units=10):
    """Run YOLOv11-seg; return normalized unit rects [(x0, y0, x1, y1), ...]."""
    import cv2

    model = _get_model()
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("unreadable image")
    h, w = img.shape[:2]
    min_area = 0.012 * w * h
    res = model(img, conf=0.35, verbose=False)[0]

    out = []
    if res.masks is not None:
        for m in res.masks.data:  # (n, mh, mw) float 0..1
            mask = (m.cpu().numpy() * 255).astype(np.uint8)
            mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            c = max(contours, key=cv2.contourArea)
            if cv2.contourArea(c) < min_area:
                continue
            x, y, cw, ch = cv2.boundingRect(c)
            out.append((x / w, y / h, (x + cw) / w, (y + ch) / h))
    if not out and res.boxes is not None:
        # fall back to detection boxes when the model produced no masks
        for b in res.boxes:
            x0, y0, x1, y1 = [float(v) for v in b.xyxy[0]]
            if (x1 - x0) * (y1 - y0) < min_area:
                continue
            out.append((x0 / w, y0 / h, x1 / w, y1 / h))
    out.sort(key=lambda r: (r[2] - r[0]) * (r[3] - r[1]), reverse=True)
    return out[:max_units]


def random_units(n_units, seed):
    """Random fallback floor plan: recursive splitting into n_units cells."""
    if isinstance(seed, str):
        seed = int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12], 16)
    rng = np.random.default_rng(int(seed) % (2**32))
    cells = [(0.05, 0.05, 0.95, 0.95)]
    while len(cells) < max(2, n_units):
        cells.sort(key=lambda c: (c[2] - c[0]) * (c[3] - c[1]), reverse=True)
        x0, y0, x1, y1 = cells.pop(0)
        w, h = x1 - x0, y1 - y0
        if w < 0.14 and h < 0.14:
            break
        t = float(rng.uniform(0.38, 0.62))
        if w >= h:
            cells.append((x0, y0, x0 + w * t, y1))
            cells.append((x0 + w * t, y0, x1, y1))
        else:
            cells.append((x0, y0, x1, y0 + h * t))
            cells.append((x0, y0 + h * t, x1, y1))
    return cells


def segment_floorplan(image_bytes=None, n_units=None, seed=None):
    """
    Segment a floor plan into unit rects (normalized 0..1).

    image_bytes  — optional floor-plan image (PNG/JPG): YOLOv11-seg is used
    n_units/seed — fallback random plan controls

    Returns {'source': 'yolo' | 'random', 'rects': [(x0, y0, x1, y1), ...]}.
    """
    if image_bytes:
        try:
            rects = _yolo_units(image_bytes)
            if len(rects) >= 2:
                return {"source": "yolo", "rects": rects}
        except Exception:
            pass  # ultralytics missing / weights unavailable / bad image → fallback
    return {"source": "random", "rects": random_units(n_units or 6, seed or 0)}
