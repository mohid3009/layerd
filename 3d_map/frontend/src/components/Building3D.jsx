import React, { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Text } from '@react-three/drei'
import * as THREE from 'three'
import { makeLocalMapper } from '../api.js'

const RIGHTS_COLORS = {
  owned: '#4da3ff',
  leased: '#ffb84d',
  common: '#8f9aa8',
  'air-rights': '#b07aff',
}

function polygonToMeshPoints(polygonGeoJson, mapper) {
  const ring = polygonGeoJson.coordinates[0]
  return ring.map((c) => mapper.toMeters(c))
}
function UnitMesh({ unit, floorHeight, mapper, selected, conflictIds, onSelect }) {
  const pts = useMemo(() => polygonToMeshPoints(unit.polygon_geojson, mapper), [unit, mapper])
  const geometry = useMemo(() => {
    if (pts.length < 3) return null
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)))
    const g = new THREE.ExtrudeGeometry(shape, { depth: floorHeight * 0.85, bevelEnabled: false })
    return g
  }, [pts, floorHeight])

  const isConflict = conflictIds.has(unit.unit_ulpin)
  const color = isConflict ? '#ff4d4d' : RIGHTS_COLORS[unit.rights_type] || '#4da3ff'
  const emissive = selected === unit.unit_ulpin ? '#ffffff' : isConflict ? '#550000' : '#000000'
  const opacity = unit.floor_index < 0 ? 0.75 : 0.92

  if (!geometry) return null
  return (
    <mesh
      geometry={geometry}
      position={[0, unit.floor_index * floorHeight, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      onPointerDown={(e) => {
        e.stopPropagation()
        onSelect(unit.unit_ulpin)
      }}
    >
      <meshStandardMaterial
        color={color}
        transparent
        opacity={selected === unit.unit_ulpin ? 1 : opacity}
        emissive={emissive}
        emissiveIntensity={selected === unit.unit_ulpin ? 0.45 : 0.15}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

function GroundPlane({ size, center }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center[0], 0, center[1]]} receiveShadow>
      <planeGeometry args={[size[0] * 3 + 40, size[1] * 3 + 40]} />
      <meshStandardMaterial color="#141821" transparent opacity={0.6} side={THREE.DoubleSide} />
    </mesh>
  )
}

function FloorSlab({ bboxMeters, level, floorHeight }) {
  const w = bboxMeters.xMax - bboxMeters.xMin
  const d = bboxMeters.yMax - bboxMeters.yMin
  return (
    <mesh position={[w / 2, level * floorHeight - floorHeight * 0.06, -d / 2]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial color="#8ea0be" transparent opacity={0.05} side={THREE.DoubleSide} />
    </mesh>
  )
}

function FloorLabel({ bboxMeters, level, floorHeight }) {
  const w = bboxMeters.xMax - bboxMeters.xMin
  const label = level < 0 ? `B${-level}` : level === 0 ? 'G' : `F${level}`
  return (
    <Text
      position={[-2, level * floorHeight + floorHeight * 0.5, -(bboxMeters.yMax - bboxMeters.yMin) / 2]}
      fontSize={Math.max(1.2, w * 0.08)}
      color="#7d90ad"
      anchorX="right"
      anchorY="middle"
      outlineWidth={0.05}
      outlineColor="#0b0d12"
    >
      {label}
    </Text>
  )
}

export default function Building3D({ parcel, units, selected, conflictIds, onSelect }) {
  const mapper = useMemo(() => makeLocalMapper(parcel.footprint_geojson), [parcel])
  const bboxM = useMemo(() => {
    const ring = parcel.footprint_geojson.coordinates[0].map((c) => mapper.toMeters(c))
    const xs = ring.map((p) => p[0])
    const ys = ring.map((p) => p[1])
    return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) }
  }, [parcel, mapper])

  const levels = []
  for (let f = -parcel.basement_count; f < parcel.floor_count; f++) levels.push(f)
  const height = (parcel.floor_count + parcel.basement_count) * parcel.floor_height_m

  // Auto-fit camera to the building so small houses and towers frame equally well.
  const w = bboxM.xMax - bboxM.xMin
  const d = bboxM.yMax - bboxM.yMin
  const cx = (bboxM.xMin + bboxM.xMax) / 2
  const cz = -(bboxM.yMin + bboxM.yMax) / 2
  const R = Math.max(w, d, height, 8)
  const camPos = [cx + R * 1.05, R * 1.05 + height * 0.6, cz + R * 1.35]
  const target = [cx, height * 0.32, cz]

  return (
    <Canvas key={parcel.ulpin} camera={{ position: camPos, fov: 40 }} shadows>
      <color attach="background" args={['#0b0d12']} />
      <fog attach="fog" args={['#0b0d12', R * 4, R * 10]} />
      <ambientLight intensity={0.65} />
      <directionalLight position={[60, 100, 40]} intensity={1.0} />
      <directionalLight position={[-50, 40, -60]} intensity={0.3} />
      <GroundPlane size={[w, d]} center={[cx, cz]} />
      {levels.map((l) => (
        <React.Fragment key={l}>
          <FloorSlab bboxMeters={bboxM} level={l} floorHeight={parcel.floor_height_m} />
          <FloorLabel bboxMeters={bboxM} level={l} floorHeight={parcel.floor_height_m} />
        </React.Fragment>
      ))}
      {units.map((u) => (
        <UnitMesh
          key={u.unit_ulpin}
          unit={u}
          floorHeight={parcel.floor_height_m}
          mapper={mapper}
          selected={selected}
          conflictIds={conflictIds}
          onSelect={onSelect}
        />
      ))}
      <OrbitControls target={target} maxPolarAngle={Math.PI * 0.55} />
    </Canvas>
  )
}
