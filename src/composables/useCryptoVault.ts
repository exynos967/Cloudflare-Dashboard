/**
 * 凭据本地加密保险库 —— 基于 Web Crypto API 的 AES-GCM 对称加密。
 *
 * 安全模型：
 * - 敏感字段（apiKey / global 模式 email）以 AES-GCM-256 密文存 localStorage，
 *   非敏感字段（accountId/accountName/nickname/authType/addedAt）明文（展示需要）。
 * - 密钥派生：PBKDF2(SHA-256, 250000 轮) ← 随机设备密钥（32 字节，首次使用时
 *   crypto.getRandomValues 生成，base64 存 localStorage DEVICE_KEY）+ 持久化随机 salt。
 *   salt 随密文一起存 localStorage（SALT_KEY）。
 * - IV 每条密文独立随机，与密文一同存储。
 * - 历史版本曾用设备指纹（userAgent/屏幕尺寸等）派生密钥，但指纹随浏览器升级、
 *   分辨率变化而漂移，会导致解密失败、凭据静默损毁。现改为随机设备密钥（完全稳定），
 *   旧指纹派生仅保留用于一次性迁移解密。
 *
 * 强度边界（诚实声明）：
 * - 设备密钥本身存于 localStorage，可被同源 JS 读取，故本方案防的是"localStorage
 *   明文被肉眼/被第三方扩展批量读取/被存储同步到他人设备后直接可用"，而非本机定向
 *   XSS（任何前端加密方案都防不住同源 JS 在运行时取走已解密凭据）。
 * - 若需对抗本机 XSS，需改用用户主口令方案（密钥不落本地）。
 *
 * 无第三方依赖，纯浏览器原生 Web Crypto。
 */

const SALT_KEY = 'cf_vault_salt'
const DEVICE_KEY = 'cf_device_key'
const PBKDF2_ITERATIONS = 250_000
const SALT_BYTES = 16
const DEVICE_KEY_BYTES = 32
const IV_BYTES = 12
const KEY_BITS = 256

let cachedKey: CryptoKey | null = null
let cachedLegacyKey: CryptoKey | null = null
let cachedFingerprint: string | null = null
/** 本次会话是否用旧指纹密钥成功解密过（true 表示需用新设备密钥重新加密持久化） */
let legacyDecryptUsed = false

/**
 * 旧版设备指纹：仅保留用于迁移解密（指纹会随浏览器升级等漂移，不再用于新加密）。
 */
function deviceFingerprint(): string {
  if (cachedFingerprint) return cachedFingerprint
  const nav = globalThis.navigator
  const parts = [
    nav?.userAgent ?? '',
    nav?.language ?? '',
    String(nav?.hardwareConcurrency ?? ''),
    String(globalThis.screen?.width ?? ''),
    String(globalThis.screen?.height ?? ''),
    String(nav?.platform ?? ''),
    Intl?.DateTimeFormat().resolvedOptions().timeZone ?? '',
  ]
  cachedFingerprint = parts.join('|')
  return cachedFingerprint
}

/** Base64 ↔ ArrayBuffer */
function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n)
  crypto.getRandomValues(arr)
  return arr
}

/** 取或生成持久化 salt（首次使用时生成并存 localStorage；长度不符视为损坏重建） */
function getSalt(): Uint8Array {
  const existing = localStorage.getItem(SALT_KEY)
  if (existing) {
    try {
      const salt = b64ToBuf(existing)
      if (salt.length === SALT_BYTES) return salt
      // 长度不符视为损坏，落到重新生成
    } catch {
      // 损坏则重新生成
    }
  }
  const salt = randomBytes(SALT_BYTES)
  localStorage.setItem(SALT_KEY, bufToB64(salt))
  return salt
}

/** 取或生成随机设备密钥（32 字节，首次使用时生成并存 localStorage） */
function getDeviceKeyBytes(): Uint8Array {
  const existing = localStorage.getItem(DEVICE_KEY)
  if (existing) {
    try {
      const bytes = b64ToBuf(existing)
      if (bytes.length === DEVICE_KEY_BYTES) return bytes
      // 长度不符视为损坏，落到重新生成
    } catch {
      // 损坏则重新生成
    }
  }
  const key = randomBytes(DEVICE_KEY_BYTES)
  localStorage.setItem(DEVICE_KEY, bufToB64(key))
  return key
}

/** 从任意字节输入经 PBKDF2 派生 AES-GCM 密钥 */
async function deriveAesKey(input: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    input.buffer as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const salt = getSalt()
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 派生当前 AES-GCM 密钥（随机设备密钥；带缓存，避免每次解密都重跑 PBKDF2） */
async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  cachedKey = await deriveAesKey(getDeviceKeyBytes())
  return cachedKey
}

/** 派生旧指纹密钥（仅迁移解密用；带缓存） */
async function getLegacyKey(): Promise<CryptoKey> {
  if (cachedLegacyKey) return cachedLegacyKey
  cachedLegacyKey = await deriveAesKey(new TextEncoder().encode(deviceFingerprint()))
  return cachedLegacyKey
}

/** 加密明文字符串，返回 base64(iv + ciphertext) */
export async function encryptString(plain: string): Promise<string> {
  const key = await getKey()
  const iv = randomBytes(IV_BYTES)
  const data = new TextEncoder().encode(plain)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as BufferSource },
    key,
    data.buffer as BufferSource,
  )
  // iv 与密文拼合
  const merged = new Uint8Array(iv.length + ct.byteLength)
  merged.set(iv, 0)
  merged.set(new Uint8Array(ct), iv.length)
  return bufToB64(merged)
}

/** 拆分 base64(iv + ciphertext)，格式非法返回 null */
function splitPayload(payload: string): { iv: Uint8Array; ct: Uint8Array } | null {
  try {
    const merged = b64ToBuf(payload)
    if (merged.length < IV_BYTES + 1) return null
    return { iv: merged.slice(0, IV_BYTES), ct: merged.slice(IV_BYTES) }
  } catch {
    return null
  }
}

/**
 * 解密 encryptString 产出的 base64，失败返回 null（密钥不匹配/数据损坏）。
 * 先用当前设备密钥解密；失败则回退旧指纹密钥（迁移期），旧密钥解密成功时
 * 置迁移标记（由调用方重新加密持久化）。
 */
export async function decryptString(payload: string): Promise<string | null> {
  const parts = splitPayload(payload)
  if (!parts) return null
  const { iv, ct } = parts
  const decryptWith = async (key: CryptoKey): Promise<string> => {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as BufferSource },
      key,
      ct.buffer as BufferSource,
    )
    return new TextDecoder().decode(pt)
  }
  try {
    return await decryptWith(await getKey())
  } catch {
    // 设备密钥解不开：尝试旧指纹密钥（历史数据迁移）
  }
  try {
    const plain = await decryptWith(await getLegacyKey())
    legacyDecryptUsed = true
    return plain
  } catch {
    return null
  }
}

/** 本次会话是否发生过旧指纹密钥解密（需要用新设备密钥重新加密持久化） */
export function legacyDecryptOccurred(): boolean {
  return legacyDecryptUsed
}

/** 清除缓存的派生密钥（登出 / 凭据全清时调用，强制下次重新派生） */
export function clearCryptoCache(): void {
  cachedKey = null
  cachedLegacyKey = null
  cachedFingerprint = null
}

/** 标记密文格式（用于区分旧明文数据，迁移用） */
export function isEncryptedPayload(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('enc:')
}

/** 给密文加前缀标记，便于与明文区分 */
export async function seal(plain: string): Promise<string> {
  return 'enc:' + (await encryptString(plain))
}

/** 解封（去除前缀后解密），非密文格式原样返回（兼容迁移期） */
export async function open<T extends string | undefined>(payload: string | undefined): Promise<T | null> {
  if (payload == null) return null
  if (!isEncryptedPayload(payload)) return payload as T
  const plain = await decryptString(payload.slice(4))
  return (plain ?? null) as T | null
}
