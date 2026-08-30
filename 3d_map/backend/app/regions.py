"""
Reverse-geocode session centroids to country/region — used by the dashboard to
group scans by country and region under countries. Results are cached in
memory; the public Nominatim instance is called at most ~1 req/second, and
failed lookups are retried only after 10 minutes.
"""
import json
import time
import urllib.parse
import urllib.request

CACHE = {}
CACHE_TTL = 7 * 24 * 3600  # successful lookups: 1 week
FAIL_TTL = 10 * 60         # failed lookups: retry after 10 minutes
_last_call = 0.0


def lookup_region(lat, lon):
    """Return {'country': ..., 'region': ...} for a WGS84 point (cached)."""
    global _last_call
    key = f"{round(lat, 2)},{round(lon, 2)}"
    now = time.time()
    hit = CACHE.get(key)
    if hit and now - hit["t"] < (CACHE_TTL if hit["v"]["country"] else FAIL_TTL):
        return hit["v"]

    # be polite to the public Nominatim instance: >= 1s between requests
    wait = 1.1 - (now - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()

    url = "https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode(
        {"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 5, "addressdetails": 1}
    )
    req = urllib.request.Request(
        url, headers={"User-Agent": "layerd-demo/1.0 (scan region grouping)"}
    )
    value = {"country": None, "region": None}
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode())
        addr = data.get("address") or {}
        value = {
            "country": addr.get("country") or "Unknown",
            "region": addr.get("state") or addr.get("region") or addr.get("county") or "—",
        }
    except Exception:
        pass  # network / parse error — cached as a failure for FAIL_TTL
    CACHE[key] = {"t": now, "v": value}
    return value
