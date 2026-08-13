import { http, authHeaders, CFError } from './client'
import type { DNSRecord, DNSRecordPayload } from '@/types/cloudflare'

const BASE = '/api/cf/client/v4'

export interface DnssecInfo {
  status?: 'active' | 'pending' | 'disabled' | 'pending-disabled' | 'error' | string
  ds?: string
  digest?: string
  digest_algorithm?: string
  algorithm?: string
  key_tag?: number
  key_type?: string
  public_key?: string
  modified_on?: string
}

export const dnsApi = {
  list: (zoneId: string, params: { type?: string; name?: string; content?: string; page?: number; per_page?: number } = {}) =>
    http.get<DNSRecord[]>(`/zones/${zoneId}/dns_records`, { params }),

  get: (zoneId: string, recordId: string) =>
    http.get<DNSRecord>(`/zones/${zoneId}/dns_records/${recordId}`),

  create: (zoneId: string, payload: DNSRecordPayload) =>
    http.post<DNSRecord>(`/zones/${zoneId}/dns_records`, { body: payload }),

  /** 部分更新：PATCH 仅提交变化字段（PUT 为全量覆盖，缺字段会 400） */
  update: (zoneId: string, recordId: string, payload: Partial<DNSRecordPayload>) =>
    http.patch<DNSRecord>(`/zones/${zoneId}/dns_records/${recordId}`, { body: payload }),

  delete: (zoneId: string, recordId: string) =>
    http.delete<DNSRecord>(`/zones/${zoneId}/dns_records/${recordId}`),

  /**
   * 导出 BIND zone 文件。该端点返回纯文本而非 JSON 壳，绕过 http 解析。
   * 官方：GET /zones/{zone_id}/dns_records/export
   */
  exportBind: async (zoneId: string): Promise<string> => {
    const res = await fetch(`${BASE}/zones/${encodeURIComponent(zoneId)}/dns_records/export`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new CFError(`导出 BIND 失败（HTTP ${res.status}）${text ? `：${text.slice(0, 200)}` : ''}`, undefined, res.status)
    }
    return res.text()
  },

  /** DNSSEC 状态与 DS 记录（只读） */
  getDnssec: (zoneId: string) => http.get<DnssecInfo>(`/zones/${zoneId}/dnssec`),

  /** 批量导入：逐条创建，返回每条结果 */
  importBatch: async (zoneId: string, records: DNSRecordPayload[]) => {
    const results: { record: DNSRecordPayload; ok: boolean; error?: string }[] = []
    for (const record of records) {
      try {
        await dnsApi.create(zoneId, record)
        results.push({ record, ok: true })
      } catch (e) {
        results.push({ record, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return results
  },
}
