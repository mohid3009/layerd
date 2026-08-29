"""
reset_db.py — drop all data and re-seed from scratch.

Usage (from 3d_map/backend/ with venv active):
    python app/reset_db.py

Safe to run between demo sessions.
"""
import subprocess
import sys
import os

if __name__ == "__main__":
    seed_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed.py")
    print("Resetting and re-seeding database...")
    result = subprocess.run(
        [sys.executable, seed_script, "--rebuild"],
        cwd=os.path.dirname(os.path.abspath(__file__)),
    )
    sys.exit(result.returncode)
