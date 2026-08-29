# User Stories — 3D ULPIN System
**SIH 2026 — SIH26095**

Reference table of user actions by role. Covers all functional requirements from the PRD.

---

## Role: Citizen

| # | User Action | System Response | FR |
|---|------------|-----------------|-----|
| C1 | Search a ULPIN in the top bar | Parcel list filters in real-time | FR1 |
| C2 | Click a parcel chip | 2D map flies to parcel polygon; sidebar shows base ULPIN, floors, area | FR1 |
| C3 | See "⚑ this parcel has 3D vertical units" badge | System flagged that building data exists; 3D button is enabled | FR2 |
| C4 | Click "3D building" | Three.js renders the extruded building with all floors and basements | FR5, FR8 |
| C5 | Click a floor unit in 3D | Side panel shows derived ULPIN (`base-Fn-Un`), masked owner name, area, rights type | FR6, FR7, FR24 |
| C6 | View a basement unit | Unit renders below ground plane in distinct shading | FR3, FR8 |
| C7 | Click "report dispute on this unit" | Dispute form expands | FR20 |
| C8 | Fill description and submit dispute | Dispute created with `open` status; registrar notified via queue | FR20 |
| C9 | View ownership history | Hash-chained ledger entries visible with truncated hashes | FR17 |

---

## Role: Surveyor

| # | User Action | System Response | FR |
|---|------------|-----------------|-----|
| S1 | Switch to Surveyor role | Surveyor panel appears below unit details | FR25 |
| S2 | Select a floor from dropdown | Floor index (including negative for basements) chosen for segmentation | FR3 |
| S3 | Select rights type | Default applied to all generated units on this floor | FR4 |
| S4 | Upload a floor plan PNG/JPG | OpenCV contour detection runs; overlay image returned with detected boundaries | FR9, FR10, FR11 |
| S5 | View segmentation overlay | Image shown with green outlines and unit labels (`U1`, `U2`…) | FR12 |
| S6 | Click "validate topology & generate ULPINs" | Topology validation runs; if pass, ULPINs generated and listed | FR13–FR16 |
| S7 | Validation fails (overlapping rooms) | Blocked — conflict list shown with unit pair IDs and overlap area in m² | FR15, FR16 |
| S8 | Click "push to NGDRS (mock)" | Modal shows full JSON payload with SHA-256 checksum | — |

---

## Role: Registrar / Admin

| # | User Action | System Response | FR |
|---|------------|-----------------|-----|
| R1 | Switch to Registrar role | Dispute queue panel + full ledger access visible | FR26 |
| R2 | View dispute queue | All disputes listed with status badges (open / under review / resolved / rejected) | FR21 |
| R3 | Click "mark under review" on a dispute | Dispute status updates to `under_review`; disputed unit auto-highlighted red in 3D view | FR21, FR26 |
| R4 | Click a dispute's unit ULPIN | App auto-switches to 3D view; disputed unit highlighted in red | FR21 |
| R5 | Enter resolution reason and approve | Ledger entry appended (`dispute_resolution`); dispute status → `resolved` | FR22, FR23 |
| R6 | Enter resolution reason and reject | Dispute status → `rejected`; no ledger write | FR22 |
| R7 | View ownership ledger | All hash-chained entries for selected unit shown chronologically | FR17 |
| R8 | Click "simulate tampering" | Latest ledger entry's owner corrupted; chain shows TAMPERED (pulsing red) | FR18 |
| R9 | Click "re-verify chain" | Chain re-checked; broken status confirmed | FR18 |
| R10 | View overlapping conflict units | Parcel C units pre-seeded with `conflict` status appear red in 3D view | FR15 |
| R11 | Click "push to NGDRS (mock)" | Modal shows mock payload to `https://ngdrs.gov.in/api/v2/records` | — |
