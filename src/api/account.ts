import type { CFAccount, CFResponse } from '@/types/cloudflare'
import type { AuthType } from '@/stores/auth'

const BASE = '/api/cf/client/v4'

function credHeaders(cred: { authType: AuthType; email?: string; apiKey: string }): Record<string, string> {
  return cred.authType === 'token'
    ? { Authorization: `Bearer ${cred.apiKey}` }
    : { 'X-Auth-Email': cred.email ?? '', 'X-Auth-Key': cred.apiKey }
}

export interface VerifyResult {
  ok: boolean
  error?: string
  accounts?: CFAccount[]
}

/**
 * 验证凭据有效性。登录前调用，绕过 auth store（此时还未登录）。
 * - token 模式：先 GET /user/tokens/verify 校验 token 本身
 * - 两种模式都尝试 GET /accounts 拉取账户列表，供后续 account 维度调用
 */
export async function verifyCredentials(cred: {
  authType: AuthType
  email?: string
  apiKey: string
}): Promise<VerifyResult> {
  const headers = credHeaders(cred)

  // token 校验：网络错误 / 非 JSON 响应统一归一为可读的失败结果，不向上抛
  if (cred.authType === 'token') {
    try {
      const r = await fetch(`${BASE}/user/tokens/verify`, { headers })
      const d = (await r.json()) as CFResponse<unknown>
      if (!d.success) {
        return { ok: false, error: d.errors?.[0]?.message ?? 'API Token 无效' }
      }
    } catch (e) {
      return {
        ok: false,
        error: `Token 校验请求失败：${e instanceof Error ? e.message : String(e)}（请检查网络与同源代理 /api/cf）`,
      }
    }
  }

  try {
    const r = await fetch(`${BASE}/accounts`, { headers })
    const d = (await r.json()) as CFResponse<CFAccount[]>
    if (!r.ok || !d.success) {
      return {
        ok: false,
        error:
          cred.authType === 'token'
            ? 'Token 需要包含 Account:Read 权限（本面板依赖账号 ID）'
            : d.errors?.[0]?.message ?? `凭据验证失败（HTTP ${r.status}）`,
      }
    }
    return { ok: true, accounts: d.result ?? [] }
  } catch (e) {
    // 网络错误（fetch TypeError）或响应非 JSON（如网关 HTML）：属连通性问题而非权限问题，
    // 附原始原因，不再误报成 Token 权限不足
    return {
      ok: false,
      error: `无法连接同源代理 /api/cf：${e instanceof Error ? e.message : String(e)}（请检查网络与部署状态）`,
    }
  }
}
