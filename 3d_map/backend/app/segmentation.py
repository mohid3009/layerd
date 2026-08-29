import cv2
import numpy as np


def segment_floorplan(image_bytes: bytes, min_area_frac=0.005, max_area_frac=0.5, epsilon_frac=0.02):
    """
    CV baseline: detect closed-loop room regions in a floor plan image.
    Returns dict with image dims and list of detected unit polygons.
    Each polygon: {"pixel_coords": [[x,y],...], "normalized": [[x/w,y/h],...], "area_px": int}
    Caller maps normalized coords onto the parcel footprint and assigns z by floor index.
    """
    buf = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Floor plans are usually dark lines on white; invert so rooms become foreground blobs
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # Close small gaps in wall lines so room loops are closed
    kernel = np.ones((5, 5), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    # RETR_CCOMP: level 0 = outer wall boundary, its children = enclosed rooms
    contours, hierarchy = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)

    candidates = []
    if contours and hierarchy is not None:
        hier = hierarchy[0]
        for idx, cnt in enumerate(contours):
            parent = hier[idx][3]
            if parent == -1:
                continue  # skip top-level outline; rooms are child contours of it
            area = cv2.contourArea(cnt)
            candidates.append((cnt, area))
    if not candidates:
        # fallback: dark-on-light plans — invert and retry
        inv = cv2.bitwise_not(binary)
        contours, hierarchy = cv2.findContours(inv, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        if contours and hierarchy is not None:
            hier = hierarchy[0]
            for idx, cnt in enumerate(contours):
                if hier[idx][3] == -1:
                    continue
                candidates.append((cnt, cv2.contourArea(cnt)))
    if not candidates:
        # last resort: any large closed blob
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates = [(c, cv2.contourArea(c)) for c in contours]

    h, w = binary.shape[:2]
    img_area = float(h * w)

    units = []
    for cnt, area in candidates:
        if area < min_area_frac * img_area or area > max_area_frac * img_area:
            continue  # noise filter (FR11)
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, epsilon_frac * peri, True)
        pts = approx.reshape(-1, 2).tolist()
        if len(pts) < 3:
            continue
        norm = [[round(x / w, 4), round(y / h, 4)] for x, y in pts]
        units.append({
            "pixel_coords": pts,
            "normalized": norm,
            "area_px": round(area, 1),
        })

    # largest first for stable unit numbering
    units.sort(key=lambda u: u["area_px"], reverse=True)
    return {"width": w, "height": h, "units_detected": len(units), "polygons": units}


def render_debug_overlay(image_bytes: bytes):
    """Returns PNG bytes of the image with detected boundaries drawn — used for surveyor preview."""
    buf = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    result = segment_floorplan(image_bytes)
    for i, poly in enumerate(result["polygons"]):
        pts = np.array(poly["pixel_coords"], dtype=np.int32)
        cv2.polylines(img, [pts], True, (0, 200, 0), 3)
        M = cv2.moments(pts)
        if M["m00"]:
            cx, cy = int(M["m10"] / M["m00"]), int(M["m01"] / M["m00"])
            cv2.putText(img, f"U{i+1}", (cx - 15, cy + 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 220), 2)
    ok, png = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return png.tobytes()
