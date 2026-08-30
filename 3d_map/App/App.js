import React, { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { StatusBar as ExpoStatusBar } from 'expo-status-bar'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { api, getBase, loadBase, saveBase } from './api'

const DEFAULT_IP = '172.16.98.188' // this PC's Wi-Fi address
const FH = 3 // storey height used by the generator (m)

const ROLES = [
  { id: 'citizen', title: 'Citizen', username: 'ramesh', password: 'citizen123' },
  { id: 'surveyor', title: 'Surveyor', username: 'priya', password: 'survey123' },
  { id: 'registrar', title: 'Registrar', username: 'arun', password: 'register123' },
]

export default function App() {
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState(null)
  const [screen, setScreen] = useState('login') // login | home | units
  const [selBuilding, setSelBuilding] = useState(null)
  const [ip, setIp] = useState(DEFAULT_IP)

  useEffect(() => {
    ;(async () => {
      const storedBase = await loadBase()
      if (storedBase) {
        const m = storedBase.match(/http:\/\/([^:/]+)/)
        if (m) setIp(m[1])
      }
      const storedSession = await AsyncStorage.getItem('@session')
      if (storedBase && storedSession) {
        setSession(JSON.parse(storedSession))
        setScreen('home')
      }
      setReady(true)
    })()
  }, [])

  const login = (s) => {
    setSession(s)
    setScreen('home')
  }

  const logout = async () => {
    await AsyncStorage.removeItem('@session')
    setSession(null)
    setScreen('login')
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ExpoStatusBar style="light" />
        <ActivityIndicator color="#4da3ff" />
      </View>
    )
  }
  if (!session) {
    return <LoginScreen ip={ip} setIp={setIp} onLogin={login} />
  }
  if (screen === 'units' && selBuilding) {
    return (
      <UnitsScreen
        session={session}
        building={selBuilding}
        onBack={() => {
          setSelBuilding(null)
          setScreen('home')
        }}
      />
    )
  }
  return (
    <HomeScreen
      session={session}
      onLogout={logout}
      openUnits={(b) => {
        setSelBuilding(b)
        setScreen('units')
      }}
    />
  )
}

function LoginScreen({ ip, setIp, onLogin }) {
  const [role, setRole] = useState(ROLES[0])
  const [username, setUsername] = useState(ROLES[0].username)
  const [password, setPassword] = useState(ROLES[0].password)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const pick = (r) => {
    setRole(r)
    setUsername(r.username)
    setPassword(r.password)
    setError(null)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await saveBase(`http://${ip.trim()}:8000/api`)
      const s = await api('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, role: role.id }),
      })
      onLogin(s)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ExpoStatusBar style="light" />
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>Layerd</Text>
        <Text style={styles.sub}>3D cadastral system · SIH26095</Text>

        <Text style={styles.label}>PC ADDRESS (SAME WI-FI)</Text>
        <TextInput style={styles.input} value={ip} onChangeText={setIp} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        <Text style={styles.hint}>backend: http://{ip.trim()}:8000/api</Text>

        <Text style={styles.label}>ROLE</Text>
        {ROLES.map((r) => (
          <Pressable
            key={r.id}
            style={[styles.role, role.id === r.id && styles.roleActive]}
            onPress={() => pick(r)}
          >
            <Text style={styles.roleTitle}>{r.title}</Text>
          </Pressable>
        ))}

        <Text style={styles.label}>USERNAME</Text>
        <TextInput style={styles.input} value={username} onChangeText={(t) => { setUsername(t); setError(null) }} autoCapitalize="none" />
        <Text style={styles.label}>PASSWORD</Text>
        <TextInput style={styles.input} value={password} onChangeText={(t) => { setPassword(t); setError(null) }} secureTextEntry />

        {error && <Text style={styles.error}>⚠ {error}</Text>}

        <Pressable style={[styles.btn, (busy || !username || !password) && styles.btnDisabled]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#000" /> : <Text style={styles.btnText}>sign in as {role.title.toLowerCase()}</Text>}
        </Pressable>
        <Text style={styles.hint}>demo credentials pre-filled per role</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

function HomeScreen({ session, onLogout, openUnits }) {
  const [sessions, setSessions] = useState([])
  const [buildings, setBuildings] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setRefreshing(true)
    setErr(null)
    Promise.all([api('/lidar/sessions'), api('/lidar/buildings')])
      .then(([ss, fc]) => {
        setSessions(ss)
        setBuildings(fc.features || [])
      })
      .catch((e) => setErr(e.message))
      .finally(() => setRefreshing(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <SafeAreaView style={styles.screen}>
      <ExpoStatusBar style="light" />
      <View style={styles.topbar}>
        <View>
          <Text style={styles.h2}>Layerd</Text>
          <Text style={styles.sub}>{session.name} · {session.role}</Text>
        </View>
        <Pressable style={styles.btnGhost} onPress={onLogout}>
          <Text style={styles.btnGhostText}>log out</Text>
        </Pressable>
      </View>

      {sessions.length > 0 && (
        <View style={styles.sessionStrip}>
          {sessions.slice(0, 3).map((s) => (
            <Text key={s.session_id} style={styles.sessionChip} numberOfLines={1}>
              {s.label || s.session_id} · {s.buildings} bld
            </Text>
          ))}
          {sessions.length > 3 && <Text style={styles.sessionChip}>+{sessions.length - 3} more</Text>}
        </View>
      )}

      {err && <Text style={styles.error}>⚠ {err}</Text>}

      <FlatList
        data={buildings}
        keyExtractor={(f) => f.properties.building_id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor="#4da3ff" />}
        contentContainerStyle={styles.pad}
        ListHeaderComponent={<Text style={styles.label}>BUILDINGS ({buildings.length}) — TAP FOR ULPIN UNITS</Text>}
        renderItem={({ item }) => {
          const p = item.properties
          return (
            <Pressable style={styles.row} onPress={() => openUnits(item)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{p.name || p.building_id}</Text>
                <Text style={styles.rowMeta}>
                  {p.stories || 1} storeys{p.basements ? ` · ${p.basements} basements` : ''} · {p.height_m} m
                </Text>
              </View>
              <Text style={styles.arrow}>→</Text>
            </Pressable>
          )
        }}
      />
    </SafeAreaView>
  )
}

function UnitsScreen({ session, building, onBack }) {
  const canManage = session.role !== 'citizen'
  const bid = building.properties.building_id
  const [data, setData] = useState(null)
  const [floors, setFloors] = useState(String(building.properties.stories || 3))
  const [basements, setBasements] = useState(String(building.properties.basements || 0))
  const [fh, setFh] = useState('3')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [expanded, setExpanded] = useState(null)

  const load = useCallback(() => {
    api(`/lidar/units?building_id=${encodeURIComponent(bid)}`)
      .then(setData)
      .catch((e) => setErr(e.message))
  }, [bid])

  useEffect(() => {
    load()
  }, [load])

  const generate = () => {
    setBusy(true)
    setErr(null)
    const fd = new FormData()
    fd.append('building_id', bid)
    fd.append('floors', floors)
    fd.append('basements', basements)
    fd.append('floor_height', fh)
    api('/lidar/units/generate', { method: 'POST', body: fd })
      .then((r) => {
        setData(r)
        setBusy(false)
      })
      .catch((e) => {
        setErr(e.message)
        setBusy(false)
      })
  }

  const clear = () => {
    api(`/lidar/units?building_id=${encodeURIComponent(bid)}`, { method: 'DELETE' })
      .then(() => {
        setData({ ...data, units: [] })
        setExpanded(null)
      })
      .catch((e) => setErr(e.message))
  }

  const units = data?.units || []
  const byFloor = new Map()
  for (const u of units) {
    if (!byFloor.has(u.floor_index)) byFloor.set(u.floor_index, [])
    byFloor.get(u.floor_index).push(u)
  }
  const floorsSorted = [...byFloor.entries()].sort((a, b) => a[0] - b[0])

  return (
    <SafeAreaView style={styles.screen}>
      <ExpoStatusBar style="light" />
      <View style={styles.topbar}>
        <Pressable style={styles.btnGhost} onPress={onBack}>
          <Text style={styles.btnGhostText}>← map</Text>
        </Pressable>
        <Text style={styles.h2} numberOfLines={1}>{building.properties.name || bid}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.pad}>
        <Text style={styles.label}>BASE ULPIN</Text>
        <Text style={styles.ulpin}>{data?.units?.[0]?.base_ulpin || '—'}</Text>

        {canManage && (
          <>
            <Text style={styles.label}>FLOORS / BASEMENTS / FLOOR H (M)</Text>
            <View style={styles.triple}>
              <TextInput style={styles.input} value={floors} onChangeText={setFloors} keyboardType="number-pad" />
              <TextInput style={styles.input} value={basements} onChangeText={setBasements} keyboardType="number-pad" />
              <TextInput style={styles.input} value={fh} onChangeText={setFh} keyboardType="decimal-pad" />
            </View>
            <Pressable style={[styles.btn, busy && styles.btnDisabled]} onPress={generate} disabled={busy}>
              {busy ? <ActivityIndicator color="#000" /> : <Text style={styles.btnText}>generate / re-segment units</Text>}
            </Pressable>
            {units.length > 0 && (
              <Pressable style={styles.btnGhost} onPress={clear}>
                <Text style={styles.btnGhostText}>clear units</Text>
              </Pressable>
            )}
          </>
        )}

        {err && <Text style={styles.error}>⚠ {err}</Text>}

        {floorsSorted.map(([floor, us]) => (
          <View key={floor}>
            <Text style={styles.ulpinFloorHead}>
              {floor < 0 ? `basement ${-floor}` : `floor ${floor}`} ({us.length})
            </Text>
            {us.map((u) => (
              <View key={u.unit_ulpin}>
                <Pressable style={styles.row} onPress={() => setExpanded(expanded === u.unit_ulpin ? null : u.unit_ulpin)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{u.unit_ulpin}</Text>
                    <Text style={styles.rowMeta}>{u.owner_name} · {u.rights_type}</Text>
                  </View>
                  <Text style={styles.arrow}>{expanded === u.unit_ulpin ? '▾' : '→'}</Text>
                </Pressable>
                {expanded === u.unit_ulpin && (
                  <View style={styles.details}>
                    <Text style={styles.detailLine}>area: {u.area_sqm} m²</Text>
                    <Text style={styles.detailLine}>rights: {u.rights_type}</Text>
                    <Text style={styles.detailLine}>owner: {u.owner_name} ({u.owner_id})</Text>
                    <Text style={styles.detailLine}>status: {u.validation_status}</Text>
                    <Text style={styles.detailLine}>segmentation: {u.segmentation}</Text>
                  </View>
                )}
              </View>
            ))}
          </View>
        ))}
        {!floorsSorted.length && !err && <Text style={styles.hint}>no units yet — generate above.</Text>}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  pad: { padding: 16, paddingBottom: 40 },
  h1: { fontSize: 34, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  h2: { fontSize: 18, fontWeight: '700', color: '#fff', flex: 1 },
  sub: { fontSize: 12, color: '#a1a1a6', marginTop: 2 },
  label: { fontSize: 10.5, color: '#86868b', letterSpacing: 1.2, marginTop: 16, marginBottom: 6 },
  hint: { fontSize: 11, color: '#86868b', marginTop: 8 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    color: '#f5f5f7',
    padding: 11,
    fontSize: 14,
  },
  role: {
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    marginBottom: 6,
  },
  roleActive: { borderColor: '#4da3ff', backgroundColor: 'rgba(77,163,255,0.08)' },
  roleTitle: { color: '#f5f5f7', fontSize: 14, fontWeight: '600' },
  btn: {
    backgroundColor: '#ffffff',
    borderRadius: 999,
    padding: 13,
    alignItems: 'center',
    marginTop: 14,
  },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: '#000', fontWeight: '700', fontSize: 14 },
  btnGhost: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  btnGhostText: { color: '#f5f5f7', fontSize: 12 },
  btnDisabledGhost: { opacity: 0.4 },
  error: {
    color: '#fca5a5',
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderColor: 'rgba(239,68,68,0.4)',
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginTop: 10,
    fontSize: 12,
  },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  sessionStrip: { paddingHorizontal: 16, paddingTop: 10, gap: 4 },
  sessionChip: {
    color: '#86868b',
    fontSize: 11,
    fontFamily: 'monospace',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    marginBottom: 6,
  },
  rowTitle: { color: '#f5f5f7', fontSize: 14, fontWeight: '600' },
  rowMeta: { color: '#86868b', fontSize: 11.5, marginTop: 2 },
  arrow: { color: '#4da3ff', fontSize: 16 },
  ulpin: {
    color: '#4da3ff',
    fontSize: 15,
    fontFamily: 'monospace',
    backgroundColor: 'rgba(77,163,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(77,163,255,0.3)',
    borderRadius: 8,
    padding: 10,
  },
  triple: { flexDirection: 'row', gap: 8 },
  triple_input: {},
  ulpinFloorHead: {
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
    color: '#86868b',
    marginTop: 14,
    marginBottom: 6,
  },
  details: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  detailLine: { color: '#c7c7cc', fontSize: 12.5, marginBottom: 2 },
})



