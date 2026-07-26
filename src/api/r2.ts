import { http } from './client'
import { useAuthStore } from '@/stores/auth'
import type { R2Bucket, R2Object } from '@/types/cloudflare'

const BASE = '/api/cf/client/v4'

/** 取当前账号的 Cloudflare account id */
function accountId(): string {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录')
  return acc.accountId
}

/** 构造认证头：与 client.ts 保持一致（Global API Key / API Token） */
function authHeaders(): Record<string, string> {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录 Cloudflare 账号')
  if (acc.authType === 'token') return { Authorization: `Bearer ${acc.apiKey}` }
  return { 'X-Auth-Email': acc.email ?? '', 'X-Auth-Key': acc.apiKey }
}

export type R2Location = R2Bucket['location']

export const r2Api = {
  /** 列出账号下所有 R2 桶（CF 返回 result 为 { buckets: [...] } 对象，需解包） */
  listBuckets: async (): Promise<R2Bucket[]> => {
    const res = await http.get<{ buckets?: R2Bucket[] }>(`/accounts/${accountId()}/r2/buckets`)
    return res?.buckets ?? []
  },

  /** 创建桶（'auto' 不是 API 合法枚举，locationHint 为空或 'auto' 时省略该字段） */
  createBucket: (name: string, locationHint?: R2Location) =>
    http.post<R2Bucket>(`/accounts/${accountId()}/r2/buckets`, {
      body: locationHint && locationHint !== 'auto' ? { name, locationHint } : { name },
    }),

  /** 删除桶 */
  deleteBucket: (name: string) =>
    http.delete<void>(`/accounts/${accountId()}/r2/buckets/${encodeURIComponent(name)}`),

  /** 列出桶内对象（最多 1000 个） */
  listObjects: (name: string) =>
    http.get<R2Object[]>(
      `/accounts/${accountId()}/r2/buckets/${encodeURIComponent(name)}/objects`,
      { params: { per_page: 1000 } },
    ),

  /** 读取对象原始内容（绕过 http，直接 fetch 取 blob） */
  getObject: async (bucket: string, key: string): Promise<Blob> => {
    const res = await fetch(
      `${BASE}/accounts/${accountId()}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
      { headers: { ...authHeaders() } },
    )
    if (!res.ok) {
      const d = await res.json().catch(() => null)
      throw new Error(d?.errors?.[0]?.message ?? `下载失败（HTTP ${res.status}）`)
    }
    return res.blob()
  },

  /** 上传对象（二进制 ArrayBuffer，绕过 http） */
  putObject: async (bucket: string, key: string, file: ArrayBuffer): Promise<void> => {
    const res = await fetch(
      `${BASE}/accounts/${accountId()}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
        body: file,
      },
    )
    if (!res.ok) {
      const d = await res.json().catch(() => null)
      throw new Error(d?.errors?.[0]?.message ?? `上传失败（HTTP ${res.status}）`)
    }
  },

  /** 删除对象 */
  deleteObject: (bucket: string, key: string) =>
    http.delete<void>(
      `/accounts/${accountId()}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
    ),
}
