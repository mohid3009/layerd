import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { geoContains } from 'd3-geo'
import { feature } from 'topojson-client'

const LAND_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json'
const R = 1

// lat/lon -> point on sphere (same convention as three.js earth examples)
function spherePoint([lon, lat], r = R) {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((lon + 180) * Math.PI) / 180
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  )
}

// dotted landmass: lat/lon grid filtered by point-in-polygon against world land
function buildLandDots(land) {
  const pts = []
  // simplify the dot grid on small screens for performance
  const step = typeof window !== 'undefined' && window.innerWidth < 640 ? 2.4 : 1.5
  for (let lat = -80; lat <= 80; lat += step) {
    const n = Math.max(1, Math.round((360 / step) * Math.cos((lat * Math.PI) / 180)))
    for (let i = 0; i < n; i++) {
      const lon = -180 + (360 * i) / n
      // no land data -> render the full dot grid as a graceful fallback
      if (!land || geoContains(land, [lon, lat])) pts.push(spherePoint([lon, lat]))
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3),
  )
  return g
}

// pulsing marker on Chennai — the seed city of the dataset
function ChennaiMarker() {
  const ring = useRef()
  const dot = useRef()
  const pos = useMemo(() => spherePoint([80.2707, 13.0827], R * 1.001), [])
  useEffect(() => {
    ring.current.lookAt(0, 0, 0)
    dot.current.lookAt(0, 0, 0)
  }, [])
  useFrame(({ clock }) => {
    const t = (clock.elapsedTime % 2.4) / 2.4
    ring.current.scale.setScalar(0.4 + t * 2.4)
    ring.current.material.opacity = 0.85 * (1 - t)
  })
  return (
    <>
      <mesh ref={ring} position={pos}>
        <ringGeometry args={[0.018, 0.024, 32]} />
        <meshBasicMaterial color="#E8E8E8" transparent side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh ref={dot} position={pos}>
        <circleGeometry args={[0.011, 24]} />
        <meshBasicMaterial color="#FFFFFF" side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </>
  )
}

function GlobeMesh({ land }) {
  const dots = useMemo(() => buildLandDots(land), [land])
  return (
    <group rotation={[0.28, 0, -0.15]}>
      {/* dark occluder so back-side dots are hidden */}
      <mesh>
        <sphereGeometry args={[R * 0.992, 48, 48]} />
        <meshBasicMaterial color="#030303" />
      </mesh>
      <points geometry={dots}>
        <pointsMaterial
          size={0.011}
          color="#C7C7CC"
          transparent
          opacity={0.55}
          sizeAttenuation
          depthWrite={false}
        />
      </points>
      <ChennaiMarker />
    </group>
  )
}

export default function HeroGlobe() {
  const [land, setLand] = useState(null)
  useEffect(() => {
    let alive = true
    fetch(LAND_URL)
      .then((r) => r.json())
      .then((topo) => {
        if (alive) setLand(feature(topo, topo.objects.land))
      })
      .catch((e) => console.warn('globe landmass unavailable, using dot grid', e))
    return () => {
      alive = false
    }
  }, [])
  return (
    <Canvas camera={{ position: [0, 0.35, 3.1], fov: 40 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
      <GlobeMesh land={land} />
      <OrbitControls
        enableZoom={false}
        enablePan={false}
        autoRotate
        autoRotateSpeed={0.45}
        rotateSpeed={0.4}
      />
    </Canvas>
  )
}
