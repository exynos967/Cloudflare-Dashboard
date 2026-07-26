/**
 * Cloudflare Pages Functions —— Cloudflare API 同源透传代理。
 *
 * 设计原则（区别于闭源第三方面板的关键安全点）：
 * 1. 纯透传：仅转发请求与响应，不解析、不存储、不记录任何凭据或响应体。
 * 2. 同源：前端调用 /api/cf/*，避免浏览器 CORS。
 * 3. 自部署、开源可审计：用户在自己 Cloudflare 账号下部署，凭据全程不离开自己的边界。
 *
 * 路径映射：/api/cf/client/v4/zones  →  https://api.cloudflare.com/client/v4/zones
 */

const UPSTREAM = 'https://api.cloudflare.com'

/** 转发请求到 Cloudflare API */
async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // 跨站防护：浏览器发起的跨站请求会带 Sec-Fetch-Site（cross-site），直接拒绝；
  // 同源前端（same-origin/same-site/none）与非浏览器工具（curl 等无此头）不受影响
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite)) {
    return new Response(
      JSON.stringify({ success: false, errors: [{ code: 0, message: '跨站请求被拒绝' }] }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )
  }

  // 去掉 /api/cf 前缀，保留后续 path + query
  const cfPath = url.pathname.replace(/^\/api\/cf/, '') + url.search
  const target = UPSTREAM + cfPath

  // 透传请求头，剥离可能干扰上游或暴露内部信息的头（cookie 与上游无关，一并剥离）
  const headers = new Headers(request.headers)
  for (const h of [
    'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
    'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
    'cdn-loop', 'true-client-ip', 'cookie',
  ]) {
    headers.delete(h)
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
  }

  let upstream: Response
  try {
    upstream = await fetch(target, init)
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, errors: [{ code: 0, message: `代理请求失败：${e instanceof Error ? e.message : String(e)}` }] }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  // 透传响应，附加同源 CORS（保险，前端本就同源）
  const respHeaders = new Headers(upstream.headers)
  respHeaders.set('access-control-allow-origin', url.origin)
  respHeaders.set('access-control-allow-credentials', 'true')
  // 移除可能阻止浏览器读取的头
  respHeaders.delete('x-frame-options')
  // 剥离上游 set-cookie（如 __cfruid）：透传会把它种到面板域名下，纯脏数据
  respHeaders.delete('set-cookie')

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  })
}

/** CORS 预检 */
function preflight(request: Request): Response {
  const url = new URL(request.url)
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': url.origin,
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, X-Auth-Email, X-Auth-Key',
      'access-control-allow-credentials': 'true',
      'access-control-max-age': '86400',
    },
  })
}

// biome-ignore lint/suspicious/noExplicitAny: Pages Function context 类型由运行时提供
type Ctx = any

export const onRequestGet = (ctx: Ctx) => proxy(ctx.request as Request)
export const onRequestPost = (ctx: Ctx) => proxy(ctx.request as Request)
export const onRequestPut = (ctx: Ctx) => proxy(ctx.request as Request)
export const onRequestPatch = (ctx: Ctx) => proxy(ctx.request as Request)
export const onRequestDelete = (ctx: Ctx) => proxy(ctx.request as Request)
export const onRequestHead = (ctx: Ctx) => proxy(ctx.request as Request)
export const onRequestOptions = (ctx: Ctx) => preflight(ctx.request as Request)
