import { useAuthStore } from '@/stores/auth'
import type { CFResponse, ResultInfo } from '@/types/cloudflare'

/**
 * Cloudflare API 客户端。
 *
 * 同源透传：所有请求发往 /api/cf/client/v4/...
 * - 本地开发：由 vite.config.ts 的 server.proxy 透传到 https://api.cloudflare.com
 * - 生产环境：由 Cloudflare Pages Functions（functions/api/cf）同源透传
 *
 * 认证凭据始终由浏览器持有（存 localStorage），随请求头透传，不在任何服务端落盘。
 */
const BASE = '/api/cf/client/v4'

export class CFError extends Error {
  code?: number
  status?: number
  constructor(message: string, code?: number, status?: number) {
    super(message)
    this.name = 'CFError'
    this.code = code
    this.status = status
  }
}

/** 构造认证头：Global API Key 用 X-Auth-Email/X-Auth-Key；API Token 用 Bearer */
export function authHeaders(): Record<string, string> {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new CFError('未登录 Cloudflare 账号', 401)
  if (acc.authType === 'token') return { Authorization: `Bearer ${acc.apiKey}` }
  if (!acc.email) throw new CFError('Global API Key 模式缺少邮箱，请到设置中补全该账号的邮箱', 401)
  return { 'X-Auth-Email': acc.email, 'X-Auth-Key': acc.apiKey }
}

export interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  /** 不带认证头（用于公开端点） */
  noAuth?: boolean
}

async function requestWithInfo<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<{ result: T; resultInfo?: ResultInfo }> {
  const url = new URL(BASE + path, globalThis.location.origin)
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!opts.noAuth) Object.assign(headers, authHeaders())

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch (e) {
    throw new CFError(
      `网络请求失败：${e instanceof Error ? e.message : String(e)}（请确认同源代理 /api/cf 可达）`,
    )
  }

  const text = await res.text()
  let data: CFResponse<T>
  try {
    data = JSON.parse(text) as CFResponse<T>
  } catch {
    throw new CFError(`响应解析失败（HTTP ${res.status}）`, undefined, res.status)
  }

  if (!res.ok || !data.success) {
    const msg = data.errors?.[0]?.message ?? `HTTP ${res.status}`
    throw new CFError(msg, data.errors?.[0]?.code, res.status)
  }
  return { result: data.result as T, resultInfo: data.result_info }
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { result } = await requestWithInfo<T>(method, path, opts)
  return result
}

/**
 * GET 列表端点并自动翻完所有页，返回聚合后的全量数组。
 *
 * - 优先按 result_info.total_pages 判断是否还有下一页；
 * - 端点不返回 result_info 时，以「本页条数 == per_page」作为可能有下一页的启发式；
 * - maxPages 为安全上限，防止异常端点导致无限翻页。
 */
export async function listAll<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined | null> = {},
  opts: { perPage?: number; maxPages?: number } = {},
): Promise<T[]> {
  const perPage = opts.perPage ?? 50
  const maxPages = opts.maxPages ?? 50
  const all: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const { result, resultInfo } = await requestWithInfo<T[] | null>('GET', path, {
      params: { ...params, page, per_page: perPage },
    })
    const items = result ?? []
    all.push(...items)
    const totalPages = resultInfo?.total_pages
    if (totalPages != null) {
      if (page >= totalPages) break
    } else if (items.length < perPage) {
      break
    }
  }
  return all
}

export const http = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, opts?: RequestOptions) => request<T>('POST', path, opts),
  put: <T>(path: string, opts?: RequestOptions) => request<T>('PUT', path, opts),
  patch: <T>(path: string, opts?: RequestOptions) => request<T>('PATCH', path, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
}

/** GraphQL Analytics 响应结构：{ data, errors }（非 REST 的 { result, success } 壳） */
interface GraphQLResponse<T> {
  data: T | null
  errors?: { code?: number; message: string }[]
}

/**
 * GraphQL Analytics 端点（POST 文本 query）。
 * 注意：CF 的 /graphql 端点返回标准 GraphQL { data, errors } 结构，
 * 与 REST v4 的 { result, success, errors } 不同，故单独解析。
 */
export async function graphql<T>(query: string): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders(),
  }
  let res: Response
  try {
    res = await fetch(new URL('/api/cf/client/v4/graphql', globalThis.location.origin), {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    })
  } catch (e) {
    throw new CFError(
      `网络请求失败：${e instanceof Error ? e.message : String(e)}（请确认同源代理 /api/cf 可达）`,
    )
  }
  let data: GraphQLResponse<T>
  try {
    data = (await res.json()) as GraphQLResponse<T>
  } catch {
    throw new CFError(`GraphQL 响应解析失败（HTTP ${res.status}）`, undefined, res.status)
  }
  if (!res.ok || (data.errors && data.errors.length)) {
    const msg = data.errors?.[0]?.message ?? `HTTP ${res.status}`
    throw new CFError(msg, data.errors?.[0]?.code, res.status)
  }
  if (!data.data) throw new CFError('GraphQL 返回空 data', undefined, res.status)
  return data.data
}
