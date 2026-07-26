import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { clearCryptoCache, isEncryptedPayload, legacyDecryptOccurred, open, seal } from '@/composables/useCryptoVault'

/** 认证方式 */
export type AuthType = 'global' | 'token'

/** 一个 Cloudflare 账号凭据（内存态：明文，便于 API 调用直接读取） */
export interface Account {
  /** 本地账号记录 id */
  id: string
  /** Cloudflare 账户 ID（account 维度 API 调用前缀，如 Workers/KV/R2/D1） */
  accountId: string
  /** Cloudflare 账户名称（展示用） */
  accountName: string
  nickname: string
  authType: AuthType
  /** global 模式必填邮箱；token 模式不需要 */
  email?: string
  /** global 模式为 Global API Key；token 模式为 API Token */
  apiKey: string
  addedAt: number
  /** 密文解密失败标记：apiKey 为空占位，需用户重新录入凭据（持久化时原样保留旧密文） */
  corrupted?: boolean
}

/**
 * 持久化形态：敏感字段（apiKey / email）为 AES-GCM 密文（'enc:' 前缀），
 * 其余字段明文。迁移期兼容旧明文数据（无 'enc:' 前缀按明文读取后重新加密）。
 */
interface StoredAccount
  extends Omit<Account, 'apiKey' | 'email'> {
  apiKey: string
  email?: string
}

const STORAGE_KEY = 'cf_accounts'
const CURRENT_KEY = 'cf_current_account_id'
/** cf_accounts 非法（JSON 损坏/非数组）时的原始字符串备份 key，避免直接丢数据 */
const CORRUPT_BACKUP_KEY = 'cf_accounts_corrupt_backup'

function genId(): string {
  return `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * corrupted 账号的原始密文暂存（内存态 apiKey 已置空占位）：
 * 持久化时原样回写，防止用空串重新加密覆盖销毁原密文。
 */
const corruptCiphertexts = new Map<string, { apiKey: string; email?: string }>()

/** 从 localStorage 读取密文形态账号并解密为内存态明文 */
async function loadAccounts(): Promise<Account[]> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  let stored: StoredAccount[]
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('cf_accounts 非数组')
    stored = parsed as StoredAccount[]
  } catch {
    // 数据损坏：备份原始字符串后清空，避免每次启动都白屏/丢数据
    try {
      localStorage.setItem(CORRUPT_BACKUP_KEY, raw)
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* 存储异常时放弃备份 */
    }
    return []
  }
  const accounts: Account[] = []
  let needReMigrate = false
  for (const s of stored) {
    const apiKey = await open<string>(s.apiKey)
    const email = s.email != null ? await open<string>(s.email) : undefined
    // 旧明文数据：open 返回原值但非 'enc:' 前缀，标记需重新加密持久化
    if (s.apiKey && !isEncryptedPayload(s.apiKey)) needReMigrate = true
    if (s.email && !isEncryptedPayload(s.email)) needReMigrate = true
    // 解密失败（密钥不匹配/密文损坏）：标记 corrupted，暂存原密文防覆盖，等待用户重录
    const apiKeyBroken = apiKey === null && isEncryptedPayload(s.apiKey)
    const emailBroken = email === null && s.email != null && isEncryptedPayload(s.email)
    const corrupted = apiKeyBroken || emailBroken
    if (corrupted) {
      corruptCiphertexts.set(s.id, { apiKey: s.apiKey, email: s.email })
    }
    accounts.push({
      ...s,
      apiKey: apiKey ?? '',
      email: email ?? undefined,
      corrupted: corrupted || undefined,
    })
  }
  // 旧明文数据 / 旧指纹密钥解密成功：触发一次重新加密持久化（走串行队列）
  if ((needReMigrate || legacyDecryptOccurred()) && accounts.length) {
    void schedulePersist(accounts)
  }
  return accounts
}

/** 持久化快照元素：corrupted 账号在调度时即固化旧密文，执行期不再查实时 Map */
type PersistSnapshot = Account & {
  /** 内部字段：corrupted 账号的旧密文（调度时固化），不落盘 */
  _frozenCipher?: { apiKey: string; email?: string }
}

/** 把快照内明文账号加密后写回 localStorage（corrupted 账号原样回写固化的旧密文） */
async function persistAccounts(accounts: PersistSnapshot[]): Promise<void> {
  const stored: StoredAccount[] = []
  for (const a of accounts) {
    const { _frozenCipher, ...rest } = a
    // corrupted 账号：跳过重新加密，回写快照固化的旧密文，防止空串覆盖销毁
    if (rest.corrupted && _frozenCipher) {
      stored.push({ ...rest, apiKey: _frozenCipher.apiKey, email: _frozenCipher.email })
      continue
    }
    stored.push({
      ...rest,
      apiKey: await seal(rest.apiKey),
      email: rest.email != null ? await seal(rest.email) : undefined,
    })
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
}

/** 持久化串行队列：避免并发写入交错 */
let persistQueue: Promise<void> = Promise.resolve()

/**
 * 调度一次持久化：入口先做普通对象快照（避免 await 期间响应式数组被改写出
 * 不一致快照），corrupted 账号旧密文也在此刻固化进快照（旧快照执行时 Map 条目
 * 可能已被删，实时查会写入空串销毁原密文），再排入串行队列；失败时 toast 提示而非静默。
 */
function schedulePersist(accounts: Account[]): Promise<void> {
  const snapshot: PersistSnapshot[] = accounts.map((a) => ({
    ...a,
    _frozenCipher: a.corrupted ? corruptCiphertexts.get(a.id) : undefined,
  }))
  persistQueue = persistQueue
    .then(() => persistAccounts(snapshot))
    .catch((e) => {
      // QuotaExceeded / 存储禁用等：提示用户，内存态不受影响
      toast.error('账号凭据保存失败', {
        description: e instanceof Error ? e.message : String(e),
      })
    })
  return persistQueue
}

export const useAuthStore = defineStore('auth', () => {
  const accounts = ref<Account[]>([])
  const currentAccountId = ref<string | null>(localStorage.getItem(CURRENT_KEY))

  // 异步初始化：从 localStorage 解密加载（无论成败 ready 最终必须置 true，否则路由守卫死等）
  const ready = ref(false)
  loadAccounts()
    .then((loaded) => {
      accounts.value = loaded
      // 若当前账号 id 失效，回退到首个
      if (currentAccountId.value && !loaded.some((a) => a.id === currentAccountId.value)) {
        currentAccountId.value = loaded[0]?.id ?? null
      } else if (!currentAccountId.value && loaded.length) {
        currentAccountId.value = loaded[0]?.id ?? null
      }
    })
    .catch(() => {
      accounts.value = []
    })
    .finally(() => {
      ready.value = true
    })

  const currentAccount = computed<Account | null>(
    () => accounts.value.find((a) => a.id === currentAccountId.value) ?? null,
  )

  const isAuthed = computed(() => currentAccount.value !== null)

  // 持久化：加密后写回（deep watch，跳过初始化未就绪阶段避免覆盖；串行队列防交错）
  watch(
    accounts,
    (v) => {
      if (ready.value) void schedulePersist(v)
    },
    { deep: true },
  )

  watch(currentAccountId, (v) => {
    if (v) localStorage.setItem(CURRENT_KEY, v)
    else localStorage.removeItem(CURRENT_KEY)
  })

  function addAccount(payload: Omit<Account, 'id' | 'addedAt'>): Account {
    // 去重：同 accountId + authType 视为同一账号，更新凭据并切换过去，而非重复 push
    const existing = accounts.value.find(
      (a) => a.accountId === payload.accountId && a.authType === payload.authType,
    )
    if (existing) {
      updateAccount(existing.id, {
        accountName: payload.accountName,
        // 不覆盖用户已自定义的昵称：仅原昵称为空时才写入传入值
        ...(existing.nickname ? {} : { nickname: payload.nickname }),
        email: payload.email,
        apiKey: payload.apiKey,
      })
      currentAccountId.value = existing.id
      return accounts.value.find((a) => a.id === existing.id)!
    }
    const acc: Account = { ...payload, id: genId(), addedAt: Date.now() }
    accounts.value.push(acc)
    currentAccountId.value = acc.id
    return acc
  }

  function removeAccount(id: string) {
    accounts.value = accounts.value.filter((a) => a.id !== id)
    corruptCiphertexts.delete(id)
    if (currentAccountId.value === id) {
      currentAccountId.value = accounts.value[0]?.id ?? null
    }
  }

  function switchAccount(id: string) {
    if (accounts.value.some((a) => a.id === id)) currentAccountId.value = id
  }

  function updateAccount(id: string, patch: Partial<Account>) {
    const idx = accounts.value.findIndex((a) => a.id === id)
    if (idx === -1) return
    const next = { ...accounts.value[idx], ...patch }
    // 重填有效 apiKey 后解除损坏标记，并丢弃暂存的旧密文
    if (patch.apiKey) {
      delete next.corrupted
      corruptCiphertexts.delete(id)
    }
    accounts.value[idx] = next
  }

  function logout() {
    currentAccountId.value = null
  }

  /** 清除所有账号（凭据全清） */
  function clearAll() {
    accounts.value = []
    currentAccountId.value = null
    corruptCiphertexts.clear()
    clearCryptoCache()
  }

  return {
    accounts,
    currentAccountId,
    currentAccount,
    isAuthed,
    ready,
    addAccount,
    removeAccount,
    switchAccount,
    updateAccount,
    logout,
    clearAll,
  }
})
