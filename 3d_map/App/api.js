import AsyncStorage from '@react-native-async-storage/async-storage'

// base URL of the Layerd backend, e.g. http://192.168.1.20:8000/api
let BASE = null

export async function loadBase() {
  BASE = (await AsyncStorage.getItem('@baseUrl')) || null
  return BASE
}

export async function saveBase(url) {
  BASE = url.replace(/\/+$/, '')
  await AsyncStorage.setItem('@baseUrl', BASE)
}

export const getBase = () => BASE

export async function api(path, opts = {}) {
  if (!BASE) throw new Error('set the PC address first')
  const isForm = opts.body && typeof opts.body !== 'string'
  const res = await fetch(BASE + path, {
    ...opts,
    headers: isForm ? opts.headers || {} : { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      const d = body.detail ?? body.message ?? detail
      detail = typeof d === 'string'
        ? d
        : Array.isArray(d)
          ? d.map((e) => `${(e.loc || []).filter((p) => p !== 'body').join('.')}: ${e.msg}`).join('; ')
          : JSON.stringify(d)
    } catch {}
    throw new Error(detail)
  }
  return res.json()
}
