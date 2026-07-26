/**
 * Cloudflare GraphQL Analytics API 封装。
 *
 * 调用 POST /client/v4/graphql，由 client.ts 的 graphql() 注入认证头并解析 result。
 * CF GraphQL 查询需要在 filter 里带 zoneTag（zone 维度）或 accountTag（account 维度）。
 * 时间用 ISO8601（since/until 接受 Time 类型，如 2024-01-01T00:00:00Z）。
 *
 * 所有函数返回 {labels, values, summary} 形式的结构化结果，供视图直接渲染。
 */
import { graphql } from './client'

/* ---------- 通用结构 ---------- */

export interface TimePoint {
  /** 时间标签（用于柱状图 x 轴 / tooltip） */
  label: string
  /** 原始时间戳 */
  ts: string
  requests: number
  bytes: number
  threats: number
  pageViews: number
  uniqueVisitors: number
  cachedBytes: number
}

export interface ZoneSummary {
  requests: number
  pageViews: number
  uniqueVisitors: number
  threats: number
  bytes: number
  cachedBytes: number
  cachedRequests: number
  /** 缓存命中率（cachedBytes / bytes，bytes 为 0 时返回 0） */
  cacheHitRate: number
  /** 命中样本数（1d 分组条数） */
  days: number
}

export interface CountryRow {
  country: string
  requests: number
  bytes: number
}

export interface WorkerInvocationRow {
  label: string
  script: string
  requests: number
  errors: number
  subrequests: number
}

export interface ZoneTrafficResult {
  points: TimePoint[]
  summary: ZoneSummary
}

export interface ZoneCountryResult {
  rows: CountryRow[]
  total: number
}

export interface AccountWorkersResult {
  rows: WorkerInvocationRow[]
  total: number
}

/* ---------- GraphQL 原始响应类型 ---------- */

interface RawSum {
  requests?: number
  bytes?: number
  threats?: number
  pageViews?: number
  cachedBytes?: number
  cachedRequests?: number
}
interface RawUniq {
  uniques?: number
}
interface Raw1hGroup {
  sum?: RawSum
  uniq?: RawUniq
  dimensions?: { datetime?: string; clientCountryName?: string }
}
interface Raw1dGroup {
  sum?: RawSum
  uniq?: RawUniq
  dimensions?: { date?: string; clientCountryName?: string }
}
interface RawWorkerGroup {
  sum?: { requests?: number; subrequests?: number; errors?: number }
  dimensions?: { date?: string; scriptName?: string }
}

interface Zone1hResp {
  viewer: { zones: { httpRequests1hGroups: Raw1hGroup[] }[] }
}
interface Zone1dResp {
  viewer: { zones: { httpRequests1dGroups: Raw1dGroup[] }[] }
}
interface AdaptiveGroup {
  count?: number
  sum?: { edgeResponseBytes?: number }
  dimensions?: { clientCountryName?: string }
}
interface ZoneCountryAdaptiveResp {
  viewer: { zones: { httpRequestsAdaptiveGroups: AdaptiveGroup[] }[] }
}
interface AccountWorkerResp {
  viewer: { accounts: { workersInvocationsAdaptive: RawWorkerGroup[] }[] }
}

/* ---------- 工具函数 ---------- */

function fmtMinuteLabel(dateMinute: string): string {
  // dateMinute 形如 2024-01-01T00:00Z 或 2024-01-01T00:00:00Z
  const d = new Date(dateMinute.endsWith('Z') ? dateMinute : `${dateMinute}Z`)
  if (Number.isNaN(d.getTime())) return dateMinute
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
}

function fmtDayLabel(date: string): string {
  const d = new Date(date.endsWith('Z') ? date : `${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 将 ISO8601 时间戳截成 1d 分组所需的纯日期 'YYYY-MM-DD'（CF GraphQL date_geq/date_leq 要求此格式） */
function toDateOnly(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function aggSummary(groups: { sum?: RawSum; uniq?: RawUniq }[]): ZoneSummary {
  let requests = 0
  let pageViews = 0
  let uniqueVisitors = 0
  let threats = 0
  let bytes = 0
  let cachedBytes = 0
  let cachedRequests = 0
  for (const g of groups) {
    const s = g.sum ?? {}
    const u = g.uniq ?? {}
    requests += s.requests ?? 0
    pageViews += s.pageViews ?? 0
    uniqueVisitors += u.uniques ?? 0
    threats += s.threats ?? 0
    bytes += s.bytes ?? 0
    cachedBytes += s.cachedBytes ?? 0
    cachedRequests += s.cachedRequests ?? 0
  }
  return {
    requests,
    pageViews,
    uniqueVisitors,
    threats,
    bytes,
    cachedBytes,
    cachedRequests,
    cacheHitRate: bytes > 0 ? cachedBytes / bytes : 0,
    days: groups.length,
  }
}

/* ---------- Zone 流量趋势 ---------- */

/**
 * 查询 zone 的请求分组（用于趋势柱状图），同时聚合汇总数据。
 * since/until 接受 ISO8601 字符串。
 *
 * 粒度自动选择（规避 CF 单查询时间范围限制）：
 * - 时间跨度 ≤ 3 天：用 httpRequests1hGroups（小时粒度，CF 限制 ≤3 天）
 * - 时间跨度 > 3 天：用 httpRequests1dGroups（天粒度，支持更长范围）
 */
export async function zoneTraffic(
  zoneId: string,
  since: string,
  until: string,
): Promise<ZoneTrafficResult> {
  const spanMs = new Date(until).getTime() - new Date(since).getTime()
  const useDaily = spanMs > 3 * 24 * 60 * 60 * 1000

  if (useDaily) {
    // 天粒度
    const query = `{
  viewer {
    zones(filter: {zoneTag: ${JSON.stringify(zoneId)}}) {
      httpRequests1dGroups(
        limit: 1000
        filter: {date_geq: ${JSON.stringify(toDateOnly(since))}, date_leq: ${JSON.stringify(toDateOnly(until))}}
        orderBy: [date_ASC]
      ) {
        sum {
          requests
          bytes
          threats
          pageViews
          cachedBytes
          cachedRequests
        }
        uniq {
          uniques
        }
        dimensions {
          date
        }
      }
    }
  }
}`
    const data = await graphql<Zone1dResp>(query)
    const groups = data.viewer.zones?.[0]?.httpRequests1dGroups ?? []
    const points: TimePoint[] = groups.map((g) => {
      const s = g.sum ?? {}
      const u = g.uniq ?? {}
      const dt = g.dimensions?.date ?? ''
      return {
        label: fmtDayLabel(dt),
        ts: dt,
        requests: s.requests ?? 0,
        bytes: s.bytes ?? 0,
        threats: s.threats ?? 0,
        pageViews: s.pageViews ?? 0,
        uniqueVisitors: u.uniques ?? 0,
        cachedBytes: s.cachedBytes ?? 0,
      }
    })
    return { points, summary: aggSummary(groups) }
  }

  // 小时粒度
  const query = `{
  viewer {
    zones(filter: {zoneTag: ${JSON.stringify(zoneId)}}) {
      httpRequests1hGroups(
        limit: 1000
        filter: {datetime_geq: ${JSON.stringify(since)}, datetime_lt: ${JSON.stringify(until)}}
        orderBy: [datetime_ASC]
      ) {
        sum {
          requests
          bytes
          threats
          pageViews
          cachedBytes
          cachedRequests
        }
        uniq {
          uniques
        }
        dimensions {
          datetime
        }
      }
    }
  }
}`
  const data = await graphql<Zone1hResp>(query)
  const groups = data.viewer.zones?.[0]?.httpRequests1hGroups ?? []

  const points: TimePoint[] = groups.map((g) => {
    const s = g.sum ?? {}
    const u = g.uniq ?? {}
    const dm = g.dimensions?.datetime ?? ''
    return {
      label: fmtMinuteLabel(dm),
      ts: dm,
      requests: s.requests ?? 0,
      bytes: s.bytes ?? 0,
      threats: s.threats ?? 0,
      pageViews: s.pageViews ?? 0,
      uniqueVisitors: u.uniques ?? 0,
      cachedBytes: s.cachedBytes ?? 0,
    }
  })

  return { points, summary: aggSummary(groups) }
}

/* ---------- Zone 汇总（1d 分组，更稳定的天级总数） ---------- */

/**
 * 查询 zone 的每日分组汇总（pageViews、requests、threats、唯一访客、缓存字节）。
 * 与 zoneTraffic 相比使用 1d 分组，避免边界小时被截断。
 */
export async function zoneSummary(
  zoneId: string,
  since: string,
  until: string,
): Promise<ZoneSummary> {
  const query = `{
  viewer {
    zones(filter: {zoneTag: ${JSON.stringify(zoneId)}}) {
      httpRequests1dGroups(
        limit: 1000
        filter: {date_geq: ${JSON.stringify(toDateOnly(since))}, date_leq: ${JSON.stringify(toDateOnly(until))}}
        orderBy: [date_ASC]
      ) {
        sum {
          requests
          bytes
          threats
          pageViews
          cachedBytes
          cachedRequests
        }
        uniq {
          uniques
        }
        dimensions {
          date
        }
      }
    }
  }
}`
  const data = await graphql<Zone1dResp>(query)
  const groups = data.viewer.zones?.[0]?.httpRequests1dGroups ?? []
  return aggSummary(groups)
}

/* ---------- Zone Top 国家 ---------- */

/**
 * 按 clientCountryName 聚合 Top N 国家。
 *
 * 注意：clientCountryName 维度只在 httpRequestsAdaptiveGroups（按需查询的明细集）
 * 中存在，1dGroups/1hGroups rollup 集不提供国家维度。AdaptiveGroups 免费版
 * 时间范围硬限 ≤ 1 天（超限返回 quota 错误），故传入的时间范围会自动裁剪到
 * 「最近 24 小时」以确保可用——这是 CF 套餐的客观限制，无法绕过。
 *
 * 用 count 计请求数、sum.edgeResponseBytes 计流量，按 clientCountryName
 * 维度 + orderBy count_DESC 拿 Top N。
 */
export async function zoneTopCountries(
  zoneId: string,
  _since: string,
  until: string,
  limit = 8,
): Promise<ZoneCountryResult> {
  // 裁到最近 24h，规避 AdaptiveGroups 免费 zone 时间范围 ≤1d 限制
  const end = new Date(until)
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  const startIso = start.toISOString()
  const endIso = end.toISOString()
  // limit 参与 GraphQL 字符串插值，消毒为正整数，防止异常入参破坏查询
  const safeLimit = Math.max(1, Math.floor(Number(limit)) || 8)

  const query = `{
  viewer {
    zones(filter: {zoneTag: ${JSON.stringify(zoneId)}}) {
      httpRequestsAdaptiveGroups(
        limit: ${safeLimit}
        filter: {datetime_gt: ${JSON.stringify(startIso)}, datetime_lt: ${JSON.stringify(endIso)}}
        orderBy: [count_DESC]
      ) {
        count
        sum {
          edgeResponseBytes
        }
        dimensions {
          clientCountryName
        }
      }
    }
  }
}`
  const data = await graphql<ZoneCountryAdaptiveResp>(query)
  const groups = data.viewer.zones?.[0]?.httpRequestsAdaptiveGroups ?? []
  let total = 0
  const merged = new Map<string, CountryRow>()
  for (const g of groups) {
    const country = g.dimensions?.clientCountryName
    if (!country) continue
    const req = g.count ?? 0
    total += req
    const bytes = g.sum?.edgeResponseBytes ?? 0
    const cur = merged.get(country)
    if (cur) {
      cur.requests += req
      cur.bytes += bytes
    } else {
      merged.set(country, { country, requests: req, bytes })
    }
  }
  return {
    rows: [...merged.values()].sort((a, b) => b.requests - a.requests).slice(0, safeLimit),
    total,
  }
}

/* ---------- Account Workers 调用统计 ---------- */

/**
 * 查询 account 维度的 Workers 调用统计（workersInvocationsAdaptive）。
 * 可选能力：若账号未启用 Workers 或无数据，CF 可能返回空数组。
 */
export async function accountWorkers(
  accountId: string,
  since: string,
  until: string,
): Promise<AccountWorkersResult> {
  const query = `{
  viewer {
    accounts(filter: {accountTag: ${JSON.stringify(accountId)}}) {
      workersInvocationsAdaptive(
        limit: 1000
        filter: {datetime_geq: ${JSON.stringify(since)}, datetime_lt: ${JSON.stringify(until)}}
        orderBy: [date_ASC]
      ) {
        sum {
          requests
          subrequests
          errors
        }
        dimensions {
          date
          scriptName
        }
      }
    }
  }
}`
  const data = await graphql<AccountWorkerResp>(query)
  const groups = data.viewer.accounts?.[0]?.workersInvocationsAdaptive ?? []
  let total = 0
  const rows: WorkerInvocationRow[] = groups.map((g) => {
    const s = g.sum ?? {}
    const d = g.dimensions ?? {}
    total += s.requests ?? 0
    return {
      label: d.date ? fmtDayLabel(d.date) : '',
      script: d.scriptName ?? '—',
      requests: s.requests ?? 0,
      errors: s.errors ?? 0,
      subrequests: s.subrequests ?? 0,
    }
  })
  return { rows, total }
}
