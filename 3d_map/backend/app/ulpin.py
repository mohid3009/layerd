def make_unit_ulpin(base_ulpin: str, floor_index: int, unit_id: int) -> str:
    """Derived 3D ULPIN: {base_ULPIN}-F{floor}-U{unit}. Negative floor_index => basement (F-1, F-2...)."""
    if not base_ulpin:
        raise ValueError("base_ulpin is required")
    return f"{base_ulpin}-F{floor_index}-U{unit_id}"


def parse_unit_ulpin(unit_ulpin: str):
    """Returns (base_ulpin, floor_index, unit_id) or None if malformed."""
    parts = unit_ulpin.rsplit("-U", 1)
    if len(parts) != 2:
        return None
    base_floor, unit_part = parts
    if not unit_part.isdigit():
        return None
    floor_parts = base_floor.rsplit("-F", 1)
    if len(floor_parts) != 2:
        return None
    base_ulpin, floor_part = floor_parts
    try:
        floor_index = int(floor_part)
    except ValueError:
        return None
    return (base_ulpin, floor_index, int(unit_part))
