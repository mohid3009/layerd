import hashlib
import json
from datetime import datetime, timezone


def _compute_entry_hash(unit_ulpin, event_type, owner_id, timestamp, prev_hash):
    payload = json.dumps(
        {"unit_ulpin": unit_ulpin, "event_type": event_type, "owner_id": owner_id,
         "timestamp": timestamp, "prev_hash": prev_hash},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def append_ledger_entry(conn, unit_ulpin, event_type, owner_id):
    """Append a hash-chained entry for this unit. prev_hash = last entry's entry_hash (or 'GENESIS')."""
    cur = conn.execute(
        "SELECT entry_hash FROM ownership_ledger WHERE unit_ulpin = ? ORDER BY entry_id DESC LIMIT 1",
        (unit_ulpin,),
    )
    row = cur.fetchone()
    prev_hash = row["entry_hash"] if row else "GENESIS"
    timestamp = datetime.now(timezone.utc).isoformat()
    entry_hash = _compute_entry_hash(unit_ulpin, event_type, owner_id, timestamp, prev_hash)
    conn.execute(
        "INSERT INTO ownership_ledger (unit_ulpin, event_type, owner_id, timestamp, prev_hash, entry_hash) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (unit_ulpin, event_type, owner_id, timestamp, prev_hash, entry_hash),
    )
    return entry_hash


def verify_chain(conn, unit_ulpin):
    """
    FR18: re-walk the chain; any record whose stored/recomputed hash mismatches is tampering.
    Returns {"intact": bool, "break_at_entry": int|None}
    """
    cur = conn.execute(
        "SELECT * FROM ownership_ledger WHERE unit_ulpin = ? ORDER BY entry_id ASC", (unit_ulpin,)
    )
    expected_prev = "GENESIS"
    for row in cur.fetchall():
        recomputed = _compute_entry_hash(
            row["unit_ulpin"], row["event_type"], row["owner_id"],
            row["timestamp"], row["prev_hash"],
        )
        if row["prev_hash"] != expected_prev or row["entry_hash"] != recomputed:
            return {"intact": False, "break_at_entry": row["entry_id"]}
        expected_prev = row["entry_hash"]
    return {"intact": True, "break_at_entry": None}
