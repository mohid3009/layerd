"""
3D ULPIN generation.

Base ULPIN: a deterministic mock 14-digit number derived from the building id
(format `XX-DD-DDDD-DDDD-DDDD`, e.g. `TN-07-4821-9034-7756`) — the same building
always yields the same base ULPIN.

Unit ULPIN: `{base}-F{floor}-U{unit}` — floor_index is negative for basements
(F-1, F-2), matching the PRD (FR2/FR3).
"""
import hashlib

# demo owner registry (deterministic assignment from the unit's ULPIN hash)
OWNERS = [
    ("OWN-0001", "Ramesh Iyer"),
    ("OWN-0002", "Priya Venkatesan"),
    ("OWN-0003", "Arun Krishnan"),
    ("OWN-0004", "Lakshmi Narayanan"),
    ("OWN-0005", "Fatima Beevi"),
    ("OWN-0006", "Vikram Chandra"),
    ("OWN-0007", "Ananya Sharma"),
    ("OWN-0008", "Mohan Das"),
    ("OWN-0009", "Kavitha Raman"),
    ("OWN-0010", "Suresh Pillai"),
    ("OWN-0011", "Divya Krishnamurthy"),
    ("OWN-0012", "Rahul Verma"),
]

RIGHTS_FLOOR = ("owned", "owned", "leased", "owned", "common")
RIGHTS_BASEMENT = ("leased", "common")


def _digest(text):
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()


def base_ulpin(building_id):
    """Deterministic mock 14-digit base ULPIN: XX-DD-DDDD-DDDD-DDDD."""
    h = _digest(building_id)
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    a = letters[int(h[0], 16) % 26] + letters[int(h[1], 16) % 26]
    digits = "".join(str(int(c, 16) % 10) for c in h[2:16])
    return f"{a}-{digits[0:2]}-{digits[2:6]}-{digits[6:10]}-{digits[10:14]}"


def unit_ulpin(base, floor_index, unit_no):
    return f"{base}-F{floor_index}-U{unit_no}"


def owner_for(ulpin, floor_index):
    """Deterministic demo owner + rights type for a unit."""
    h = _digest(ulpin)
    owner_id, name = OWNERS[int(h[0:4], 16) % len(OWNERS)]
    if floor_index < 0:
        rights = RIGHTS_BASEMENT[int(h[4:8], 16) % len(RIGHTS_BASEMENT)]
    else:
        rights = RIGHTS_FLOOR[int(h[4:8], 16) % len(RIGHTS_FLOOR)]
    return {"owner_id": owner_id, "owner_name": name, "rights_type": rights}
