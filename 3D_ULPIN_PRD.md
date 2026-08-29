# Product Requirements Document
## 3D ULPIN Generation and Vertical Property Mapping System
**SIH 2026 — Problem Statement SIH26095 (3D ULPIN variant)**
**Ministry:** Ministry of Rural Development / Department of Land Resources (DoLR)
**Version:** 1.0 (Hackathon Scope)
**Status:** Draft — for build reference

---

## 1. Problem Statement

### 1.1 Background
Existing land administration systems, including India's ULPIN (Unique Land Parcel Identification Number), are built for **2D surface parcels only**. A ULPIN uniquely identifies a plot of land by its footprint and geo-coordinates but carries no information about what's built above or below it — a 20-storey apartment building and an empty plot look identical at the ULPIN level.

This breaks down for:
- Multi-storey apartments (which unit does whom own?)
- Underground infrastructure (utility corridors, metro tunnels, basements)
- Air rights and elevated transport corridors
- Parking spaces (often not separately titled at all)

### 1.2 Core Problem
There is no standardized, automated way to:
1. Generate a unique spatial identity for a **vertical/volumetric unit** (a specific flat, basement slot, or utility corridor segment)
2. Validate that these volumetric units don't conflict with each other (topology validation)
3. Tie these units back to a legally recognized base parcel (backward compatibility with existing ULPIN)
4. Manage ownership records and disputes for these units

### 1.3 Why This Matters
- Ownership ambiguity for apartment units causes legal disputes
- Utility departments have no standardized way to record underground infrastructure against the same spatial reference as surface parcels
- Urban planning and redevelopment approvals are slowed by lack of accurate vertical records

---

## 2. Goals and Non-Goals

### 2.1 Goals (Hackathon Demo Scope)
- Demonstrate an end-to-end pipeline: 2D footprint → 3D building model → per-unit ULPIN generation → topology validation → ownership record → dispute resolution
- Show a working (simplified) AI-assisted floor segmentation step using computer vision
- Provide role-based dashboards for Citizen, Surveyor, and Registrar
- Show a mock handoff to NGDRS (National Generic Document Registration System) to close the loop conceptually

### 2.2 Non-Goals (Explicitly Out of Scope for Hackathon)
- Real drone imagery or LiDAR point-cloud processing (no time/hardware to acquire real data)
- Training a real deep learning model for building/floor extraction (will use OpenCV heuristics instead, clearly labeled as a CV baseline)
- Real blockchain implementation (will use a hash-chained append-only ledger instead; blockchain positioned as a future upgrade path in Q&A only)
- Actual integration with NGDRS or any government system (mock API payload only)
- Multi-tenant security, real authentication/authorization (basic role-switching only, no OAuth/JWT hardening needed for demo)
- Mobile app (web-only, per scoping discussion)
- Real GNSS/CORS hardware integration (coordinates will be mocked/pre-loaded)

---

## 3. Users and Roles

| Role | Description | Key Actions |
|---|---|---|
| **Citizen** | General public member checking property status or reporting a dispute | Search parcel/ULPIN, view masked ownership info, view 3D building, submit dispute, submit change request |
| **Surveyor / Developer** | Uploads building data for new or existing structures | Upload footprint + floor plan images, trigger AI segmentation, view validation results |
| **Government Registrar / Admin** | Land Records Officer who validates and approves | Review disputes, review change requests, approve/reject (writes to ownership ledger), view overlapping-volume conflicts in 3D |

---

## 4. User Journey (End-to-End Flow)

1. **Landing / Role Select** — user picks Citizen, Surveyor, or Registrar
2. **Search or select a parcel** — 2D map (Leaflet) loads with pre-loaded plots; user clicks a plot or searches a mock ULPIN (e.g. `DL-07-1234-5678-9012`)
3. **System detects vertical structure exists** — backend checks if parcel has associated building data; if yes, flags "This parcel has 3D vertical units" and offers 3D view
4. **3D building renders** (Three.js / react-three-fiber) — building extrudes from footprint, basements go down, floors go up; each level is a distinct clickable volume
5. **User clicks a specific floor/unit** — side panel shows derived 3D ULPIN (base ULPIN + `-F{floor}-U{unit}`), owner name (masked for citizen role), area, rights type (owned / leased / common / air-rights), document link
6. **Surveyor flow: upload + auto-generate** — surveyor uploads a floor plan image; OpenCV-based segmentation detects unit boundaries; topology validation runs (checks for overlaps in X-Y-Z space); ULPINs auto-generated for each valid unit
7. **Publish to registry (mock NGDRS handoff)** — "Push to NGDRS" button shows the JSON payload that would be sent; no real integration

### 4.1 Ownership & Dispute Sub-Flow
- Citizen submits a dispute (e.g. "boundary overlaps with neighboring unit") with optional document/photo attachment
- Dashboard pulls both units' 3D volumes and overlays them for visual comparison
- Registrar reviews, requests corrected floor plan or triggers re-segmentation if needed
- On resolution, a new entry is appended to the hash-chained ownership ledger; both parties' views update

---

## 5. Functional Requirements

### 5.1 Parcel & ULPIN Management
- FR1: System shall store base parcel records with a mock 14-digit ULPIN, footprint polygon (GeoJSON), and metadata (state, district, area)
- FR2: System shall generate derived 3D ULPINs in the format `{base_ULPIN}-F{floor_index}-U{unit_id}` for each vertical unit
- FR3: Floor index shall support negative values for basements (e.g. `F-1`, `F-2`)
- FR4: System shall store each unit's polygon, z-range (floor height bounds), area, and rights type

### 5.2 3D Visualization
- FR5: System shall render a 3D extrusion of the building footprint based on floor count and floor height
- FR6: Each floor/unit shall be an individually clickable 3D mesh
- FR7: Clicking a unit shall display its ULPIN, owner (role-dependent visibility), area, and rights type
- FR8: Basement/underground units shall render below the ground plane (z < 0) in a visually distinct way (e.g. different shading)

### 5.3 AI-Assisted Floor Segmentation (CV Baseline)
- FR9: System shall accept an uploaded floor plan image (PNG/JPG)
- FR10: System shall run OpenCV-based contour detection to identify closed-loop regions (candidate units)
- FR11: System shall filter detected contours by area to remove noise
- FR12: System shall convert surviving contours into unit polygons and map them to the correct floor's z-level

### 5.4 Topology Validation
- FR13: System shall check that no two units on the same floor overlap in X-Y space
- FR14: System shall check that all units are fully contained within the building footprint
- FR15: System shall flag and report specific conflicting unit ID pairs when validation fails
- FR16: System shall block ULPIN generation for units that fail validation until resolved

### 5.5 Ownership & Ledger
- FR17: System shall maintain an append-only, hash-chained ownership history per unit (each record includes a hash of the previous record)
- FR18: System shall detect and flag any tampering in the ledger (broken hash chain)
- FR19: Ledger writes shall only occur via Registrar approval — no direct citizen/surveyor writes

### 5.6 Dispute Management
- FR20: Citizens shall be able to submit a dispute against a specific unit with a description and optional attachment
- FR21: System shall visually overlay conflicting units' volumes for Registrar review
- FR22: Registrar shall be able to approve/reject disputes with a mandatory reason field
- FR23: Approved dispute resolutions shall trigger a new ledger entry

### 5.7 Role-Based Access
- FR24: Citizen role shall have read-only access to parcel/unit data with masked owner names
- FR25: Surveyor role shall have upload and validation-trigger access only
- FR26: Registrar role shall have full read access plus approve/reject capability on disputes and change requests

---

## 6. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | 3D view should render a building with up to ~20 floors / ~10 units per floor without noticeable lag on a standard laptop |
| Usability | Role switching should be a simple UI toggle for demo purposes (no full auth needed) |
| Reliability | Demo must run fully offline / on localhost — no dependency on external APIs or internet during presentation |
| Portability | Entire stack must run on a single laptop with two terminal processes (frontend + backend) |
| Data integrity | Hash-chain must be verifiable — tampering with any historical record must be detectable |

---

## 7. System Architecture

### 7.1 Components

```
┌────────────────────────┐        REST/JSON        ┌──────────────────────────┐
│  Frontend                │ ───────────────────────► │  Backend (FastAPI)         │
│  React + Vite             │ ◄─────────────────────── │  Python                    │
│  react-three-fiber         │                          │  localhost:8000            │
│  localhost:5173             │                          │                            │
└────────────────────────┘                          │  - ULPIN generation logic   │
                                                       │  - Topology validation      │
                                                       │  - OpenCV floor segmentation│
                                                       │  - Ownership/dispute CRUD   │
                                                       │  - Hash-chained ledger      │
                                                       └──────────────┬─────────────┘
                                                                      │
                                                                      ▼
                                                              ┌──────────────┐
                                                              │  SQLite        │
                                                              │  (local file)  │
                                                              └──────────────┘
```

### 7.2 Technology Choices

| Layer | Choice | Rationale |
|---|---|---|
| Frontend framework | React + Vite | Fast dev server, standard for hackathon speed |
| 3D rendering | react-three-fiber (Three.js) | Native React integration, good extrusion/geometry support |
| 2D map | Leaflet | Lightweight, no API key required (vs Mapbox/Google Maps) |
| Backend | FastAPI (Python) | Same language as OpenCV step avoids subprocess/IPC complexity; async support; auto-generated API docs |
| Computer vision | OpenCV (`cv2`) | Contour detection is sufficient for demo-grade "floor segmentation"; no training required |
| Database | SQLite | Zero setup, file-based, survives restarts, no server process to manage during demo |
| Communication | REST over HTTP (JSON) | Simple, synchronous, no need for websockets at this scope |

### 7.3 Why Not (Explicitly Rejected Options)
- **Separate CV microservice**: rejected — adds a third process to manage on demo day for no benefit since backend is already Python
- **PostGIS/real spatial DB**: rejected — overlap checks are simple bounding-box/polygon math in Python; PostGIS is overkill for hackathon scale
- **Real blockchain**: rejected — see PRD Appendix A for full reasoning
- **Native mobile app**: rejected — PS is inherently desk-based GIS work (surveyors, registrars); no mobile requirement in the brief
- **Cloud deployment**: rejected — local-only removes risk of wifi/deployment failure during live demo

---

## 8. Data Model (Simplified)

### 8.1 `parcels`
| Field | Type | Notes |
|---|---|---|
| ulpin | string (PK) | Base 14-digit mock ULPIN |
| footprint_geojson | text (JSON) | Surface polygon |
| state, district | string | Metadata |
| floor_count | int | |
| basement_count | int | |
| floor_height_m | float | |

### 8.2 `units`
| Field | Type | Notes |
|---|---|---|
| unit_ulpin | string (PK) | `{base_ulpin}-F{n}-U{n}` |
| parcel_ulpin | string (FK) | |
| floor_index | int | Negative for basement |
| polygon_geojson | text (JSON) | Unit boundary within floor |
| area_sqm | float | |
| rights_type | enum | owned / leased / common / air-rights |
| owner_id | string (FK, nullable) | |
| validation_status | enum | valid / conflict / pending |

### 8.3 `owners`
| Field | Type | Notes |
|---|---|---|
| owner_id | string (PK) | |
| name | string | |
| contact_info | string | |

### 8.4 `ownership_ledger`
| Field | Type | Notes |
|---|---|---|
| entry_id | int (PK, autoincrement) | |
| unit_ulpin | string (FK) | |
| event_type | enum | registration / transfer / dispute_resolution / correction |
| owner_id | string (FK) | |
| timestamp | datetime | |
| prev_hash | string | Hash of previous entry for this unit |
| entry_hash | string | Hash of this entry's content + prev_hash |

### 8.5 `disputes`
| Field | Type | Notes |
|---|---|---|
| dispute_id | int (PK) | |
| unit_ulpin | string (FK) | |
| submitted_by | string (FK to owners) | |
| description | text | |
| attachment_url | string, nullable | |
| status | enum | open / under_review / resolved / rejected |
| resolution_reason | text, nullable | |

---

## 9. API Endpoints (Draft)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/parcels/{ulpin}` | Fetch parcel + full unit tree |
| GET | `/parcels/{ulpin}/units/{unit_ulpin}` | Fetch single unit details |
| POST | `/floorplan/upload` | Upload floor plan image, returns detected unit polygons |
| POST | `/units/generate` | Generate ULPINs for a set of validated unit polygons |
| POST | `/units/{unit_ulpin}/validate` | Run topology validation, returns pass/fail + conflicts |
| GET | `/units/{unit_ulpin}/ledger` | Fetch ownership history for a unit |
| POST | `/disputes` | Submit a new dispute |
| GET | `/disputes` | List disputes (Registrar view) |
| POST | `/disputes/{dispute_id}/resolve` | Approve/reject a dispute, appends ledger entry |
| POST | `/registry/publish/{parcel_ulpin}` | Mock NGDRS handoff, returns payload structure |

---

## 10. AI/ML Component — Honest Scoping

| PS Requirement | Hackathon Implementation | Production Path (mention in Q&A) |
|---|---|---|
| Automated building extraction | Skipped — footprint provided as pre-loaded GeoJSON | Semantic segmentation on drone/satellite imagery (e.g. Mask R-CNN on building footprints) |
| Floor segmentation | OpenCV contour detection on uploaded floor plan images | Trained CNN/U-Net on labeled floor plan datasets (e.g. CubiCasa5k) |
| Vertical parcel delineation | Rule-based: contour → polygon → z-mapping by floor index | Same approach, refined with BIM/IFC file ingestion for accuracy |
| Intelligent topology validation | Bounding-box/polygon intersection checks in Python (Shapely) | Same logic, scaled with spatial indexing (R-tree) for large datasets |

**Framing for judges:** the pipeline architecture (upload → extract → validate → generate ID) is real and correct; the extraction step uses a CV baseline for demo purposes with a clear, named upgrade path to trained models.

---

## 11. Blockchain — Scoping Decision (Reference)

**Decision: Not implemented as a live feature.** Ownership history uses an append-only, hash-chained ledger (SHA-256 of each record + previous hash) — this gives tamper-evidence without consensus/mining overhead.

**If asked by judges:** framed as "blockchain-inspired, upgradable to a permissioned ledger (e.g. Hyperledger Fabric) for production, where state Land Records departments act as validator nodes." This preempts the question without spending build time on real chain infrastructure.

**Reasoning:** blockchain solves trust/tamper-resistance for a distributed-writer problem; land records are inherently single-writer (the government), so the main benefit of decentralization doesn't apply. The actual hard problem (spatial delineation, topology validation) is unrelated to ledger technology.

---

## 12. Demo Script (Suggested Flow for Judges)

1. Open as Citizen → search a mock ULPIN → see flat 2D parcel → note "no unit-level info available in today's system" framing
2. System flags "3D vertical units available" → switch to 3D view → building renders with floors/basement
3. Click a unit → show derived ULPIN, owner (masked), rights type
4. Switch to Surveyor role → upload a floor plan image → show OpenCV-detected unit boundaries overlaid on the image
5. Trigger validation → show a passing case
6. Trigger validation again with a deliberately broken floor plan (overlapping rooms) → show it correctly flagged, with conflicting unit IDs highlighted in the 3D view
7. Switch to Citizen role → submit a dispute on a unit
8. Switch to Registrar role → view dispute queue → see overlapping volumes visualized → approve resolution
9. Show updated ownership ledger with the new hash-chained entry
10. Click "Push to NGDRS" → show the mock JSON payload → close the loop

---

## 13. Build Priority / Sequencing

| Priority | Component | Reason |
|---|---|---|
| 1 | ULPIN schema + mock data | Unblocks everything downstream |
| 2 | 3D building extrusion (hardcoded footprint/floors) | Highest visual payoff, no dependencies |
| 3 | Backend API skeleton (FastAPI + SQLite) | Needed before any real data flows |
| 4 | Topology validation logic | Core "intelligence" of the system, needed for demo's key moment |
| 5 | OpenCV floor segmentation | Enhances credibility but can be stubbed with pre-made polygons if time runs short |
| 6 | Ownership ledger + dispute flow | Important for completeness, least visually dramatic — build last |
| 7 | NGDRS mock handoff | Simple JSON display, quick to add at the end |

---

## 14. Open Questions / Decisions Needed

- [ ] Exact ULPIN suffix format — confirm `-F{n}-U{n}` vs alternative (e.g. embedding z-range directly)
- [ ] How many pre-loaded demo parcels/buildings needed (recommend: 1 fully worked example + 1 simpler backup)
- [ ] Should citizen dispute submission require any identity check for demo purposes, or fully open for simplicity?
- [ ] Confirm team split — who owns frontend/3D vs backend/CV vs ledger/dispute logic

---

## Appendix A: Rejected Approaches Log

| Approach | Reason Rejected |
|---|---|
| Full blockchain (Hyperledger/Ethereum) | High build overhead, doesn't address core spatial problem, hard to demo consensus visually |
| Native mobile app | No mobile requirement in PS brief; GIS/cadastre work is desk-based |
| Real LiDAR/point-cloud pipeline | No hardware/time to acquire and process real point cloud data |
| PostGIS | Overkill for simple bounding-box overlap checks at hackathon scale |
| Cloud deployment | Risk of connectivity failure during live demo; local-only is safer |
