/**
 * Cloudflare API 资源类型定义
 * 仅包含当前已实现模块用到的类型，按需增量扩展。
 */

/** Cloudflare API 统一响应壳 */
export interface CFResponse<T> {
  result: T | null
  result_info?: ResultInfo
  success: boolean
  errors: CFError[]
  messages: CFMessage[]
}

export interface CFError {
  code: number
  message: string
}

export interface CFMessage {
  code: number
  message: string
}

/** 分页信息（部分端点为 cursor 分页，字段均可能缺失） */
export interface ResultInfo {
  page?: number
  per_page?: number
  total_pages?: number
  count?: number
  total_count?: number
  cursor?: string
}

export interface Paginated<T> {
  result: T[]
  result_info: ResultInfo
}

/* ---------- 账户 / Zone ---------- */

export interface CFAccount {
  id: string
  name: string
}

export interface Zone {
  id: string
  name: string
  status: string
  paused: boolean
  type: string
  development_mode: number
  name_servers: string[]
  original_name_servers: string[] | null
  original_registrar: string | null
  original_dnshost: string | null
  account: CFAccount
  permissions: string[]
  plan?: { id: string; name: string; legacy_id: string; is_subscribed: boolean; expiry: string | null }
  activated_on: string | null
  modified_on: string
}

/* ---------- DNS ---------- */

export type DNSRecordType =
  | 'A' | 'AAAA' | 'CAA' | 'CERT' | 'CNAME' | 'DNSKEY' | 'DS' | 'HTTPS'
  | 'LOC' | 'MX' | 'NAPTR' | 'NS' | 'PTR' | 'SMIMEA' | 'SRV' | 'SSHFP'
  | 'SVCB' | 'TLSA' | 'TXT' | 'URI'

export interface DNSRecord {
  id: string
  zone_id: string
  zone_name: string
  name: string
  type: DNSRecordType
  content: string
  priority?: number
  ttl: number
  proxied: boolean
  proxiable: boolean
  /** CF 托管锁定（如 Worker Custom Domain 绑定的记录，proxied 等不可改） */
  locked?: boolean
  /** SRV/CAA/TLSA 等结构化记录的字段对象（content 仅为只读展示） */
  data?: Record<string, unknown>
  comment?: string
  tags?: string[]
  created_on: string
  modified_on: string
}

export interface DNSRecordPayload {
  type: DNSRecordType
  name: string
  /** 普通记录的值；SRV/CAA/TLSA 等结构化记录改用 data，不提交 content */
  content?: string
  /** SRV/CAA/TLSA 等结构化记录的字段对象 */
  data?: Record<string, unknown>
  ttl?: number
  priority?: number
  proxied?: boolean
  comment?: string
  tags?: string[]
}

/* ---------- Workers ---------- */

export interface WorkerScript {
  id: string
  etag: string
  handlers: string[]
  modified_on: string
  created_on: string
  usage_model: string
}

export interface WorkerRoute {
  id: string
  pattern: string
  script: string
}

export interface WorkerDomain {
  id: string
  hostname: string
  service: string
  environment: string
  zone_id: string
  zone_name: string
}

export interface WorkersSubdomain {
  subdomain: string
  enabled: boolean
}

/* ---------- KV ---------- */

export interface KVNamespace {
  id: string
  title: string
  supports_url_encoding: boolean
  expires?: string
  created_on?: string
  modified_on?: string
}

export interface KVKey {
  name: string
  expiration?: number
  expiration_ttl?: number
  metadata?: unknown
}

/* ---------- R2 ---------- */

export interface R2Bucket {
  name: string
  creation_date: string
  location: 'apac' | 'eeur' | 'enam' | 'weur' | 'wnam' | 'oc' | 'auto'
  usage?: { payloadSize: number; uploadedBytes: string; uploadedPercent: number }
}

/** R2 对象。注意：CF REST API 返回的对象名字段是 key（不是 name） */
export interface R2Object {
  key: string
  size: number
  etag: string
  last_modified: string
  http_metadata?: Record<string, unknown>
}

/* ---------- D1 ---------- */

export interface D1Database {
  uuid: string
  name: string
  created_at: string
  file_size: number
}

export interface D1QueryResult {
  results: Record<string, unknown>[]
  success: boolean
  meta: Record<string, unknown>
}

/* ---------- Pages ---------- */

export interface PagesProject {
  name: string
  subdomain: string
  domains: string[]
  deployment_configs: Record<string, unknown>
  source?: { message: string }
  created_on: string
  modified_on: string
}

export interface PagesDeployment {
  id: string
  environment: 'production' | 'preview'
  created_on: string
  modified_on: string
  latest_stage: { name: string; status: string }
  source?: { message: string }
  deployment_trigger?: { metadata?: { commit_message?: string } }
}

/* ---------- SSL ---------- */

export interface SSLUniversal {
  enabled: boolean
  certificate_status: string
  validation_method?: string
  http_status: string
}

/* ---------- Cloudflare for SaaS (Custom Hostnames) ---------- */

/** Custom Hostname 的 SSL/证书验证信息 */
export interface CustomHostnameSSL {
  id: string
  /** 证书状态：pending_validation | pending_deployment | active | ... */
  status: string
  /** 验证方式：http | txt | delegated */
  method: string
  type?: string
  wildcard?: boolean
  cname?: { name: string; target: string }
  txt?: { name: string; value: string }
  http_body?: string
  http_url?: string
  expires_on?: string
}

/** Custom Hostname（接入的访问域名） */
export interface CustomHostname {
  id: string
  hostname: string
  /** 主机名状态：pending | active | moved | ... */
  status: string
  custom_origin_server?: string
  custom_origin?: string
  ssl: CustomHostnameSSL | null
  created_on: string
  modified_on: string
}

/** Zone 级回退源（fallback origin） */
export interface FallbackOrigin {
  origin: string
  status?: string
}

/* ---------- Analytics (GraphQL) ---------- */

export interface AnalyticsResponse {
  data: {
    viewer: Record<string, unknown>
  }
  errors?: CFError[]
}
