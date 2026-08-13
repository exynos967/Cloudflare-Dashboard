import { http, authHeaders, listAll, CFError } from './client'
import { useAuthStore } from '@/stores/auth'
import type { WorkerDomain, WorkerRoute, WorkersSubdomain } from '@/types/cloudflare'

const BASE = '/api/cf/client/v4'

/** 取当前账号的 Cloudflare account id（account 维度调用的前缀） */
function accountId(): string {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录')
  return acc.accountId
}

export interface WorkerScriptMeta {
  id: string
  etag: string
  modified_on: string
  created_on: string
  usage_model: string
  handlers: string[]
}

  /** GET /workers/scripts/{name}/settings 返回的既有脚本配置（部分字段） */
export interface WorkerBinding {
  type: string
  name?: string
  namespace_id?: string
  id?: string
  bucket_name?: string
  class_name?: string
  service?: string
  environment?: string
  text?: string
}

export interface WorkerScriptSettings {
  bindings?: WorkerBinding[] | null
  compatibility_date?: string | null
  compatibility_flags?: string[] | null
}

export interface WorkerSchedule {
  cron: string
  created_on?: string
}

export interface WorkerSecret {
  name: string
  type: string
}

export const workersApi = {
  /** 列出账号下所有 Worker 脚本元数据 */
  listScripts: () => http.get<WorkerScriptMeta[]>(`/accounts/${accountId()}/workers/scripts`),

  /** 读取脚本源码（返回纯文本） */
  getScriptContent: async (scriptName: string): Promise<string> => {
    const res = await fetch(
      `${BASE}/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}`,
      { headers: { ...authHeaders(), Accept: 'application/javascript' } },
    )
    if (!res.ok) throw new Error(`读取脚本失败（HTTP ${res.status}）`)
    return res.text()
  },

  /**
   * 上传/更新脚本（ES Module 格式）。
   *
   * CF Upload Worker Module 端点要求 multipart/form-data：
   *   - part `metadata`（application/json）：{ main_module, compatibility_date, ... }
   *   - part 名 = main_module 的值（application/javascript+module）：脚本源码
   * 顶层 Content-Type 由 FormData 自动设为 multipart/form-data，禁止手动指定。
   *
   * PUT 为全量替换：更新既有脚本前先读 settings，用 metadata.keep_bindings
   * （按 binding 的 type 列表保留，含 secret_text 等不回传明文的类型）保留全部
   * 既有 bindings，并回传原 compatibility_date / compatibility_flags，避免清空配置。
   */
  uploadScript: async (scriptName: string, script: string): Promise<void> => {
    const mainModule = 'worker.js'

    // 读取既有脚本配置；404 = 新脚本；其他错误直接抛出，避免误清空既有配置
    let settings: WorkerScriptSettings | null = null
    try {
      settings = await http.get<WorkerScriptSettings>(
        `/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
      )
    } catch (e) {
      if (!(e instanceof CFError && e.status === 404)) throw e
    }

    const metadata: Record<string, unknown> = { main_module: mainModule }
    if (settings) {
      const keepTypes = [...new Set((settings.bindings ?? []).map((b) => b.type))]
      if (keepTypes.length) metadata.keep_bindings = keepTypes
      if (settings.compatibility_date) metadata.compatibility_date = settings.compatibility_date
      if (settings.compatibility_flags?.length) metadata.compatibility_flags = settings.compatibility_flags
    } else {
      // 新脚本才使用默认 compatibility_date
      metadata.compatibility_date = '2024-11-01'
    }

    const form = new FormData()
    form.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    )
    // CF 用 part 的 filename（非 field name）识别 module，必须显式传 filename
    form.append(
      mainModule,
      new Blob([script], { type: 'application/javascript+module' }),
      mainModule,
    )
    const res = await fetch(
      `${BASE}/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}`,
      {
        method: 'PUT',
        headers: authHeaders(),
        body: form,
      },
    )
    if (!res.ok) {
      const d = await res.json().catch(() => null)
      throw new Error(d?.errors?.[0]?.message ?? `上传失败（HTTP ${res.status}）`)
    }
  },

  deleteScript: (scriptName: string) =>
    http.delete<void>(`/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}`),

  /* ---------- workers.dev 子域 ---------- */

  getSubdomain: () => http.get<WorkersSubdomain>(`/accounts/${accountId()}/workers/subdomain`),

  getSubdomainStatus: (scriptName: string) =>
    http.get<{ enabled: boolean }>(`/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`),

  setSubdomainStatus: (scriptName: string, enabled: boolean) =>
    http.post<unknown>(`/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`, {
      body: { enabled },
    }),

  /* ---------- 路由（zone 维度） ---------- */

  listRoutes: (zoneId: string) => http.get<WorkerRoute[]>(`/zones/${zoneId}/workers/routes`),

  createRoute: (zoneId: string, pattern: string, script: string) =>
    http.post<WorkerRoute>(`/zones/${zoneId}/workers/routes`, { body: { pattern, script } }),

  deleteRoute: (zoneId: string, routeId: string) =>
    http.delete<WorkerRoute>(`/zones/${zoneId}/workers/routes/${routeId}`),

  /* ---------- 自定义域（account 维度） ---------- */

  listDomains: () => listAll<WorkerDomain>(`/accounts/${accountId()}/workers/domains`),

  // Attach to Domain 端点是 PUT（POST 会 405）
  createDomain: (data: { hostname: string; service: string; environment?: string; zone_id: string }) =>
    http.put<WorkerDomain>(`/accounts/${accountId()}/workers/domains`, {
      body: { environment: 'production', ...data },
    }),

  deleteDomain: (domainId: string) =>
    http.delete<WorkerDomain>(`/accounts/${accountId()}/workers/domains/${domainId}`),

  /* ---------- settings / cron / secrets ---------- */

  getSettings: (scriptName: string) =>
    http.get<WorkerScriptSettings>(
      `/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
    ),

  getSchedules: async (scriptName: string): Promise<WorkerSchedule[]> => {
    const res = await http.get<{ schedules?: WorkerSchedule[] } | WorkerSchedule[]>(
      `/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    )
    if (Array.isArray(res)) return res
    return res?.schedules ?? []
  },

  /**
   * PUT 替换整个 cron 列表。调用方必须先 GET 再合并，禁止空数组覆盖未知现网配置。
   */
  putSchedules: (scriptName: string, schedules: WorkerSchedule[]) =>
    http.put<{ schedules?: WorkerSchedule[] }>(
      `/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
      { body: { schedules: schedules.map((s) => ({ cron: s.cron })) } },
    ),

  listScriptSecrets: (scriptName: string) =>
    http.get<WorkerSecret[]>(
      `/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
    ),

  putSecret: (scriptName: string, name: string, text: string) =>
    http.put<WorkerSecret>(
      `/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
      { body: { name, text, type: 'secret_text' } },
    ),

  deleteSecret: (scriptName: string, secretName: string) =>
    http.delete<unknown>(
      `/accounts/${accountId()}/workers/scripts/${encodeURIComponent(scriptName)}/secrets/${encodeURIComponent(secretName)}`,
    ),
}
