/**
 * 一键网站加速编排 API（复刻 cococ.co 的一键加速，纯前端编排，不经过任何第三方后端）
 *
 * 加速原理（已实测验证）：
 *   1. 上传回源 Worker 脚本（访问域名/* 路由命中后反向代理到源站，可选 Cache API 缓存）
 *   2. 创建 Worker 路由 accessDomain/* → Worker
 *   3. 创建 CNAME accessDomain → 优选域名（cdn.cnno.de 等），proxied=false（DNS Only）。
 *      优选域名解析到优选 Cloudflare IP，访客经这些 IP 抵达 CF 边缘后仍命中 zone 的
 *      Worker 路由——这才是「优选加速」生效的关键；proxied=true 会让 CF 返回标准
 *      任播 IP，CNAME 目标完全失效，加速毫无意义。
 *   4. 「已加速域名」通过对账号下所有 zone 扫描 CNAME 精确匹配优选域名 +
 *      校验对应 Worker 脚本存在来识别
 */
import { CFError, http, listAll } from './client'
import { dnsApi } from './dns'
import { zonesApi } from './zones'
import { workersApi } from './workers'
import { listCustomHostnames } from './saas'
import type { DNSRecord, DNSRecordPayload, WorkerRoute, Zone } from '@/types/cloudflare'

/** 优选域名候选（CNAME 目标，解析到优选 Cloudflare IP） */
export const PREFERRED_ORIGIN_DOMAINS = ['cdn.cnno.de', 'cdn.ddeed.de'] as const

/** 默认优选域名 */
export const DEFAULT_ORIGIN_DOMAIN = 'cdn.cnno.de'

/** 加速部署配置 */
export interface AccelerateConfig {
  /** 访问域名（完整主机名，如 www.example.com） */
  accessDomain: string
  /** 源站域名（裸主机名，如 origin.example.com；Worker 以 HTTPS 回源） */
  targetDomain: string
  /** 缓存时间（秒），0 = 不缓存 */
  cacheTtl: number
  /** 优选域名（CNAME 目标，默认 cdn.cnno.de） */
  originDomain: string
  /** Worker 脚本名称 */
  workerName: string
  /** 访问域名所属 zone id（表单已选定时直传；不传则按域名反查） */
  zoneId?: string
}

/** 已加速域名探测结果 */
export interface AcceleratedZone {
  zone: Zone
  record: DNSRecord
  /** 真实 Worker 名（以路由 script 为准，找不到路由时回退命名约定推导） */
  workerName: string
  /** Worker 脚本是否真实存在 */
  accelerated: boolean
}

/** 部署步骤进度回调 */
export type DeployStep = 'upload' | 'dns' | 'done'

export interface DeployProgress {
  step: DeployStep
  message: string
  ok: boolean
}

/* -------------------------------------------------------------------------- */
/*                              Worker 脚本生成                                */
/* -------------------------------------------------------------------------- */

/** 简单字符串 hash，输出 6 位 base36 后缀（截断防撞名用，无需引库） */
function hash6(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6)
}

/**
 * 根据访问域名生成 Worker 名称（与 cococ.co 约定一致：访问域名点替换为连字符，
 * 如 www.example.com → www-example-com），符合 CF 脚本命名规范（[a-z0-9_-]，≤63）。
 * 与 cococ 保持同名约定可让两边部署的加速互相识别与管理。
 */
export function generateWorkerName(accessDomain: string): string {
  const name = normalizeDomain(accessDomain)
    .replace(/[^a-z0-9.]/g, '')
    .replace(/\./g, '-')
    .replace(/^-+|-+$/g, '')
  // Cloudflare 脚本名最长 63 字符；截断时附完整域名 hash 后缀，避免不同长域名截断撞名（删除时误伤）
  if (name.length <= 63) return name
  return `${name.slice(0, 56)}-${hash6(normalizeDomain(accessDomain))}`
}

/**
 * 生成回源 Worker 脚本源码（复刻 cococ.co 部署的脚本逻辑，并修复其 max-age 为空的后端模板 bug）。
 *
 * 行为与 cococ 一致：
 *   - 仅改 hostname 回源到 targetDomain（HTTPS，Host 头同步修正），redirect: manual 不跟随跳转
 *   - 非 GET/HEAD 动态请求（登录提交等）直接透传，绝不进缓存
 *   - GET/HEAD 且 cacheTtl > 0 时走 Cache API：缓存键为原始访问 URL，只缓存 200，
 *     缓存路径统一剥离 Set-Cookie（防止把他人登录态缓存后群发给所有访客）
 *   - cacheTtl = 0 时完全绕过 Cache API，纯透传
 * 语法为 ES module 形式（workersApi.uploadScript 以 main_module 上传）。
 */
export function generateWorkerScript(targetDomain: string, cacheTtl: number): string {
  const ttl = Math.max(0, Math.floor(cacheTtl || 0))
  return `/**
 * 一键加速 Worker（由 Cloudflare-Dashboard 生成）
 * 源站：${targetDomain}
 * 缓存 TTL：${ttl} 秒（0 = 不缓存）
 */
const TARGET_HOST = ${JSON.stringify(targetDomain)};
const CACHE_TTL = ${ttl};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    url.hostname = TARGET_HOST;

    // 透传请求头并修正 Host；redirect: manual 避免 Worker 内吞掉 3xx 暴露源站跳转目标
    const headers = new Headers(request.headers);
    headers.set('Host', TARGET_HOST);
    const originRequest = new Request(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    // 动态请求（POST/PUT/DELETE 等）与未开启缓存的 GET/HEAD 直接回源，不碰 Cache API
    if (CACHE_TTL <= 0 || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return fetch(originRequest);
    }

    // GET/HEAD 静态请求走 Cache API，缓存键用原始访问 URL
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set('CF-Cache-Status', 'HIT');
      return hit;
    }

    const originResponse = await fetch(originRequest);
    const newHeaders = new Headers(originResponse.headers);
    // 清掉源站缓存头，缓存策略由本 Worker 统一管理
    newHeaders.delete('Cache-Control');
    newHeaders.delete('Pragma');
    newHeaders.delete('Expires');
    // 安全防护：缓存路径不透传 Set-Cookie，防止把他人登录态缓存后群发给所有访客
    newHeaders.delete('Set-Cookie');

    const response = new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: newHeaders,
    });
    // 只缓存 200，避免缓存 404/500 报错页
    if (response.status === 200) {
      response.headers.set('Cache-Control', 'public, max-age=' + CACHE_TTL);
      response.headers.set('CF-Cache-Status', 'MISS');
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } else {
      response.headers.set('Cache-Control', 'no-store, max-age=0');
      response.headers.set('CF-Cache-Status', 'BYPASS');
    }
    return response;
  },
}
`
}

/* -------------------------------------------------------------------------- */
/*                                编排 API                                     */
/* -------------------------------------------------------------------------- */

/** 列出账号下所有 zone */
export async function listAcceleratedZones(): Promise<Zone[]> {
  return zonesApi.listAll()
}

/** 规范化域名字符串用于匹配（去尾部点、转小写） */
function normalizeDomain(s: string): string {
  return s.replace(/\.$/, '').toLowerCase().trim()
}

/**
 * 探测账号下已加速的域名。
 *
 * 对每个 zone 列出 CNAME 记录，匹配 content 指向优选回源域名的记录；
 * Worker 名以路由为准：在该 zone 的 workers/routes 里找 pattern 匹配 `host/*` 的路由，
 * 取其 script 作为真实 Worker 名（自定义命名的部署也能识别），找不到路由才回退按命名约定推导。
 *
 * @param zones zone 列表
 * @param originDomains 优选域名集合，默认 PREFERRED_ORIGIN_DOMAINS
 */
export async function detectAccelerated(
  zones: Zone[],
  originDomains: readonly string[] = PREFERRED_ORIGIN_DOMAINS,
): Promise<AcceleratedZone[]> {
  const domains = originDomains.map(normalizeDomain)
  if (!domains.length) return []

  // 预取脚本清单，避免每条记录一次调用
  let scripts = new Set<string>()
  try {
    const list = await workersApi.listScripts()
    scripts = new Set(list.map((s) => s.id))
  } catch {
    // 取不到脚本清单时降级：仅基于 CNAME 匹配，accelerated 置 false
    scripts = new Set()
  }

  // 各 zone 并发探测；DNS 记录走翻页拉全量，避免默认 100 条截断漏检
  const perZone = await Promise.all(
    zones.map(async (zone): Promise<AcceleratedZone[]> => {
      let records: DNSRecord[] = []
      try {
        records = await listAll<DNSRecord>(
          `/zones/${zone.id}/dns_records`,
          { type: 'CNAME' },
          { perPage: 100 },
        )
      } catch {
        return []
      }
      // 预取该 zone 的 custom hostnames，命中 hostname 的记录归 SaaS 优选管，排除避免误判为加速记录
      let saasHostnames = new Set<string>()
      try {
        const hosts = await listCustomHostnames(zone.id)
        saasHostnames = new Set(hosts.map((h) => normalizeDomain(h.hostname)))
      } catch {
        // 取不到 custom hostnames 时降级：不排除（保持旧行为）
      }
      // 预取该 zone 的 Worker 路由，按 `host/*` pattern 反查真实 Worker 名（自定义命名的部署不断链）
      let routes: WorkerRoute[] = []
      try {
        routes = await workersApi.listRoutes(zone.id)
      } catch {
        // 取不到路由时降级：回退按命名约定推导
      }
      const found: AcceleratedZone[] = []
      for (const record of records) {
        const content = normalizeDomain(record.content)
        // 与 cococ 一致：CNAME 目标精确等于优选域名才算加速记录（子域后缀不算）
        const hit = domains.some((d) => content === d)
        if (!hit) continue
        // 已是 SaaS 优选 custom hostname 的访问域名，跳过（避免误判为 Worker 缺失的加速记录）
        if (saasHostnames.has(normalizeDomain(record.name))) continue
        // 以路由为准取真实 Worker 名，找不到匹配路由才回退推导名
        const route = routes.find((r) => normalizeDomain(r.pattern) === `${normalizeDomain(record.name)}/*`)
        const workerName = route?.script || generateWorkerName(record.name)
        found.push({
          zone,
          record,
          workerName,
          accelerated: scripts.has(workerName),
        })
      }
      return found
    }),
  )
  return perZone.flat()
}

/** 找到 accessDomain 所属的 zone（父子 zone 并存时取 name 最长的最精确命中） */
function findZoneForAccessDomain(zones: Zone[], accessDomain: string): Zone | undefined {
  const host = normalizeDomain(accessDomain)
  let best: Zone | undefined
  for (const z of zones) {
    const zname = normalizeDomain(z.name)
    if (host !== zname && !host.endsWith('.' + zname)) continue
    if (!best || zname.length > normalizeDomain(best.name).length) best = z
  }
  return best
}

/**
 * 部署一键加速。
 *
 * 步骤：
 *   ① 找到 accessDomain 对应的 zone
 *   ② 上传 Worker 脚本
 *   ③ 创建 Worker 路由（accessDomain/* → workerName）
 *   ④ 创建 CNAME 记录指向优选域名（proxied=false，访客 DNS 解析直达优选 CF IP）
 *
 * @param config 部署配置
 * @param onProgress 步骤进度回调
 */
export async function deployAccelerate(
  config: AccelerateConfig,
  onProgress?: (p: DeployProgress) => void,
): Promise<{ zone: Zone; record: DNSRecord; workerName: string }> {
  const { accessDomain, targetDomain, originDomain, workerName } = config

  // ① 确定访问域名所属 zone：优先用调用方指定的 zoneId（校验域名归属），未指定才按域名反查
  let zone: Zone
  if (config.zoneId) {
    zone = await zonesApi.get(config.zoneId)
    const host = normalizeDomain(accessDomain)
    const zname = normalizeDomain(zone.name)
    if (host !== zname && !host.endsWith('.' + zname)) {
      throw new Error(`访问域名 ${accessDomain} 不属于所选 zone ${zone.name}`)
    }
  } else {
    const zones = await zonesApi.listAll()
    const found = findZoneForAccessDomain(zones, accessDomain)
    if (!found) {
      throw new Error(`未找到访问域名 ${accessDomain} 所属的 zone，请先在 Cloudflare 添加该域名`)
    }
    zone = found
  }

  // 记录脚本是否在本次部署前已存在（失败回滚时只删本次新建的脚本，避免误伤既有脚本）
  let scriptExistedBefore = true
  try {
    const list = await workersApi.listScripts()
    scriptExistedBefore = list.some((s) => s.id === workerName)
  } catch {
    // 查不到清单时保守视为已存在（回滚时不删）
  }

  // 覆盖既有脚本前先备份旧代码，供后续步骤失败时恢复（备份失败则回滚时跳过恢复并注明）
  let scriptBackup: string | null = null
  if (scriptExistedBefore) {
    try {
      scriptBackup = await workersApi.getScriptContent(workerName)
    } catch {
      scriptBackup = null
    }
  }

  // ② 上传 Worker 脚本
  onProgress?.({ step: 'upload', message: '正在上传 Worker 脚本…', ok: true })
  const script = generateWorkerScript(targetDomain, config.cacheTtl)
  await workersApi.uploadScript(workerName, script)

  /**
   * 失败回滚：本次新建的脚本直接删除；覆盖的既有脚本用备份重新上传恢复。
   * 尽力而为，返回需附加进错误信息的说明（空串 = 无需说明）。
   */
  const rollbackScript = async (): Promise<string> => {
    if (!scriptExistedBefore) {
      try {
        await workersApi.deleteScript(workerName)
      } catch {
        // 回滚失败不再上抛，保留原始错误
      }
      return ''
    }
    if (scriptBackup == null) return '（既有脚本备份失败，未恢复旧代码）'
    try {
      await workersApi.uploadScript(workerName, scriptBackup)
      return ''
    } catch {
      return '（既有脚本恢复失败，当前仍为新代码）'
    }
  }

  // ③ 创建 Worker 路由：命中 duplicate 时查同 pattern 既有路由——
  //    script 与目标一致则跳过；指向其他 Worker 则更新其 script；找不到同 pattern 按原错误上抛
  onProgress?.({ step: 'dns', message: '正在配置 Worker 路由…', ok: true })
  const routePattern = `${accessDomain}/*`
  try {
    await workersApi.createRoute(zone.id, routePattern, workerName)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isDuplicate =
      (e instanceof CFError && e.code === 10020) || /already exists|duplicate|已存在/i.test(msg)
    if (!isDuplicate) {
      const note = await rollbackScript()
      throw new Error(`Worker 路由创建失败：${msg}${note}`)
    }
    let handled = false
    try {
      const routes = await workersApi.listRoutes(zone.id)
      const same = routes.find((r) => r.pattern === routePattern)
      if (same) {
        if (same.script === workerName) {
          onProgress?.({ step: 'dns', message: 'Worker 路由已存在，跳过创建', ok: true })
        } else {
          // 既有路由指向其他 Worker：PUT 更新其 script 指向新 Worker（workers.ts 无对应方法，直接走 http）
          await http.put<WorkerRoute>(`/zones/${zone.id}/workers/routes/${same.id}`, {
            body: { pattern: routePattern, script: workerName },
          })
          onProgress?.({ step: 'dns', message: '已更新既有路由指向新 Worker', ok: true })
        }
        handled = true
      }
    } catch (e2) {
      const note = await rollbackScript()
      throw new Error(`Worker 路由更新失败：${e2 instanceof Error ? e2.message : String(e2)}${note}`)
    }
    if (!handled) {
      // 报了 duplicate 却找不到同 pattern 路由，按原错误上抛
      const note = await rollbackScript()
      throw new Error(`Worker 路由创建失败：${msg}${note}`)
    }
  }

  // ④ 创建/更新 CNAME 指向优选域名（proxied=false / DNS Only）
  //    优选域名解析到优选 Cloudflare IP，访客经优选 IP 接入 CF 边缘后命中 Worker 路由——
  //     proxied=true 会让 CF 忽略 CNAME 目标直接返回标准任播 IP，优选完全失效（这正是修复前
  //    「一键加速没有用」的根因）。
  //    部署意图就是把域名指向加速入口：同名 A/AAAA 冲突记录先删除再建（否则 CNAME 必失败）；
  //    删除前保存完整 payload，新 CNAME 失败时依次重建被删记录，不让域名解析处于真空态
  let record: DNSRecord
  const deletedPayloads: DNSRecordPayload[] = []
  try {
    const sameName = await dnsApi.list(zone.id, { name: accessDomain })
    const conflicts = sameName.filter((r) => r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME')
    const existingCname = conflicts.find((r) => r.type === 'CNAME')
    const toDelete = conflicts.filter((r) => r.id !== existingCname?.id)
    // 逐条删除，成功一条记一条 payload（部分失败时只重建真正被删的，避免恢复出重复记录）
    for (const r of toDelete) {
      const payload: DNSRecordPayload = {
        type: r.type,
        name: r.name,
        content: r.content,
        ttl: r.ttl,
        proxied: r.proxied,
        comment: r.comment,
      }
      if (r.priority != null) payload.priority = r.priority
      await dnsApi.delete(zone.id, r.id)
      deletedPayloads.push(payload)
    }
    if (toDelete.length > 0) {
      const types = [...new Set(toDelete.map((r) => r.type))].join('/')
      onProgress?.({ step: 'dns', message: `已替换原有 ${types} 记录`, ok: true })
    }
    if (existingCname) {
      record = await dnsApi.update(zone.id, existingCname.id, {
        type: 'CNAME',
        name: accessDomain,
        content: originDomain,
        proxied: false,
        comment: '一键加速 CNAME',
      })
    } else {
      record = await dnsApi.create(zone.id, {
        type: 'CNAME',
        name: accessDomain,
        content: originDomain,
        proxied: false,
        comment: '一键加速 CNAME',
      })
    }
  } catch (e) {
    // CNAME 失败不阻断（脚本与路由已就位），尽力重建被删记录后向上抛出明确提示
    const restoreFailed: string[] = []
    for (const p of deletedPayloads) {
      try {
        await dnsApi.create(zone.id, p)
      } catch {
        restoreFailed.push(`${p.type} ${p.name}`)
      }
    }
    let extra = ''
    if (deletedPayloads.length > 0) {
      extra = restoreFailed.length
        ? `；被删记录恢复失败：${restoreFailed.join('、')}`
        : '；已恢复被删除的原记录'
    }
    throw new Error(
      `CNAME 配置失败：${e instanceof Error ? e.message : String(e)}（Worker 脚本与路由已创建）${extra}`,
    )
  }

  onProgress?.({ step: 'done', message: '部署完成', ok: true })
  return { zone, record, workerName }
}

/**
 * 移除加速：删 CNAME 记录 + 删 Worker 脚本 + 删 Worker 路由。
 * 单步失败不阻断其它步骤，最终聚合错误信息。
 */
export async function removeAccelerate(
  zoneId: string,
  recordId: string,
  workerName: string,
): Promise<void> {
  const errors: string[] = []

  // 删 CNAME
  try {
    await dnsApi.delete(zoneId, recordId)
  } catch (e) {
    errors.push(`CNAME 删除失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // 删 Worker 路由
  try {
    const routes = await workersApi.listRoutes(zoneId)
    const matched = routes.filter((r) => r.script === workerName)
    await Promise.all(matched.map((r) => workersApi.deleteRoute(zoneId, r.id)))
  } catch (e) {
    errors.push(`Worker 路由删除失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // 删 Worker 脚本
  try {
    await workersApi.deleteScript(workerName)
  } catch (e) {
    errors.push(`Worker 脚本删除失败：${e instanceof Error ? e.message : String(e)}`)
  }

  if (errors.length) {
    throw new Error(errors.join('；'))
  }
}
