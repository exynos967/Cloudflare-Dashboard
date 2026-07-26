import { http, listAll } from './client'
import { useAuthStore } from '@/stores/auth'
import type { KVNamespace, KVKey } from '@/types/cloudflare'

const BASE = '/api/cf/client/v4'

/** 取当前账号的 Cloudflare account id */
function accountId(): string {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录')
  return acc.accountId
}

/** 构造认证头（与 client.ts 保持一致，但用于绕过 JSON 解析的文本请求） */
function authHeaders(): Record<string, string> {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录')
  if (acc.authType === 'token') return { Authorization: `Bearer ${acc.apiKey}` }
  return { 'X-Auth-Email': acc.email ?? '', 'X-Auth-Key': acc.apiKey }
}

async function readError(res: Response): Promise<string> {
  try {
    const d = (await res.json()) as { errors?: { message?: string }[] }
    return d.errors?.[0]?.message ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export const kvApi = {
  /** 列出账号下所有 KV 命名空间（CF 默认每页 20 条，自动翻页拉全量） */
  listNamespaces: () =>
    listAll<KVNamespace>(`/accounts/${accountId()}/storage/kv/namespaces`),

  /** 创建命名空间 */
  createNamespace: (title: string) =>
    http.post<KVNamespace>(`/accounts/${accountId()}/storage/kv/namespaces`, {
      body: { title },
    }),

  /** 删除命名空间 */
  deleteNamespace: (nsid: string) =>
    http.delete<unknown>(`/accounts/${accountId()}/storage/kv/namespaces/${nsid}`),

  /** 列出命名空间下所有 key（最多 1000） */
  listKeys: (nsid: string) =>
    http.get<KVKey[]>(`/accounts/${accountId()}/storage/kv/namespaces/${nsid}/keys`, {
      params: { limit: 1000 },
    }),

  /** 读取 key 的值（返回原始文本，绕过 http 的 JSON 解析） */
  getValue: async (nsid: string, key: string): Promise<string> => {
    const url = `${BASE}/accounts/${accountId()}/storage/kv/namespaces/${nsid}/values/${encodeURIComponent(key)}`
    const res = await fetch(url, { headers: authHeaders() })
    if (!res.ok) throw new Error(await readError(res))
    return res.text()
  },

  /** 写入 key 的值（text/plain，绕过 http 的 JSON 解析） */
  putValue: async (nsid: string, key: string, value: string, ttl?: number): Promise<void> => {
    const url = `${BASE}/accounts/${accountId()}/storage/kv/namespaces/${nsid}/values/${encodeURIComponent(key)}${ttl ? `?expiration_ttl=${ttl}` : ''}`
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'text/plain' },
      body: value,
    })
    if (!res.ok) throw new Error(await readError(res))
  },

  /** 删除 key */
  deleteKey: (nsid: string, key: string) =>
    http.delete<unknown>(
      `/accounts/${accountId()}/storage/kv/namespaces/${nsid}/values/${encodeURIComponent(key)}`,
    ),
}
