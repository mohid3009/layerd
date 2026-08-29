import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { motion, useScroll, useTransform, useInView, animate } from 'framer-motion'
import HeroGlobe from './HeroGlobe.jsx'

const LandCtx = createContext(null)

const EASE = [0.16, 1, 0.3, 1]

function Reveal({ children, className = '', delay = 0 }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.8, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  )
}

function Counter({ to, suffix = '' }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-60px' })
  const [v, setV] = useState(0)
  useEffect(() => {
    if (!inView) return
    const c = animate(0, to, { duration: 1.8, ease: EASE, onUpdate: (x) => setV(Math.round(x)) })
    return () => c.stop()
  }, [inView, to])
  return (
    <span ref={ref}>
      {v}
      {suffix}
    </span>
  )
}

const CubeMark = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M12 2 21 7l-9 5-9-5 9-5Z" fill="#E8E8E8" />
    <path d="M3 7v10l9 5V12L3 7Z" fill="rgba(232,232,232,.55)" />
    <path d="M21 7v10l-9 5V12l9-5Z" fill="rgba(232,232,232,.28)" />
  </svg>
)

/* line-art icons — thin silver strokes, no fills */
const st = { fill: 'none', stroke: '#C0C0C0', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }
const IconFootprint = () => (
  <svg viewBox="0 0 32 32" width="34" height="34"><rect x="6" y="6" width="20" height="20" rx="2" {...st} /><path d="M6 16h20M16 6v20" {...st} opacity="0.4" /></svg>
)
const IconLayers3D = () => (
  <svg viewBox="0 0 32 32" width="34" height="34"><path d="M16 4 28 10 16 16 4 10Z" {...st} /><path d="M4 16l12 6 12-6" {...st} opacity="0.65" /><path d="M4 22l12 6 12-6" {...st} opacity="0.35" /></svg>
)
const IconId = () => (
  <svg viewBox="0 0 32 32" width="34" height="34"><rect x="4" y="8" width="24" height="16" rx="3" {...st} /><path d="M9 14h6M9 18h9" {...st} /><circle cx="22" cy="16" r="2.5" {...st} /></svg>
)
const IconValidate = () => (
  <svg viewBox="0 0 32 32" width="34" height="34"><path d="M16 4l10 4v8c0 6-4.5 10-10 12C10.5 26 6 22 6 16V8Z" {...st} /><path d="M11.5 16l3 3 6-6.5" {...st} /></svg>
)
const IconCube = () => (
  <svg viewBox="0 0 32 32" width="34" height="34"><path d="M16 4 27 10v12L16 28 5 22V10Z" {...st} /><path d="M5 10l11 6 11-6M16 16v12" {...st} opacity="0.55" /></svg>
)
const IconScan = () => (
  <svg viewBox="0 0 32 32" width="34" height="34"><path d="M4 8V4h4M24 4h4v4M28 24v4h-4M8 28H4v-4" {...st} /><rect x="9" y="13" width="14" height="8" {...st} opacity="0.65" /><path d="M12 13v8" {...st} opacity="0.35" /></svg>
)
const IconTopology = () => (
  <svg viewBox="0 0 32 32" width="34" height="34"><circle cx="16" cy="7" r="3" {...st} /><circle cx="7" cy="24" r="3" {...st} /><circle cx="25" cy="24" r="3" {...st} /><path d="M14 9.5 8.5 21.5M18 9.5l5.5 12M10 24h12" {...st} opacity="0.65" /></svg>
)
const IconChain = () => (
  <svg viewBox="0 0 32 32" width="34" height="34"><path d="M13 19 19 13" {...st} /><path d="M15.5 9.5 18 7a4.2 4.2 0 0 1 6 6l-2.5 2.5" {...st} /><path d="M16.5 22.5 14 25a4.2 4.2 0 0 1-6-6l2.5-2.5" {...st} /></svg>
)
const NAV_LINKS = [
  ['Problem', '#problem'],
  ['System', '#system'],
  ['Features', '#features'],
  ['Architecture', '#architecture'],
]

const STATS = [
  { to: 93, suffix: '', label: 'real OSM parcels' },
  { to: 478, suffix: '', label: 'vertical units addressed' },
  { to: 3, suffix: '', label: 'role-based workflows' },
  { to: 100, suffix: '%', label: 'hash-chained ledger' },
]

const STEPS = [
  { icon: <IconFootprint />, title: 'Footprint', desc: 'Real building footprints from OpenStreetMap define the parcel boundary.' },
  { icon: <IconLayers3D />, title: '3D model', desc: 'Floors, basements and air-rights are extruded from the footprint.' },
  { icon: <IconId />, title: 'ULPIN generation', desc: 'A deterministic hash turns every unit into a standard-format spatial ID.' },
  { icon: <IconValidate />, title: 'Validation', desc: 'Topology checks catch overlaps before a record is issued.' },
]

const FEATURES = [
  { icon: <IconCube />, title: '3D visualization', desc: 'Every unit rendered in place — rotate, select, inspect.' },
  { icon: <IconScan />, title: 'AI floor segmentation', desc: 'Floor plans segmented into units automatically.' },
  { icon: <IconTopology />, title: 'Topology validation', desc: 'Overlapping claims across the stack are flagged before registry.' },
  { icon: <IconChain />, title: 'Ownership ledger', desc: 'Hash-chained history for every unit, tamper-evident by design.' },
]

const NODES = [
  { name: 'Frontend', items: ['React', 'Three.js', 'MapLibre'] },
  { name: 'Backend', items: ['FastAPI', 'Python'] },
  { name: 'Records', items: ['PostGIS', 'Hash-chained ledger', 'NGDRS export'] },
]
function PillPrimary({ children, onClick, href }) {
  const cls = 'rounded-full bg-white text-black text-[13px] font-medium px-6 py-3 cursor-pointer inline-block select-none'
  const mp = { whileHover: { scale: 1.04 }, whileTap: { scale: 0.97 }, transition: { duration: 0.25, ease: EASE } }
  if (href) return <motion.a href={href} className={cls} {...mp}>{children}</motion.a>
  return <motion.button type="button" onClick={onClick} className={cls} {...mp}>{children}</motion.button>
}

function PillGhost({ children, href, onClick }) {
  const cls = 'rounded-full border border-white/[0.22] text-white text-[13px] font-medium px-6 py-3 cursor-pointer inline-block select-none hover:border-white/60 transition-colors duration-300'
  const mp = { whileHover: { scale: 1.04 }, whileTap: { scale: 0.97 }, transition: { duration: 0.25, ease: EASE } }
  if (href) return <motion.a href={href} className={cls} {...mp}>{children}</motion.a>
  return <motion.button type="button" onClick={onClick} className={cls} {...mp}>{children}</motion.button>
}

function Nav({ onEnter }) {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between h-14 px-6 md:px-10 bg-black/55 backdrop-blur-xl border-b border-white/[0.06]">
      <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-white">
        <CubeMark /> Layerd
      </span>
      <div className="hidden md:flex items-center gap-9 text-[12px] text-[#86868B]">
        {NAV_LINKS.map(([label, href]) => (
          <a key={href} href={href} className="hover:text-white transition-colors duration-300">{label}</a>
        ))}
      </div>
      <PillPrimary onClick={() => onEnter('citizen')}>Launch demo</PillPrimary>
    </nav>
  )
}
function Hero({ onEnter }) {
  return (
    <header className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <div className="hero-halo" />
      <div className="hero-globe" aria-hidden="true"><HeroGlobe /></div>
      <motion.div
        className="relative z-10 flex flex-col items-center text-center px-6 pt-16"
        initial={{ opacity: 0, y: 26 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, ease: EASE, delay: 0.15 }}
      >
        <p className="text-[11px] tracking-[0.24em] uppercase text-[#86868B]">SIH26095 · Smart India Hackathon 2026</p>
        <h1 className="mt-6 text-[clamp(52px,8.5vw,110px)] leading-[1.01] font-bold tracking-[-0.04em] text-white">
          One Parcel.<br />Every Dimension.
        </h1>
        <p className="mt-7 max-w-[640px] text-[#A1A1A6] text-[17px] md:text-[19px] leading-[1.65]">
          Layerd is a 3D cadastral system that generates unique spatial IDs for surface land
          parcels, multi-storey apartment units, and the infrastructure beneath them.
        </p>
        <div className="mt-11 flex gap-4 flex-wrap justify-center">
          <PillPrimary onClick={() => onEnter('citizen')}>Launch the demo</PillPrimary>
          <PillGhost href="#problem">Explore the system</PillGhost>
        </div>
        <p className="mt-9 text-[11px] tracking-[0.08em] text-[#86868B] font-mono">TN-02-6001-2345-6789 · G+4 · B1 · 15 units</p>
      </motion.div>
      <div className="absolute bottom-9 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-3">
        <span className="text-[10px] tracking-[0.24em] uppercase text-[#86868B]">Scroll</span>
        <div className="scroll-cue" />
      </div>
    </header>
  )
}
function StatsBand() {
  return (
    <section className="border-y border-white/[0.07] bg-[#050505]">
      <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 px-6">
        {STATS.map((s) => (
          <div key={s.label} className="py-14 text-center">
            <div className="text-[40px] md:text-[44px] font-bold tracking-[-0.03em] text-white leading-none">
              <Counter to={s.to} suffix={s.suffix} />
            </div>
            <div className="mt-2 text-[12.5px] text-[#86868B]">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function SectionHead({ eyebrow, title, sub }) {
  return (
    <Reveal className="text-center px-6">
      <p className="text-[11px] tracking-[0.24em] uppercase text-[#86868B]">{eyebrow}</p>
      <h2 className="mt-5 text-[clamp(32px,4.5vw,56px)] leading-[1.06] font-bold tracking-[-0.03em] text-white max-w-[24ch] mx-auto">{title}</h2>
      {sub && <p className="mt-6 text-[#A1A1A6] text-[15.5px] md:text-[17px] leading-[1.7] max-w-[58ch] mx-auto">{sub}</p>}
    </Reveal>
  )
}

const LEVELS = [-2, -1, 0, 1, 2, 3]

function Plate({ lvl, gap }) {
  const z = useTransform(gap, (g) => lvl * 44 * g)
  const size = 210 - Math.max(0, lvl) * 5
  return (
    <motion.div
      className={`plate ${lvl < 0 ? 'underground' : ''}`}
      style={{ width: size, height: size, x: '-50%', y: '-50%', z }}
    />
  )
}

function ProblemPin() {
  const ref = useRef(null)
  const landRef = useContext(LandCtx)
  // the app scrolls inside the .land container, not the window
  const { scrollYProgress } = useScroll({
    container: landRef,
    target: ref,
    offset: ['start start', 'end end'],
    layoutEffect: false,
  })
  const rotateX = useTransform(scrollYProgress, [0.1, 0.65], [0, 57])
  const rotateZ = useTransform(scrollYProgress, [0.1, 0.65], [0, -38])
  const gap = useTransform(scrollYProgress, [0.25, 0.85], [0, 1])
  const op2d = useTransform(scrollYProgress, [0.05, 0.25], [1, 0])
  const op3d = useTransform(scrollYProgress, [0.55, 0.8], [0, 1])
  return (
    <section id="problem" ref={ref} className="pin-stage">
      <div className="pin-viewport">
        <div className="absolute top-[12%] left-0 right-0">
          <SectionHead
            eyebrow="The problem"
            title="Ownership no longer fits on a flat map."
            sub="One urban footprint can hold a basement, twenty apartments and rooftop air-rights. A 2D cadastre gives them all the same polygon."
          />
        </div>
        <div className="plates">
          <motion.div className="w-full h-full" style={{ transformStyle: 'preserve-3d', rotateX, rotateZ }}>
            {LEVELS.map((lvl) => (
              <Plate key={lvl} lvl={lvl} gap={gap} />
            ))}
          </motion.div>
        </div>
        <div className="absolute bottom-[9%] left-0 right-0 h-4 text-center text-[11.5px] tracking-[0.2em] uppercase">
          <motion.span className="absolute inset-x-0 text-[#86868B]" style={{ opacity: op2d }}>2D parcel · one polygon</motion.span>
          <motion.span className="absolute inset-x-0 text-[#E8E8E8]" style={{ opacity: op3d }}>3D stack · every unit addressed</motion.span>
        </div>
      </div>
    </section>
  )
}
function Solution() {
  return (
    <section id="system" className="max-w-6xl mx-auto px-6 py-32 md:py-44">
      <SectionHead eyebrow="The system" title="From footprint to unique ID in four steps." />
      <div className="mt-16 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {STEPS.map((s, i) => (
          <Reveal key={s.title} delay={i * 0.08} className="h-full">
            <motion.div
              whileHover={{ y: -5 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="h-full rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-7 hover:border-white/[0.18] hover:bg-white/[0.035] transition-colors duration-300"
            >
              <div className="flex items-center justify-between">
                {s.icon}
                <span className="text-[11px] font-mono text-[#86868B]">0{i + 1}</span>
              </div>
              <h3 className="mt-6 text-[15px] font-semibold text-white">{s.title}</h3>
              <p className="mt-2 text-[13.5px] leading-[1.65] text-[#A1A1A6]">{s.desc}</p>
            </motion.div>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

function Features() {
  return (
    <section id="features" className="max-w-6xl mx-auto px-6 pb-32 md:pb-44">
      <SectionHead eyebrow="Key features" title="Built for the whole records workflow." />
      <div className="mt-16 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={i * 0.08} className="h-full">
            <motion.div
              whileHover={{ y: -5 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="h-full rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-7 hover:border-white/[0.18] hover:bg-white/[0.035] transition-colors duration-300"
            >
              {f.icon}
              <h3 className="mt-6 text-[15px] font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-[13.5px] leading-[1.65] text-[#A1A1A6]">{f.desc}</p>
            </motion.div>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

function Architecture() {
  return (
    <section id="architecture" className="max-w-5xl mx-auto px-6 pb-32 md:pb-44">
      <SectionHead
        eyebrow="Architecture"
        title="Thin layers. Clean boundaries."
        sub="A stateless API between the 3D client and the records layer — every mutation is validated, then chained."
      />
      <Reveal>
        <div className="mt-16 flex flex-col md:flex-row items-stretch md:items-center justify-center gap-5 md:gap-0">
          {NODES.map((n, i) => (
            <React.Fragment key={n.name}>
              {i > 0 && (
                <div className="hidden md:block w-20 h-px self-center bg-gradient-to-r from-white/5 via-white/30 to-white/5" />
              )}
              <div className="rounded-[18px] border border-white/[0.08] bg-white/[0.02] px-8 py-7 text-center min-w-[230px] w-fit mx-auto md:mx-0">
                <div className="text-[13px] font-semibold tracking-[0.08em] uppercase text-white">{n.name}</div>
                <div className="mt-3 flex flex-col gap-1.5 font-mono text-[11.5px] text-[#86868B]">
                  {n.items.map((it) => <span key={it}>{it}</span>)}
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>
      </Reveal>
    </section>
  )
}

function FooterCta({ onEnter }) {
  return (
    <footer className="px-6 pb-10">
      <div className="silver-line" />
      <div className="max-w-3xl mx-auto text-center py-28 md:py-36">
        <Reveal>
          <h2 className="text-[clamp(30px,4.5vw,54px)] font-bold tracking-[-0.03em] text-white leading-[1.08]">
            Ownership, in every dimension.
          </h2>
          <p className="mt-6 text-[#86868B] text-[15px] leading-[1.7]">
            Layerd — built for SIH26095. Seed data from real OpenStreetMap footprints in Adyar, Chennai.
          </p>
          <div className="mt-10 flex gap-4 justify-center flex-wrap">
            <PillPrimary onClick={() => onEnter('citizen')}>Launch the demo</PillPrimary>
            <PillGhost href="https://github.com/">GitHub</PillGhost>
          </div>
        </Reveal>
      </div>
      <div className="silver-line" />
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 pt-6 text-[11px] text-[#86868B]">
        <span>Team Layerd</span>
        <span className="font-mono">SIH26095 · 3D ULPIN</span>
        <a href="https://github.com/" className="hover:text-white transition-colors duration-300">GitHub</a>
      </div>
    </footer>
  )
}

export default function Landing({ onEnter }) {
  const landRef = useRef(null)
  return (
    <LandCtx.Provider value={landRef}>
      <div className="land" ref={landRef}>
        <Nav onEnter={onEnter} />
        <Hero onEnter={onEnter} />
        <StatsBand />
        <ProblemPin />
        <Solution />
        <Features />
        <Architecture />
        <FooterCta onEnter={onEnter} />
      </div>
    </LandCtx.Provider>
  )
}
