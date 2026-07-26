/**
 * Cloudflare for SaaS —— SaaS 优选加速编排 API
 *
 * 复刻 cococ.co 的 "SaaS 优选加速部署" 能力，技术基于 Cloudflare for SaaS：
 * 在用户自己账号下的 zone（SaaS 提供方）配置 fallback origin（回退源 = 回源域名），
 * 再把访问域名作为 custom hostname 接入该 zone，访问域名 CNAME 到优选域名，
 * 由 CF 边缘代理回源。
 *
 * 两种源站模式（fallback origin 必须是 zone 内已存在 proxied DNS 记录的主机名）：
 * - domain 模式：源站已有公网域名（如非 CF 的对象存储/CDN 域名、自建服务器域名等）。
 *   在访问域名所属 zone（accessZone）内创建 proxied CNAME 子域
 *   saas-origin-<6位hash>.<zone名> → 源站域名，用该子域作为 fallback origin。
 *   ⚠️ 限制：源站域名不能解析到 Cloudflare IP（即不能是 CF Worker / CF 代理域名），
 *   否则 CF 报 Error 1000 DNS points to prohibited IP（SaaS 不允许回源到 CF 自己）。
 *   源站是 CF Worker 请改用「一键加速」或直接给 Worker 绑自定义域。
 * - ip 模式：源站是传统服务器。在回源域名所属 zone（originZone）建 A/AAAA 记录指向源站 IP，
 *   fallback_origin 与 custom_hostname 挂在 originZone 上。
 *
 * 注意：回源统一走 zone 级 fallback origin，不依赖 per-hostname custom_origin_server，
 * 实现更简单且各计划通用（一个 zone 仅支持一个回源）。
 *
 * 与 accelerate.ts（Worker 回源 + CNAME 公共优选域名）的区别：
 * - 本模块用 CF for SaaS 原生能力，回源目标在用户自己账号下管理，不依赖 cococ 公共优选基础设施
 * - 访问域名不必在用户账号下（第三方域名也可加速，靠 CNAME + custom hostname 接管）
 *
 * 凭据安全模型继承：所有 CF API 调用由浏览器发起并同源透传，不在任何服务端落盘。
 *
 * CF API 端点（路径相对 client.ts 的 BASE=/api/cf/client/v4）：
 *   PUT   /zones/{zone_id}/custom_hostnames/fallback_origin   设置回退源 {origin}
 *   GET   /zones/{zone_id}/custom_hostnames/fallback_origin
 *   POST  /zones/{zone_id}/custom_hostnames                   接入 {hostname, ssl}
 *   GET   /zones/{zone_id}/custom_hostnames                    列表
 *   DELETE /zones/{zone_id}/custom_hostnames/{id}
 */
import { CFError, http } from './client'
import { dnsApi } from './dns'
import { zonesApi } from './zones'
import type { CustomHostname, Zone } from '@/types/cloudflare'

/* ---------- 常量与类型 ---------- */

/** 优选域名候选（访问域名 CNAME 目标） */
export const PREFERRED_DOMAINS = ['cdn.cnno.de', 'cdn.ddeed.de'] as const

/** 默认优选域名 */
export const DEFAULT_PREFERRED_DOMAIN = 'cdn.cnno.de'

/** 源站模式：domain=源站已有公网域名(非 CF 代理)；ip=源站是传统服务器需配 A 记录 */
export type OriginMode = 'domain' | 'ip'

/** 部署配置 */
export interface SaasDeployConfig {
  /** 访问域名（要加速的主机名，如 www.example.com 或 example.com） */
  accessDomain: string
  /** 源站模式：domain=源站已有公网域名(非 CF 代理)；ip=源站是传统服务器需配 A 记录 */
  originMode: OriginMode
  /**
   * 回源目标域名：
   * - domain 模式=源站域名(非 CF 代理，如对象存储/CDN/自建服务器域名)，zone 内建 saas-origin CNAME 子域指向它作 fallback origin
   * - ip 模式=账号下某 zone 子域(作为 fallback origin，其 A 记录指向 originIp)
   */
  originDomain: string
  /** 仅 ip 模式必填：源站真实 IP，回源域名 A/AAAA 记录指向它 */
  originIp?: string
  /** 优选域名（访问域名 CNAME 目标） */
  preferredDomain: string
  /** 访问域名所属 zone id（表单已选定时直传；不传则按域名反查） */
  zoneId?: string
}

/** 部署进度步骤 */
export type SaasDeployStep = 'precheck' | 'dns' | 'fallback' | 'hostname' | 'cname' | 'done'

export interface SaasDeployProgress {
  step: SaasDeployStep
  message: string
  ok: boolean
}

/** 已部署的 SaaS 优选记录（custom hostname） */
export interface SaasDeployment {
  id: string
  /** 访问域名 */
  hostname: string
  /** custom hostname 状态：pending | active | moved */
  status: string
  /** SSL 证书状态：pending_validation | pending_deployment | active */
  sslStatus: string
  /** 回源主机 = zone 级 fallback origin（ip 模式=承载 A 记录的回源子域；domain 模式=指向源站的 saas-origin CNAME 子域） */
  originDomain: string
  /** 承载 fallback_origin / custom_hostname 的 zone id（domain 模式=accessZone；ip 模式=originZone） */
  originZoneId: string
  zoneName: string
  /** 是否需要手动配置访问域名 CNAME（accessDomain 不在账号内时） */
  manualCname?: boolean
  /** 优选域名（访问域名应 CNAME 到此，manualCname=true 时提示用户） */
  preferredDomain?: string
}

/** 部署结果 */
export interface SaasDeployResult {
  deployment: SaasDeployment
  /** 是否需要用户手动为访问域名配 CNAME */
  manualCname: boolean
}

/* ---------- 工具函数 ---------- */

/** 规范化域名字符串用于匹配（去尾部点、转小写、trim） */
function normalizeDomain(s: string): string {
  return s.replace(/\.$/, '').toLowerCase().trim()
}

/** 判断 IP 类型 → DNS 记录类型 */
function ipRecordType(ip: string): 'A' | 'AAAA' {
  return ip.includes(':') ? 'AAAA' : 'A'
}

/** IPv4 严格校验：四段 0-255 */
function isValidIpv4(v: string): boolean {
  const parts = v.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * IPv6 校验：按 :: 拆分、段数校验、每段 1-4 位 hex，支持 IPv4-mapped 尾段（如 ::ffff:1.2.3.4）。
 * 正确拒绝 :::、1::2::3、12345:: 等非法写法。
 */
function isValidIpv6(v: string): boolean {
  if (v === '::') return true
  const dc = v.split('::')
  if (dc.length > 2) return false // 最多一个 ::
  const head = dc[0] ? dc[0].split(':') : []
  const tail = dc.length === 2 ? (dc[1] ? dc[1].split(':') : []) : []
  const groups = [...head, ...tail]
  let count = 0
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    if (g.includes('.')) {
      // IPv4-mapped 段必须是整个地址的最后 32 位：为最末组，且其后不能再有 :: 压缩
      // （有 :: 时它必须落在 tail 末尾，拒绝 1:2:3:1.2.3.4:: 这类写法），占 2 组
      const isLast = i === groups.length - 1 && (dc.length !== 2 || tail.length > 0)
      if (!isLast || !isValidIpv4(g)) return false
      count += 2
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false
      count += 1
    }
  }
  // 有 :: 时至少压缩一组（count ≤ 7）；无 :: 时必须恰好 8 组
  return dc.length === 2 ? count <= 7 : count === 8
}

/** IPv4/IPv6 校验 */
export function isValidIp(ip: string): boolean {
  const v = ip.trim()
  if (!v) return false
  return v.includes(':') ? isValidIpv6(v) : isValidIpv4(v)
}

/** 在 zones 列表中找到 domain 所属的 zone（父子 zone 并存时取 name 最长的最精确命中） */
function findZoneForDomain(zones: Zone[], domain: string): Zone | undefined {
  const host = normalizeDomain(domain)
  let best: Zone | undefined
  for (const z of zones) {
    const zname = normalizeDomain(z.name)
    if (host !== zname && !host.endsWith('.' + zname)) continue
    if (!best || zname.length > normalizeDomain(best.name).length) best = z
  }
  return best
}

/** 简单字符串 hash，输出 6 位 base36（回源 CNAME 子域命名用，确定性、可幂等复用） */
function hash6(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6)
}

/**
 * domain 模式的回源 CNAME 主机名：saas-origin-<6位hash>.<zone名>。
 * CF 要求 fallback origin 必须是 zone 内已存在 proxied DNS 记录的主机名，
 * 外部源站域名需先在 zone 内落一条 CNAME 才能作为回源目标。
 */
function saasOriginHost(zoneName: string, originDomain: string): string {
  return `saas-origin-${hash6(normalizeDomain(originDomain))}.${zoneName}`
}

/* ---------- custom_hostnames 基础 API ---------- */

/** 列出 zone 下所有 custom hostnames */
export async function listCustomHostnames(zoneId: string): Promise<CustomHostname[]> {
  // custom_hostnames 端点默认分页，per_page 拉满
  const all: CustomHostname[] = []
  let page = 1
  for (;;) {
    const res = await http.get<CustomHostname[]>(`/zones/${zoneId}/custom_hostnames`, {
      params: { per_page: 100, page },
    })
    all.push(...res)
    if (res.length < 100) break
    page += 1
    if (page > 50) break // 保险
  }
  return all
}

/** 创建 custom hostname（接入访问域名，回源统一走 zone 级 fallback origin） */
function createCustomHostname(zoneId: string, hostname: string): Promise<CustomHostname> {
  return http.post<CustomHostname>(`/zones/${zoneId}/custom_hostnames`, {
    body: {
      hostname,
      // 不传 custom_origin_server：回源统一走 zone 级 fallback origin，实现更简单且各计划通用
      ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.0' } },
    },
  })
}

/** 删除 custom hostname */
function deleteCustomHostname(zoneId: string, id: string): Promise<unknown> {
  return http.delete<unknown>(`/zones/${zoneId}/custom_hostnames/${id}`)
}

/** 设置 zone 级回退源（fallback origin） */
function setFallbackOrigin(zoneId: string, origin: string): Promise<FallbackOriginLike> {
  return http.put<FallbackOriginLike>(`/zones/${zoneId}/custom_hostnames/fallback_origin`, {
    body: { origin },
  })
}

/** 查询 zone 级回退源 */
function getFallbackOrigin(zoneId: string): Promise<FallbackOriginLike | null> {
  return http.get<FallbackOriginLike>(`/zones/${zoneId}/custom_hostnames/fallback_origin`)
}

/** 删除 zone 级回退源（部署回滚 / 最后一个接入移除后的清理用） */
function deleteFallbackOrigin(zoneId: string): Promise<unknown> {
  return http.delete<unknown>(`/zones/${zoneId}/custom_hostnames/fallback_origin`)
}

interface FallbackOriginLike {
  origin: string
  status?: string
}

/* ---------- 已部署列表 ---------- */

/**
 * 遍历账号下所有 zone，聚合 SaaS 优选已部署记录。
 * 每个 zone：取 fallback origin（回源域名）+ custom_hostnames 列表，配对成 deployment。
 * 无 custom hostname 的 zone 跳过。
 */
export async function listSaasDeployments(): Promise<SaasDeployment[]> {
  const zones = await zonesApi.listAll()
  const results: SaasDeployment[] = []

  // 并发查每个 zone 的 fallback + custom hostnames
  await Promise.all(
    zones.map(async (zone) => {
      let fallback: FallbackOriginLike | null = null
      let hosts: CustomHostname[] = []
      try {
        ;[fallback, hosts] = await Promise.all([
          getFallbackOrigin(zone.id).catch(() => null),
          listCustomHostnames(zone.id).catch(() => [] as CustomHostname[]),
        ])
      } catch {
        return
      }
      const zoneFallback = fallback?.origin ?? ''
      for (const h of hosts) {
        // 回源统一走 zone 级 fallback origin（不依赖 per-hostname custom_origin_server）
        const originDomain = zoneFallback
        results.push({
          id: h.id,
          hostname: h.hostname,
          status: h.status,
          sslStatus: h.ssl?.status ?? '—',
          originDomain,
          originZoneId: zone.id,
          zoneName: zone.name,
        })
      }
    }),
  )
  return results
}

/* ---------- 部署 ---------- */

/**
 * 部署 SaaS 优选加速。
 *
 * 两种源站模式（对齐 cococ.co：两种模式都设 zone 级 fallback_origin，
 * fallback origin 必须是 zone 内已存在 proxied DNS 记录的主机名）：
 * - domain 模式：源站已有公网域名（非 CF 代理，如对象存储/CDN/自建服务器域名）。
 *   在 accessZone 内建 proxied CNAME 子域 saas-origin-<hash>.<zone名> → 源站域名，
 *   用该子域作 fallback origin；custom_hostname 也挂在 accessZone 上。
 * - ip 模式：源站是传统服务器。在 originZone（回源域名所属 zone）建 A 记录指向源站 IP，
 *   fallback_origin 与 custom_hostname 挂在 originZone 上。
 *
 * 步骤：
 *   ① 确定配置 zone（targetZone）：domain=accessZone；ip=originZone
 *   ② 只读预检：fallback 冲突检查、custom hostname 是否已存在（全部通过后才开始变更）
 *   ③ 建回源 DNS 记录：ip=A(AAAA) 记录 → originIp；domain=CNAME 子域 → 源站域名
 *     （PATCH 既有记录前保存原 payload，新建记录在失败路径删除）
 *   ④ PUT fallback_origin（挂 targetZone）：预检已确认无冲突；已有且一致 → 跳过（幂等）
 *   ⑤ POST custom_hostname = accessDomain（已存在同名则复用，失败回滚本次新设的 fallback 与回源记录）
 *   ⑥ 访问域名 CNAME（DNS only 灰云）：若 accessDomain 在账号某 zone 下，建 CNAME → preferredDomain；否则标记需手动
 *
 * @param config 部署配置
 * @param onProgress 进度回调
 */
export async function deploySaas(
  config: SaasDeployConfig,
  onProgress?: (p: SaasDeployProgress) => void,
): Promise<SaasDeployResult> {
  const { accessDomain, originMode, originDomain, originIp, preferredDomain } = config

  const zones = await zonesApi.listAll()

  // 访问域名所属 zone（用于 CNAME，及 domain 模式下承载 fallback/hostname）：
  // 优先用表单选定的 zoneId 直取并校验域名归属，未传才按域名反查（最长匹配）
  let accessZone: Zone | undefined
  if (config.zoneId) {
    accessZone = await zonesApi.get(config.zoneId)
    const host = normalizeDomain(accessDomain)
    const zname = normalizeDomain(accessZone.name)
    if (host !== zname && !host.endsWith('.' + zname)) {
      throw new Error(`访问域名 ${accessDomain} 不属于所选 zone ${accessZone.name}`)
    }
  } else {
    accessZone = findZoneForDomain(zones, accessDomain)
  }

  // ① 确定配置 zone 与 originZone
  let originZone: Zone | undefined
  let targetZone: Zone
  if (originMode === 'ip') {
    // ip 模式：回源域名必须在账号下（要在其所属 zone 建 A 记录）
    originZone = findZoneForDomain(zones, originDomain)
    if (!originZone) {
      throw new Error(`未找到回源域名 ${originDomain} 所属的 zone，请确认该域名在当前 Cloudflare 账号下`)
    }
    targetZone = originZone
  } else {
    // domain 模式：源站域名通常不在账号下，挂在 accessZone 上
    if (!accessZone) {
      throw new Error('访问域名需在账号下，或用 IP 模式')
    }
    targetZone = accessZone
  }

  // 校验：回源域名不能与访问域名相同
  if (normalizeDomain(accessDomain) === normalizeDomain(originDomain)) {
    throw new Error('回源域名不能与访问域名相同')
  }

  // fallback origin 目标主机：ip 模式=回源域名本身（A 记录挂它上面）；
  // domain 模式=zone 内的回源 CNAME 子域（fallback 不能直接指向 zone 外域名）
  const fallbackHost = originMode === 'ip' ? originDomain : saasOriginHost(targetZone.name, originDomain)

  // ② 只读预检（不做任何变更，全部通过后才进入变更阶段）
  onProgress?.({ step: 'precheck', message: '正在预检既有配置…', ok: true })

  // 预检 a：fallback 冲突。仅 404（未配置）视为无 fallback，
  // 其他错误（权限/网络等）上抛，防止误判为"无 fallback"而静默覆盖
  let existingFallback: FallbackOriginLike | null = null
  try {
    existingFallback = await getFallbackOrigin(targetZone.id)
  } catch (e) {
    if (e instanceof CFError && e.status === 404) {
      existingFallback = null
    } else {
      throw new Error(`查询回退源失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const prevOrigin = normalizeDomain(existingFallback?.origin ?? '')
  if (prevOrigin && prevOrigin !== normalizeDomain(fallbackHost)) {
    throw new Error(
      `zone ${targetZone.name} 已存在回退源 ${existingFallback?.origin}，一个 zone 仅支持一个回源；` +
        '如需更换回源，请先删除该 zone 既有的 SaaS 部署',
    )
  }

  // 预检 b：custom hostname 是否已存在（存在则后续复用，保证幂等）
  let existedHostname: CustomHostname | undefined
  try {
    const hosts = await listCustomHostnames(targetZone.id)
    existedHostname = hosts.find((h) => normalizeDomain(h.hostname) === normalizeDomain(accessDomain))
  } catch (e) {
    throw new Error(`查询既有 custom hostname 失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // ③ 建回源 DNS 记录（失败即中止：没有回源记录 fallback 必然无效，继续跑会假报成功）
  //    记录回滚动作：PATCH 既有记录前保存原 payload 供恢复；新建记录在失败路径删除
  let restoreOriginRecord: (() => Promise<void>) | null = null
  if (originMode === 'ip') {
    if (!originZone) {
      // 类型收窄保护，理论上不会走到
      throw new Error('ip 模式缺少回源域名所属 zone')
    }
    if (!originIp) {
      throw new Error('ip 模式必须提供源站 IP')
    }
    const oz = originZone
    onProgress?.({ step: 'dns', message: '正在为回源域名配置 A 记录…', ok: true })
    const type = ipRecordType(originIp)
    try {
      const existing = await dnsApi.list(oz.id, { name: originDomain, type })
      if (existing.length > 0) {
        const prev = existing[0]
        // PATCH 前保存原 payload（type/content/proxied），任一后续步骤失败时恢复
        const prevPayload = { type: prev.type, name: prev.name, content: prev.content, proxied: prev.proxied }
        await dnsApi.update(oz.id, prev.id, {
          type,
          name: originDomain,
          content: originIp,
          proxied: true,
          comment: 'SaaS 优选回源 A 记录',
        })
        restoreOriginRecord = async () => {
          await dnsApi.update(oz.id, prev.id, prevPayload)
        }
      } else {
        const created = await dnsApi.create(oz.id, {
          type,
          name: originDomain,
          content: originIp,
          proxied: true,
          comment: 'SaaS 优选回源 A 记录',
        })
        restoreOriginRecord = async () => {
          await dnsApi.delete(oz.id, created.id)
        }
      }
    } catch (e) {
      throw new Error(`回源 ${type} 记录配置失败：${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    // domain 模式：在 targetZone 内建 proxied CNAME 子域指向外部源站域名
    onProgress?.({ step: 'dns', message: `正在创建回源 CNAME ${fallbackHost} → ${originDomain}…`, ok: true })
    try {
      const existing = await dnsApi.list(targetZone.id, { type: 'CNAME', name: fallbackHost })
      if (existing.length > 0) {
        // 既有记录为本模块确定性命名的子域，内容幂等，无需回滚动作
        await dnsApi.update(targetZone.id, existing[0].id, {
          type: 'CNAME',
          name: fallbackHost,
          content: originDomain,
          proxied: true,
          comment: 'SaaS 优选回源 CNAME',
        })
      } else {
        const created = await dnsApi.create(targetZone.id, {
          type: 'CNAME',
          name: fallbackHost,
          content: originDomain,
          proxied: true,
          comment: 'SaaS 优选回源 CNAME',
        })
        restoreOriginRecord = async () => {
          await dnsApi.delete(targetZone.id, created.id)
        }
      }
    } catch (e) {
      throw new Error(`回源 CNAME 配置失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ④ 设置 fallback origin = 回源主机（挂 targetZone；预检已确认无冲突）
  onProgress?.({ step: 'fallback', message: '正在配置回退源（fallback origin）…', ok: true })
  let fallbackChanged = false

  /** 变更失败统一回滚：删除本次新设的 fallback、恢复/删除本次动过的回源记录（尽力而为，不覆盖原始错误） */
  const rollbackChanges = async () => {
    if (fallbackChanged) {
      try {
        await deleteFallbackOrigin(targetZone.id)
      } catch {
        // 回滚失败不覆盖原始错误
      }
    }
    if (restoreOriginRecord) {
      try {
        await restoreOriginRecord()
      } catch {
        // 同上
      }
    }
  }

  if (prevOrigin) {
    onProgress?.({ step: 'fallback', message: '回退源已配置且一致，跳过设置', ok: true })
  } else {
    try {
      await setFallbackOrigin(targetZone.id, fallbackHost)
      fallbackChanged = true
    } catch (e) {
      await rollbackChanges()
      throw new Error(`配置回退源失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ⑤ 接入访问域名 custom hostname（挂 targetZone；预检发现同名则复用，保证幂等）
  onProgress?.({ step: 'hostname', message: '正在接入访问域名（custom hostname）…', ok: true })
  let hostname: CustomHostname
  if (existedHostname) {
    onProgress?.({ step: 'hostname', message: '访问域名已接入，复用现有 custom hostname', ok: true })
    hostname = existedHostname
  } else {
    try {
      hostname = await createCustomHostname(targetZone.id, accessDomain)
    } catch (e) {
      // 失败回滚本次新设的 fallback 与回源记录（尽力而为，恢复部署前状态）
      await rollbackChanges()
      throw new Error(`接入访问域名失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ⑥ 访问域名 CNAME → 优选域名（必须 DNS only 灰云：只有灰云才会解析到优选 IP、
  //    经 SNI 匹配 custom hostname 进入 SaaS 路径；proxied 会由本 zone 承接并回源到 CF IP 报 Error 1000）
  let manualCname = false
  onProgress?.({ step: 'cname', message: '正在配置访问域名 CNAME…', ok: true })
  if (accessZone) {
    try {
      const existingCname = await dnsApi.list(accessZone.id, { type: 'CNAME', name: accessDomain })
      if (existingCname.length > 0) {
        // 既有 CNAME（含误开 proxied 的旧记录）统一改写为 DNS only
        await dnsApi.update(accessZone.id, existingCname[0].id, {
          type: 'CNAME',
          name: accessDomain,
          content: preferredDomain,
          proxied: false,
          comment: 'SaaS 优选 CNAME',
        })
      } else {
        await dnsApi.create(accessZone.id, {
          type: 'CNAME',
          name: accessDomain,
          content: preferredDomain,
          proxied: false,
          comment: 'SaaS 优选 CNAME',
        })
      }
    } catch (e) {
      // CNAME 失败降级为手动提示
      manualCname = true
      onProgress?.({
        step: 'cname',
        message: `CNAME 自动配置失败，需手动配置：${e instanceof Error ? e.message : String(e)}`,
        ok: false,
      })
    }
  } else {
    // 访问域名不在账号内，需用户自行到其 DNS 服务商配 CNAME
    manualCname = true
  }

  onProgress?.({ step: 'done', message: '部署完成，等待 1-5 分钟 DCV 证书签发生效', ok: true })

  const deployment: SaasDeployment = {
    id: hostname.id,
    hostname: hostname.hostname,
    status: hostname.status,
    sslStatus: hostname.ssl?.status ?? 'pending',
    // 展示/删除都以实际 fallback origin 主机为准（domain 模式为 saas-origin CNAME 子域）
    originDomain: fallbackHost,
    originZoneId: targetZone.id,
    zoneName: targetZone.name,
    manualCname,
    preferredDomain,
  }
  return { deployment, manualCname }
}

/* ---------- 移除 ---------- */

/**
 * 移除 SaaS 优选配置：删除指定 custom hostname + 访问域名 CNAME；
 * 该 zone 下已无任何 custom hostname 时，一并清理 fallback origin 与回源 DNS 记录
 * （fallback 为 zone 级单例，尚有其它接入共用时保留，避免误伤）。
 * 单步失败不阻断，最终聚合错误。
 *
 * @param originDomain 回源主机（= zone 级 fallback origin；ip 模式为 A 记录子域，domain 模式为 saas-origin CNAME 子域）
 * @param originZoneId 承载 fallback / custom hostname 的 zone id
 * @param hostnames 要移除的访问域名集合；缺省时退回旧逻辑按 custom_origin_server 匹配（兼容历史部署）
 */
export async function removeSaas(originDomain: string, originZoneId: string, hostnames?: string[]): Promise<void> {
  const errors: string[] = []
  const origin = normalizeDomain(originDomain)

  // 边界：origin 与 hostnames 均为空时无从定位删除目标，直接返回
  // （防止空 origin 匹配到全部无 origin 的 hostname、以及发出 name= 空参数的 DNS 查询）
  if (!origin && (!hostnames || !hostnames.length)) return

  // ① 删除 custom hostname：
  //    传了 hostnames 时按访问域名精确匹配（新部署统一走 zone 级 fallback，不再写 per-hostname origin）；
  //    未传时退回按 custom_origin_server == originDomain 匹配（兼容历史部署）
  try {
    const hosts = await listCustomHostnames(originZoneId)
    const hostSet = hostnames?.map(normalizeDomain)
    const matched = hosts.filter((h) =>
      hostSet
        ? hostSet.includes(normalizeDomain(h.hostname))
        : normalizeDomain(h.custom_origin_server ?? '') === origin,
    )
    await Promise.all(matched.map((h) => deleteCustomHostname(originZoneId, h.id)))
  } catch (e) {
    errors.push(`自定义主机名删除失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // ② 删除访问域名的 CNAME 记录（指向优选域名，comment 标记"SaaS 优选 CNAME"）
  //    遍历 hostnames 所在 zone 清理；hostnames 缺省时跳过（无法定位访问域名 zone）
  if (hostnames && hostnames.length) {
    try {
      const zones = await zonesApi.listAll()
      for (const hn of hostnames) {
        const zone = findZoneForDomain(zones, hn)
        if (!zone) continue
        const records = await dnsApi.list(zone.id, { type: 'CNAME', name: hn })
        const matched = records.filter((r) => r.comment === 'SaaS 优选 CNAME')
        await Promise.all(matched.map((r) => dnsApi.delete(zone.id, r.id)))
      }
    } catch (e) {
      errors.push(`访问域名 CNAME 删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ③ 该 zone 已无任何 custom hostname 时，清理 fallback origin 与回源 DNS 记录
  //    （A/AAAA=ip 模式建的回源记录；CNAME=domain 模式建的 saas-origin 子域，均按 comment 精确匹配）
  if (origin) {
    try {
      const remaining = await listCustomHostnames(originZoneId)
      if (remaining.length === 0) {
        await deleteFallbackOrigin(originZoneId).catch(() => undefined)
        const records = await dnsApi.list(originZoneId, { name: originDomain })
        const matched = records.filter(
          (r) =>
            ((r.type === 'A' || r.type === 'AAAA') && r.comment === 'SaaS 优选回源 A 记录') ||
            (r.type === 'CNAME' && r.comment === 'SaaS 优选回源 CNAME'),
        )
        if (matched.length > 0) {
          await Promise.all(matched.map((r) => dnsApi.delete(originZoneId, r.id)))
        }
      }
    } catch (e) {
      errors.push(`回源记录清理失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (errors.length) {
    throw new Error(errors.join('；'))
  }
}
