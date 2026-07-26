import { http, listAll } from './client'
import { useAuthStore } from '@/stores/auth'

/** 取当前账号的 Cloudflare account id（account 维度调用的前缀） */
function accountId(): string {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录')
  return acc.accountId
}

/** Tunnel 连接信息 */
export interface TunnelConnection {
  id: string
  colo_name: string
  is_pending_reconnect: boolean
  origin_ip: string
  opened_at: string
}

/** Tunnel 配置项（简化只读展示） */
/** Tunnel ingress 规则（路由：hostname+path → service，service 含端口如 http://localhost:8080） */
export interface IngressRule {
  /** 匹配的主机名（可选，省略 = catch-all） */
  hostname?: string
  /** 匹配路径正则（可选） */
  path?: string
  /** 转发目标，如 http://localhost:8080 / https://10.0.1.5:443 / http_status:404 */
  service: string
}

/** Tunnel 配置体（对应 cloudflared config.yml 的 config 段） */
export interface TunnelConfigBody {
  ingress: IngressRule[]
  originRequest?: {
    /** 超时秒数（官方 SDK 定义为 number） */
    connectTimeout?: number
    tlsTimeout?: number
    noTLSVerify?: boolean
    httpHostHeader?: string
  }
  'warp-routing'?: { enabled?: boolean }
}

export interface TunnelConfig {
  /** 从未配置过的隧道 config 为 null */
  config: TunnelConfigBody | null
  tunnel_id: string
  version: string
}

/** Tunnel 资源 */
export interface Tunnel {
  id: string
  account_tag: string
  name: string
  created_at: string
  connections: TunnelConnection[] | null
  remote_id: string | null
  status: string
  remote_address: string | null
  tun_type: string | null
}

export const tunnelApi = {
  /** 列出账号下所有 Tunnel（排除已删除的幽灵隧道，自动翻页） */
  listTunnels: () =>
    listAll<Tunnel>(`/accounts/${accountId()}/cfd_tunnel`, { is_deleted: false }),

  /** 创建 Tunnel（config_src=cloudflare：ingress 配置由云端管理，否则默认 local 不生效） */
  createTunnel: (name: string) =>
    http.post<Tunnel>(`/accounts/${accountId()}/cfd_tunnel`, {
      body: { name, config_src: 'cloudflare' },
    }),

  /** 获取 Tunnel 连接 token（cloudflared run --token 使用，result 即 token 字符串） */
  getTunnelToken: (tunnelId: string) =>
    http.get<string>(`/accounts/${accountId()}/cfd_tunnel/${tunnelId}/token`),

  /** 删除 Tunnel（需先断开所有 cloudflared 连接） */
  deleteTunnel: (id: string) => http.delete<void>(`/accounts/${accountId()}/cfd_tunnel/${id}`),

  /** 查看 Tunnel 当前活跃连接 */
  getConnections: (id: string) =>
    http.get<TunnelConnection[]>(`/accounts/${accountId()}/cfd_tunnel/${id}/connections`),

  /** 查看 Tunnel 配置（从未配置过的隧道返回 null / config 为 null） */
  getConfig: (id: string) =>
    http.get<TunnelConfig | null>(`/accounts/${accountId()}/cfd_tunnel/${id}/configurations`),

  /** 写入 Tunnel 配置（ingress 规则等，云端管理） */
  putConfig: (id: string, config: TunnelConfigBody) =>
    http.put<TunnelConfig>(`/accounts/${accountId()}/cfd_tunnel/${id}/configurations`, {
      body: { config },
    }),
}
