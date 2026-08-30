// Per-floor 3D rendering helper.
//
// Multi-storey buildings are split into one extrusion slice per storey, each
// with its own colour along a ground→roof gradient, so individual floors are
// visually distinguishable in the 3D view. Single-storey buildings pass
// through unchanged and keep their status colours (LiDAR / assumed / edited).
// Every slice keeps the parent's `building_id`, so click-selection and the
// selected-outline filter keep working across all floors of a building.

// hsl(h, s%, l%) → '#rrggbb' (MapLibre paints accept hex everywhere)
export function hslToHex(h, s, l) {
  s /= 100
  l /= 100
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, '0')
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`
}

// floor 0 (ground, darkest) → top floor (lightest), all in shades of blue
export function floorColor(i, n) {
  const t = n <= 1 ? 0 : i / (n - 1)
  return hslToHex(216, 68, 30 + t * 45)
}

// basement level B1 (lightest grey) → deepest level (darkest grey)
export function basementColor(i, n) {
  const t = n <= 1 ? 0 : i / (n - 1)
  return hslToHex(240, 8, 38 - t * 16)
}

// Expand building features into render slices. Height is divided evenly
// across storeys. Slices stack from the map plane (there is no terrain
// source, so fill-extrusion-base is a render offset, not an elevation —
// using the real ground_z would make buildings float in mid-air).
// Buildings with `basements` levels additionally get one grey slice per
// basement hanging BELOW the map plane (negative base/top), each one
// storey-height deep. Single-storey buildings keep their status colour for
// the above-ground part, so the measured/assumed legend stays truthful.
export function floorSlices(features) {
  const out = []
  for (const f of features) {
    if (!f.geometry) continue
    const p = f.properties
    const stories = Math.max(1, parseInt(p.stories) || 1)
    const basements = Math.max(0, parseInt(p.basements) || 0)
    const height = p.height_m || 0
    if (!height || (stories <= 1 && basements <= 0)) {
      out.push(f)
      continue
    }
    const slice = height / stories
    if (stories <= 1) {
      out.push(f)
    } else {
      for (let i = 0; i < stories; i++) {
        out.push({
          ...f,
          properties: {
            ...p,
            floor: i + 1,
            base_m: +(i * slice).toFixed(2),
            height_m: +((i + 1) * slice).toFixed(2),
            color: floorColor(i, stories),
          },
        })
      }
    }
    for (let k = 1; k <= basements; k++) {
      out.push({
        ...f,
        properties: {
          ...p,
          floor: -k, // B1, B2, … below ground
          base_m: +(-k * slice).toFixed(2),
          height_m: +(-(k - 1) * slice).toFixed(2),
          color: basementColor(k - 1, basements),
        },
      })
    }
  }
  return out
}
