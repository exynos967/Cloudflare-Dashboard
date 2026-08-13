<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { RefreshCw, Loader2, ShieldAlert, Globe, Plus, Trash2, Flame, Layers, Link2 } from '@lucide/vue'
import { securityApi } from '@/api'
import type {
  CertificatePack,
  CertificatePackCert,
  FirewallAccessRule,
  FirewallRulePayload,
  RulesetRule,
  PageRule,
  PageRuleAction,
} from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{ zoneId: string }>()

/* ----------------------------- 边缘证书 ----------------------------- */

const packs = ref<CertificatePack[]>([])
const certsLoading = ref(false)
const certsError = ref('')

/** 扁平化证书行：pack + pack 内每个 cert */
interface CertRow {
  packId: string
  packType: string
  packStatus: string
  cert: CertificatePackCert
}
const certRows = computed<CertRow[]>(() =>
  packs.value.flatMap((p) =>
    (p.certificates ?? []).map((cert) => ({
      packId: p.id,
      packType: p.type,
      packStatus: p.status,
      cert,
    })),
  ),
)

async function loadCerts() {
  if (!props.zoneId) return
  certsLoading.value = true
  certsError.value = ''
  packs.value = [] // 加载前清空，避免失败时残留旧 zone 数据
  try {
    packs.value = await securityApi.listCerts(props.zoneId)
  } catch (e) {
    certsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    certsLoading.value = false
  }
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}

function certStatusClass(s: string): string {
  if (s === 'active' || s === 'ready') return 'bg-emerald-500/15 text-emerald-600'
  if (s === 'pending') return 'bg-amber-500/15 text-amber-600'
  return 'bg-muted text-muted-foreground'
}

/* ----------------------------- WAF 自定义规则（zone 维度） ----------------------------- */

const wafRules = ref<RulesetRule[]>([])
const wafRulesLoading = ref(false)
const wafRulesError = ref('')

async function loadWafRules() {
  if (!props.zoneId) return
  wafRulesLoading.value = true
  wafRulesError.value = ''
  wafRules.value = []
  try {
    const snap = await securityApi.listFirewallRules(props.zoneId)
    wafRules.value = snap.rules
  } catch (e) {
    wafRulesError.value = e instanceof Error ? e.message : String(e)
  } finally {
    wafRulesLoading.value = false
  }
}

const WAF_ACTION_LABEL: Record<string, string> = {
  block: '阻止',
  challenge: '质询',
  js_challenge: 'JS 质询',
  managed_challenge: '托管质询',
  log: '记录',
  skip: '跳过',
}

function wafActionClass(a: string): string {
  if (a === 'block') return 'bg-red-500/15 text-red-600'
  if (a.includes('challenge')) return 'bg-amber-500/15 text-amber-600'
  // skip 是"跳过后续规则"而非放行，用中性色避免误读为安全放行
  return 'bg-muted text-muted-foreground'
}

interface WafTemplate {
  id: string
  label: string
  expression: string
  action: FirewallRulePayload['action']
  description: string
}

/** 常用模板：表达式字段用官方 ip.src.country，不用已弃用的 ip.geoip.* */
const WAF_TEMPLATES: WafTemplate[] = [
  {
    id: 'non_cn',
    label: '拦截非中国流量',
    expression: '(not ip.src.country in {"CN"})',
    action: 'block',
    description: '拦截非中国流量',
  },
  {
    id: 'non_get',
    label: '拦截非 GET/HEAD',
    expression: '(not http.request.method in {"GET" "HEAD"})',
    action: 'block',
    description: '拦截非 GET/HEAD 请求',
  },
  {
    id: 'has_query',
    label: '拦截带查询参数',
    expression: '(http.request.uri.query ne "")',
    action: 'block',
    description: '拦截带查询参数的请求',
  },
  {
    id: 'empty_ua',
    label: '拦截空 User-Agent',
    expression: '(http.user_agent eq "")',
    action: 'block',
    description: '拦截空 User-Agent',
  },
  {
    id: 'custom',
    label: '自定义表达式',
    expression: '',
    action: 'block',
    description: '',
  },
]

const WAF_CREATE_ACTIONS = ['block', 'managed_challenge', 'js_challenge', 'challenge', 'log', 'skip'] as const

const addWafOpen = ref(false)
const creatingWaf = ref(false)
const wafForm = ref({
  template: 'non_cn',
  expression: WAF_TEMPLATES[0].expression,
  action: 'block' as string,
  description: WAF_TEMPLATES[0].description,
})

function openAddWaf() {
  const t = WAF_TEMPLATES[0]
  wafForm.value = { template: t.id, expression: t.expression, action: t.action, description: t.description }
  addWafOpen.value = true
}

function applyWafTemplate(id: string) {
  const t = WAF_TEMPLATES.find((x) => x.id === id) ?? WAF_TEMPLATES[0]
  wafForm.value.template = t.id
  wafForm.value.expression = t.expression
  wafForm.value.action = t.action
  wafForm.value.description = t.description
}

async function submitAddWaf() {
  if (!props.zoneId) return
  const expression = wafForm.value.expression.trim()
  if (!expression) {
    toast.error('请填写匹配表达式')
    return
  }
  creatingWaf.value = true
  try {
    await securityApi.createFirewallRule(props.zoneId, {
      action: wafForm.value.action,
      expression,
      description: wafForm.value.description.trim() || undefined,
      enabled: true,
    })
    toast.success('WAF 规则已创建')
    addWafOpen.value = false
    await loadWafRules()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creatingWaf.value = false
  }
}

const wafToggling = ref<string | null>(null)

async function toggleWafEnabled(rule: RulesetRule, enabled: boolean) {
  if (!props.zoneId || wafToggling.value) return
  wafToggling.value = rule.id
  try {
    await securityApi.setFirewallRuleEnabled(props.zoneId, rule, enabled)
    rule.enabled = enabled
    toast.success(enabled ? '已启用' : '已禁用')
  } catch (e) {
    toast.error('切换失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    wafToggling.value = null
  }
}

const deleteWafTarget = ref<RulesetRule | null>(null)
const deletingWaf = ref(false)

async function confirmDeleteWaf() {
  if (!deleteWafTarget.value || !props.zoneId) return
  deletingWaf.value = true
  try {
    await securityApi.deleteFirewallRule(props.zoneId, deleteWafTarget.value.id)
    toast.success('已删除')
    deleteWafTarget.value = null
    await loadWafRules()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingWaf.value = false
  }
}

/* ----------------------------- 缓存规则（zone 维度） ----------------------------- */

const cacheRules = ref<RulesetRule[]>([])
const cacheRulesLoading = ref(false)
const cacheRulesError = ref('')

async function loadCacheRules() {
  if (!props.zoneId) return
  cacheRulesLoading.value = true
  cacheRulesError.value = ''
  cacheRules.value = []
  try {
    const snap = await securityApi.listCacheRules(props.zoneId)
    cacheRules.value = snap.rules
  } catch (e) {
    cacheRulesError.value = e instanceof Error ? e.message : String(e)
  } finally {
    cacheRulesLoading.value = false
  }
}

const addCacheOpen = ref(false)
const creatingCache = ref(false)
const cacheForm = ref({
  expression: 'true',
  description: '缓存所有内容',
})

function openAddCache() {
  cacheForm.value = { expression: 'true', description: '缓存所有内容' }
  addCacheOpen.value = true
}

async function submitAddCache() {
  if (!props.zoneId) return
  const expression = cacheForm.value.expression.trim()
  if (!expression) {
    toast.error('请填写匹配表达式')
    return
  }
  creatingCache.value = true
  try {
    await securityApi.createCacheRule(props.zoneId, {
      expression,
      description: cacheForm.value.description.trim() || undefined,
    })
    toast.success('缓存规则已创建')
    addCacheOpen.value = false
    await loadCacheRules()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creatingCache.value = false
  }
}

const deleteCacheTarget = ref<RulesetRule | null>(null)
const deletingCache = ref(false)

async function confirmDeleteCache() {
  if (!deleteCacheTarget.value || !props.zoneId) return
  deletingCache.value = true
  try {
    await securityApi.deleteCacheRule(props.zoneId, deleteCacheTarget.value.id)
    toast.success('已删除')
    deleteCacheTarget.value = null
    await loadCacheRules()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingCache.value = false
  }
}

/* ----------------------------- 重定向规则 ----------------------------- */

const redirectRules = ref<RulesetRule[]>([])
const redirectLoading = ref(false)
const redirectError = ref('')

async function loadRedirectRules() {
  if (!props.zoneId) return
  redirectLoading.value = true
  redirectError.value = ''
  redirectRules.value = []
  try {
    const snap = await securityApi.listRedirectRules(props.zoneId)
    redirectRules.value = snap.rules
  } catch (e) {
    redirectError.value = e instanceof Error ? e.message : String(e)
  } finally {
    redirectLoading.value = false
  }
}

function redirectTarget(r: RulesetRule): string {
  const fv = r.action_parameters?.from_value as
    | { target_url?: { value?: string; expression?: string }; status_code?: number }
    | undefined
  return fv?.target_url?.value || fv?.target_url?.expression || '—'
}

function redirectStatus(r: RulesetRule): string {
  const fv = r.action_parameters?.from_value as { status_code?: number } | undefined
  return fv?.status_code != null ? String(fv.status_code) : '—'
}

const addRedirectOpen = ref(false)
const creatingRedirect = ref(false)
const redirectForm = ref({
  source: '',
  target: '',
  status: '301' as '301' | '302' | '307' | '308',
  preserveQuery: true,
  description: '',
  customExpr: false,
  expression: '',
})

function openAddRedirect() {
  redirectForm.value = {
    source: '',
    target: '',
    status: '301',
    preserveQuery: true,
    description: '',
    customExpr: false,
    expression: '',
  }
  addRedirectOpen.value = true
}

function escapeCfString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildRedirectExpression(): string | null {
  if (redirectForm.value.customExpr) {
    const e = redirectForm.value.expression.trim()
    if (!e) {
      toast.error('请填写匹配表达式')
      return null
    }
    return e
  }
  const src = redirectForm.value.source.trim()
  if (!src) {
    toast.error('请填写来源路径或 URL')
    return null
  }
  if (src.startsWith('http://') || src.startsWith('https://')) {
    if (src.includes('*')) return `(http.request.full_uri wildcard "${escapeCfString(src)}")`
    return `(http.request.full_uri eq "${escapeCfString(src)}")`
  }
  const path = src.startsWith('/') ? src : `/${src}`
  if (path.endsWith('*')) return `(http.request.uri.path wildcard "${escapeCfString(path)}")`
  return `(http.request.uri.path eq "${escapeCfString(path)}")`
}

async function submitAddRedirect() {
  if (!props.zoneId) return
  const expression = buildRedirectExpression()
  if (!expression) return
  const target = redirectForm.value.target.trim()
  if (!target) {
    toast.error('请填写目标 URL')
    return
  }
  try {
    new URL(target)
  } catch {
    toast.error('目标须为完整 URL，如 https://example.com/new')
    return
  }
  creatingRedirect.value = true
  try {
    await securityApi.createRedirectRule(props.zoneId, {
      expression,
      description: redirectForm.value.description.trim() || undefined,
      statusCode: Number(redirectForm.value.status) as 301 | 302 | 307 | 308,
      targetUrl: target,
      preserveQuery: redirectForm.value.preserveQuery,
      enabled: true,
    })
    toast.success('重定向规则已创建')
    addRedirectOpen.value = false
    await loadRedirectRules()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creatingRedirect.value = false
  }
}

const deleteRedirectTarget = ref<RulesetRule | null>(null)
const deletingRedirect = ref(false)
const redirectToggling = ref<string | null>(null)

async function toggleRedirectEnabled(rule: RulesetRule, enabled: boolean) {
  if (!props.zoneId || redirectToggling.value) return
  redirectToggling.value = rule.id
  try {
    await securityApi.setRedirectRuleEnabled(props.zoneId, rule, enabled)
    rule.enabled = enabled
    toast.success(enabled ? '已启用' : '已禁用')
  } catch (e) {
    toast.error('切换失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    redirectToggling.value = null
  }
}

async function confirmDeleteRedirect() {
  if (!deleteRedirectTarget.value || !props.zoneId) return
  deletingRedirect.value = true
  try {
    await securityApi.deleteRedirectRule(props.zoneId, deleteRedirectTarget.value.id)
    toast.success('已删除')
    deleteRedirectTarget.value = null
    await loadRedirectRules()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingRedirect.value = false
  }
}

/* ----------------------------- IP 访问规则 ----------------------------- */

const accessRules = ref<FirewallAccessRule[]>([])
const rulesLoading = ref(false)
const rulesError = ref('')

async function loadAccessRules() {
  if (!props.zoneId) return
  rulesLoading.value = true
  rulesError.value = ''
  accessRules.value = []
  try {
    accessRules.value = await securityApi.listAccessRules(props.zoneId)
  } catch (e) {
    rulesError.value = e instanceof Error ? e.message : String(e)
  } finally {
    rulesLoading.value = false
  }
}

const MODE_LABEL: Record<string, string> = {
  block: '阻止',
  challenge: '质询',
  whitelist: '允许',
  js_challenge: 'JS 质询',
  managed_challenge: '托管质询',
}

function modeClass(m: string): string {
  if (m === 'block') return 'bg-red-500/15 text-red-600'
  if (m === 'whitelist') return 'bg-emerald-500/15 text-emerald-600'
  if (m.includes('challenge')) return 'bg-amber-500/15 text-amber-600'
  return 'bg-muted text-muted-foreground'
}

/* ----------------------------- 添加访问规则 ----------------------------- */

const addOpen = ref(false)
const creating = ref(false)
const form = ref({
  mode: 'block' as FirewallAccessRule['mode'],
  target: 'ip' as 'ip' | 'ip6' | 'ip_range' | 'country' | 'asn',
  value: '',
  notes: '',
})

const TARGET_LABEL: Record<string, string> = {
  ip: 'IP 地址',
  ip6: 'IPv6 地址',
  ip_range: 'IP 段 (CIDR)',
  country: '国家代码',
  asn: 'ASN',
}

const TARGET_PLACEHOLDER: Record<string, string> = {
  ip: '如 1.2.3.4',
  ip6: '如 2001:db8::1',
  ip_range: '如 1.2.3.0/24（IPv4 仅 /16、/24；IPv6 仅 /32、/48、/64）',
  country: '如 CN',
  asn: '如 AS13335',
}

function openAdd() {
  form.value = { mode: 'block', target: 'ip', value: '', notes: '' }
  addOpen.value = true
}

/** IPv4 严格校验：四段十进制，每段 0-255 */
function isIPv4(s: string): boolean {
  const parts = s.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** IPv6 简版校验：按 :: 拆分，段为 1-4 位 hex；无 :: 时须 8 段，有 :: 时最多 7 段 */
function isIPv6(s: string): boolean {
  const halves = s.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap((h) => (h === '' ? [] : h.split(':')))
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8
}

/** 按目标类型校验并归一化规则值；非法时 toast 提示并返回 null */
function normalizeRuleValue(): string | null {
  const v = form.value.value.trim()
  if (!v) {
    toast.error('请输入规则值')
    return null
  }
  const t = form.value.target
  if (t === 'ip') {
    if (!isIPv4(v)) {
      toast.error('请输入合法的 IPv4 地址，如 1.2.3.4')
      return null
    }
    return v
  }
  if (t === 'ip6') {
    if (!isIPv6(v)) {
      toast.error('请输入合法的 IPv6 地址，如 2001:db8::1')
      return null
    }
    return v
  }
  if (t === 'ip_range') {
    const parts = v.split('/')
    if (parts.length !== 2) {
      toast.error('IP 段需为 CIDR 格式，如 1.2.3.0/24')
      return null
    }
    const [addr, prefix] = parts
    // Cloudflare 官方限制：IPv4 仅 /16、/24；IPv6 仅 /32、/48、/64
    if (isIPv4(addr)) {
      if (!['16', '24'].includes(prefix)) {
        toast.error('IPv4 网段仅支持 /16、/24 前缀（Cloudflare 限制）')
        return null
      }
      return v
    }
    if (isIPv6(addr)) {
      if (!['32', '48', '64'].includes(prefix)) {
        toast.error('IPv6 网段仅支持 /32、/48、/64 前缀（Cloudflare 限制）')
        return null
      }
      return v
    }
    toast.error('IP 段需为合法的 IPv4/IPv6 CIDR，如 1.2.3.0/24')
    return null
  }
  if (t === 'asn') {
    if (!/^(AS)?\d+$/i.test(v)) {
      toast.error('ASN 格式不正确，如 AS13335')
      return null
    }
    // 归一化为官方格式：大写 AS 前缀
    return `AS${v.replace(/^as/i, '')}`
  }
  // country：两位字母国家代码，统一大写提交
  if (!/^[A-Za-z]{2}$/.test(v)) {
    toast.error('国家代码为两位字母，如 CN')
    return null
  }
  return v.toUpperCase()
}

async function submitAdd() {
  const v = normalizeRuleValue()
  if (v == null) return
  if (!props.zoneId) return
  creating.value = true
  try {
    await securityApi.createAccessRule(props.zoneId, {
      mode: form.value.mode,
      notes: form.value.notes.trim() || undefined,
      configuration: { target: form.value.target, value: v },
    })
    toast.success('访问规则已添加')
    addOpen.value = false
    await loadAccessRules()
  } catch (e) {
    toast.error('添加失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creating.value = false
  }
}

/* ----------------------------- 删除访问规则 ----------------------------- */

const deleteTarget = ref<FirewallAccessRule | null>(null)
const deleting = ref(false)

async function confirmDelete() {
  if (!deleteTarget.value || !props.zoneId) return
  deleting.value = true
  try {
    await securityApi.deleteAccessRule(props.zoneId, deleteTarget.value.id)
    toast.success('已删除')
    deleteTarget.value = null
    await loadAccessRules()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

/* ----------------------------- Page Rules ----------------------------- */

const pageRules = ref<PageRule[]>([])
const pageRulesLoading = ref(false)
const pageRulesError = ref('')

async function loadPageRules() {
  if (!props.zoneId) return
  pageRulesLoading.value = true
  pageRulesError.value = ''
  pageRules.value = []
  try {
    pageRules.value = await securityApi.listPageRules(props.zoneId)
  } catch (e) {
    pageRulesError.value = e instanceof Error ? e.message : String(e)
  } finally {
    pageRulesLoading.value = false
  }
}

/** Page Rule 动作定义：input 决定表单控件与 value 组装方式 */
interface PageActionDef {
  id: string
  label: string
  /** none: 无值；select: 枚举下拉；number: 整数秒；forwarding: URL + 状态码 */
  input: 'none' | 'select' | 'number' | 'forwarding'
  options?: { value: string; label: string }[]
  defaultValue?: string
}

const ACTION_OPTIONS: PageActionDef[] = [
  {
    id: 'ssl',
    label: 'SSL',
    input: 'select',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'flexible', label: '灵活' },
      { value: 'full', label: '完全' },
      { value: 'strict', label: '完全（严格）' },
    ],
    defaultValue: 'full',
  },
  { id: 'always_use_https', label: 'Always Use HTTPS', input: 'none' },
  {
    id: 'cache_level',
    label: '缓存级别',
    input: 'select',
    options: [
      { value: 'bypass', label: '绕过' },
      { value: 'basic', label: '基本' },
      { value: 'simplified', label: '简化' },
      { value: 'aggressive', label: '标准' },
      { value: 'cache_everything', label: '缓存所有内容' },
    ],
    defaultValue: 'cache_everything',
  },
  { id: 'browser_cache_ttl', label: '浏览器缓存 TTL', input: 'number' },
  { id: 'edge_cache_ttl', label: '边缘缓存 TTL', input: 'number' },
  { id: 'forwarding_url', label: '转发 URL', input: 'forwarding' },
]

function actionLabel(id: string): string {
  return ACTION_OPTIONS.find((a) => a.id === id)?.label ?? id
}

function fmtActionValue(v: PageRuleAction['value']): string {
  if (v == null) return ''
  if (typeof v === 'object') return `=${v.url} (${v.status_code})`
  return `=${v}`
}

function summarizeActions(actions: PageRuleAction[]): string {
  return actions.map((a) => `${actionLabel(a.id)}${fmtActionValue(a.value)}`).join(', ')
}

/* ----------------------------- 新建 Page Rule ----------------------------- */

const addPageOpen = ref(false)
const creatingPage = ref(false)
const pageForm = ref({
  url: '',
  action: 'cache_level',
  /** select / number 型动作的值（number 型为输入框字符串，提交时转整数） */
  value: 'cache_everything',
  /** forwarding_url 专用：目标 URL 与重定向状态码 */
  fwdUrl: '',
  fwdStatus: '302' as '301' | '302',
  priority: 1,
  status: 'active' as 'active' | 'disabled',
})

function openAddPage() {
  pageForm.value = { url: '', action: 'cache_level', value: 'cache_everything', fwdUrl: '', fwdStatus: '302', priority: 1, status: 'active' }
  addPageOpen.value = true
}

const currentActionDef = computed(
  () => ACTION_OPTIONS.find((a) => a.id === pageForm.value.action) ?? ACTION_OPTIONS[0],
)

// 切换动作时把 value 重置为该动作的默认值，避免残留上一动作的取值
watch(
  () => pageForm.value.action,
  () => {
    pageForm.value.value = currentActionDef.value.defaultValue ?? ''
  },
)

/** 按动作类型组装 action payload；输入非法时提示并返回 null */
function buildPageAction(): PageRuleAction | null {
  const def = currentActionDef.value
  if (def.input === 'none') return { id: def.id }
  if (def.input === 'forwarding') {
    const target = pageForm.value.fwdUrl.trim()
    if (!target) {
      toast.error('请输入转发目标 URL')
      return null
    }
    // 用 URL 构造器校验合法性，且仅允许 http/https 协议
    try {
      const u = new URL(target)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
    } catch {
      toast.error('转发目标需为合法的 http/https URL')
      return null
    }
    return { id: def.id, value: { url: target, status_code: Number(pageForm.value.fwdStatus) } }
  }
  if (def.input === 'number') {
    // 先拦截空输入，避免 Number('') === 0 被当作合法 TTL 提交
    if (pageForm.value.value.trim() === '') {
      toast.error('请输入 TTL（秒）')
      return null
    }
    const n = Number(pageForm.value.value)
    // browser_cache_ttl 允许 0（CF 语义：尊重源站响应头）；edge_cache_ttl 必须为正
    const min = def.id === 'browser_cache_ttl' ? 0 : 1
    if (!Number.isInteger(n) || n < min) {
      toast.error(min === 0 ? 'TTL 必须为非负整数（秒，0 = 尊重源站响应头）' : 'TTL 必须为正整数（秒）')
      return null
    }
    return { id: def.id, value: n }
  }
  return { id: def.id, value: pageForm.value.value }
}

async function submitAddPage() {
  if (!props.zoneId) return
  const url = pageForm.value.url.trim()
  if (!url) {
    toast.error('请输入 URL 匹配模式')
    return
  }
  const action = buildPageAction()
  if (!action) return
  creatingPage.value = true
  try {
    await securityApi.createPageRule(props.zoneId, {
      targets: [{ target: 'url', constraint: { operator: 'matches', value: url } }],
      actions: [action],
      priority: pageForm.value.priority,
      status: pageForm.value.status,
    })
    toast.success('Page Rule 已创建')
    addPageOpen.value = false
    await loadPageRules()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creatingPage.value = false
  }
}

/* ----------------------------- 删除 Page Rule ----------------------------- */

const deletePageTarget = ref<PageRule | null>(null)
const deletingPage = ref(false)

async function confirmDeletePage() {
  if (!deletePageTarget.value || !props.zoneId) return
  deletingPage.value = true
  try {
    await securityApi.deletePageRule(props.zoneId, deletePageTarget.value.id)
    toast.success('已删除')
    deletePageTarget.value = null
    await loadPageRules()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingPage.value = false
  }
}

/* ----------------------------- 生命周期 ----------------------------- */

const refreshing = computed(
  () =>
    certsLoading.value ||
    wafRulesLoading.value ||
    cacheRulesLoading.value ||
    redirectLoading.value ||
    rulesLoading.value ||
    pageRulesLoading.value,
)

async function reload() {
  await Promise.all([
    loadCerts(),
    loadWafRules(),
    loadCacheRules(),
    loadRedirectRules(),
    loadAccessRules(),
    loadPageRules(),
  ])
}

// 父级已用 :key="zoneId" 在切换 zone 时重建实例，此 watch 仅作兜底
watch(
  () => props.zoneId,
  () => {
    reload()
  },
)

onMounted(() => {
  reload()
})
</script>

<template>
  <div class="space-y-6">
    <!-- 标题 -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">安全规则</h1>
        <p class="text-sm text-muted-foreground">边缘证书、WAF、缓存规则、重定向、IP 访问规则与 Page Rules</p>
      </div>
      <Button variant="ghost" size="sm" :disabled="refreshing" @click="reload">
        <RefreshCw class="size-4" :class="{ 'animate-spin': refreshing }" />
        刷新
      </Button>
    </div>

    <!-- 边缘证书 -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          <Globe class="size-4 text-primary" />
          边缘证书
        </CardTitle>
        <CardDescription>Cloudflare 为该域名签发的通用 SSL 证书</CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <!-- loading -->
        <div v-if="certsLoading" class="divide-y">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3 px-4 py-3">
            <Skeleton class="h-5 flex-1" />
            <Skeleton class="h-5 w-24" />
            <Skeleton class="h-5 w-20" />
          </div>
        </div>

        <!-- 加载失败 -->
        <div v-else-if="certsError" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert class="size-6 text-destructive" />
          </div>
          <div class="text-sm text-destructive">加载证书列表失败：{{ certsError }}</div>
          <Button size="sm" variant="outline" :disabled="certsLoading" @click="loadCerts">
            <RefreshCw class="size-4" />
            重试
          </Button>
        </div>

        <!-- 空状态 -->
        <div v-else-if="!certRows.length" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <Globe class="size-6 text-muted-foreground" />
          </div>
          <div class="text-sm text-muted-foreground">暂无边缘证书</div>
        </div>

        <!-- 列表 -->
        <template v-else>
          <div class="grid grid-cols-[minmax(180px,2fr)_140px_180px_120px_90px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>主机</span>
            <span>签发者</span>
            <span>过期时间</span>
            <span>类型</span>
            <span>状态</span>
          </div>
          <div class="divide-y">
            <div
              v-for="row in certRows"
              :key="row.cert.id"
              class="grid grid-cols-[minmax(180px,2fr)_140px_180px_120px_90px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
            >
              <span class="truncate font-medium" :title="row.cert.hosts?.join(', ')">{{ row.cert.hosts?.join(', ') || '—' }}</span>
              <span class="truncate text-muted-foreground" :title="row.cert.issuer">{{ row.cert.issuer || '—' }}</span>
              <span class="truncate text-xs text-muted-foreground" :title="fmtDate(row.cert.expires_on)">{{ fmtDate(row.cert.expires_on) }}</span>
              <span class="truncate text-xs text-muted-foreground">{{ row.packType || '—' }}</span>
              <Badge variant="secondary" :class="certStatusClass(row.cert.status)">{{ row.cert.status }}</Badge>
            </div>
          </div>
        </template>
      </CardContent>
    </Card>

    <!-- WAF 自定义规则 -->
    <Card>
      <CardHeader class="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle class="flex items-center gap-2 text-base">
            <ShieldAlert class="size-4 text-primary" />
            WAF 自定义规则
          </CardTitle>
          <CardDescription>
            按表达式匹配请求并阻止、质询或跳过。追加走 Rulesets POST，不会整表覆盖。免费档通常最多 5 条。
          </CardDescription>
        </div>
        <Button size="sm" @click="openAddWaf">
          <Plus class="size-4" />
          添加规则
        </Button>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="wafRulesLoading" class="divide-y">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3 px-4 py-3">
            <Skeleton class="h-5 flex-1" />
            <Skeleton class="h-5 w-24" />
            <Skeleton class="h-5 w-32" />
          </div>
        </div>
        <div v-else-if="wafRulesError" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert class="size-6 text-destructive" />
          </div>
          <div class="text-sm text-destructive">加载 WAF 自定义规则失败：{{ wafRulesError }}</div>
          <Button size="sm" variant="outline" :disabled="wafRulesLoading" @click="loadWafRules">
            <RefreshCw class="size-4" />
            重试
          </Button>
        </div>
        <div v-else-if="!wafRules.length" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <ShieldAlert class="size-6 text-muted-foreground" />
          </div>
          <div class="text-sm text-muted-foreground">暂无 WAF 自定义规则</div>
          <Button size="sm" @click="openAddWaf">
            <Plus class="size-4" />
            添加第一条
          </Button>
        </div>
        <template v-else>
          <div class="grid grid-cols-[minmax(140px,1.6fr)_minmax(180px,2.4fr)_100px_70px_72px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>描述</span>
            <span>表达式</span>
            <span>动作</span>
            <span>启用</span>
            <span class="text-right">操作</span>
          </div>
          <div class="divide-y">
            <div
              v-for="r in wafRules"
              :key="r.id"
              class="grid grid-cols-[minmax(140px,1.6fr)_minmax(180px,2.4fr)_100px_70px_72px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
            >
              <span class="truncate font-medium" :title="r.description">{{ r.description || '—' }}</span>
              <code class="truncate font-mono text-xs text-muted-foreground" :title="r.expression">{{ r.expression }}</code>
              <Badge variant="secondary" :class="wafActionClass(r.action)">{{ WAF_ACTION_LABEL[r.action] ?? r.action }}</Badge>
              <Switch
                :model-value="r.enabled"
                :disabled="wafToggling === r.id"
                @update:model-value="(v: boolean) => toggleWafEnabled(r, v)"
              />
              <div class="flex justify-end">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground hover:text-destructive"
                  @click="deleteWafTarget = r"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </template>
      </CardContent>
    </Card>

    <!-- 缓存规则 -->
    <Card>
      <CardHeader class="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle class="flex items-center gap-2 text-base">
            <Layers class="size-4 text-primary" />
            缓存规则
          </CardTitle>
          <CardDescription>按表达式启用边缘缓存。此处创建的规则动作为「缓存匹配请求」，复杂 TTL 仍可去官方后台改。</CardDescription>
        </div>
        <Button size="sm" @click="openAddCache">
          <Plus class="size-4" />
          添加规则
        </Button>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="cacheRulesLoading" class="divide-y">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3 px-4 py-3">
            <Skeleton class="h-5 flex-1" />
            <Skeleton class="h-5 w-24" />
            <Skeleton class="h-5 w-32" />
          </div>
        </div>
        <div v-else-if="cacheRulesError" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <Layers class="size-6 text-destructive" />
          </div>
          <div class="text-sm text-destructive">加载缓存规则失败：{{ cacheRulesError }}</div>
          <Button size="sm" variant="outline" :disabled="cacheRulesLoading" @click="loadCacheRules">
            <RefreshCw class="size-4" />
            重试
          </Button>
        </div>
        <div v-else-if="!cacheRules.length" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <Layers class="size-6 text-muted-foreground" />
          </div>
          <div class="text-sm text-muted-foreground">暂无缓存规则</div>
          <Button size="sm" @click="openAddCache">
            <Plus class="size-4" />
            缓存所有内容
          </Button>
        </div>
        <template v-else>
          <div class="grid grid-cols-[minmax(140px,1.6fr)_minmax(180px,2.4fr)_140px_72px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>描述</span>
            <span>表达式</span>
            <span>动作</span>
            <span class="text-right">操作</span>
          </div>
          <div class="divide-y">
            <div
              v-for="r in cacheRules"
              :key="r.id"
              class="grid grid-cols-[minmax(140px,1.6fr)_minmax(180px,2.4fr)_140px_72px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
            >
              <span class="truncate font-medium" :title="r.description">{{ r.description || '—' }}</span>
              <code class="truncate font-mono text-xs text-muted-foreground" :title="r.expression">{{ r.expression }}</code>
              <code class="truncate text-xs text-muted-foreground" :title="r.action">{{ r.action }}</code>
              <div class="flex justify-end">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground hover:text-destructive"
                  @click="deleteCacheTarget = r"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </template>
      </CardContent>
    </Card>

    <!-- 重定向规则 -->
    <Card>
      <CardHeader class="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle class="flex items-center gap-2 text-base">
            <Link2 class="size-4 text-primary" />
            重定向规则
          </CardTitle>
          <CardDescription>
            Single Redirects（http_request_dynamic_redirect）。追加走 POST，不会整表覆盖。流量须走小黄云。
          </CardDescription>
        </div>
        <Button size="sm" @click="openAddRedirect">
          <Plus class="size-4" />
          添加规则
        </Button>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="redirectLoading" class="divide-y">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3 px-4 py-3">
            <Skeleton class="h-5 flex-1" />
            <Skeleton class="h-5 w-24" />
          </div>
        </div>
        <div v-else-if="redirectError" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="text-sm text-destructive">加载重定向规则失败：{{ redirectError }}</div>
          <Button size="sm" variant="outline" @click="loadRedirectRules">重试</Button>
        </div>
        <div v-else-if="!redirectRules.length" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="text-sm text-muted-foreground">暂无重定向规则</div>
          <Button size="sm" @click="openAddRedirect">
            <Plus class="size-4" />
            添加第一条
          </Button>
        </div>
        <template v-else>
          <div class="grid grid-cols-[minmax(120px,1.4fr)_minmax(140px,1.8fr)_minmax(140px,1.8fr)_56px_70px_56px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>描述</span>
            <span>匹配</span>
            <span>目标</span>
            <span>状态码</span>
            <span>启用</span>
            <span class="text-right">操作</span>
          </div>
          <div class="divide-y">
            <div
              v-for="r in redirectRules"
              :key="r.id"
              class="grid grid-cols-[minmax(120px,1.4fr)_minmax(140px,1.8fr)_minmax(140px,1.8fr)_56px_70px_56px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
            >
              <span class="truncate font-medium" :title="r.description">{{ r.description || '—' }}</span>
              <code class="truncate font-mono text-xs text-muted-foreground" :title="r.expression">{{ r.expression }}</code>
              <code class="truncate font-mono text-xs" :title="redirectTarget(r)">{{ redirectTarget(r) }}</code>
              <span class="text-xs">{{ redirectStatus(r) }}</span>
              <Switch
                :model-value="r.enabled"
                :disabled="redirectToggling === r.id"
                @update:model-value="(v: boolean) => toggleRedirectEnabled(r, v)"
              />
              <div class="flex justify-end">
                <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive" @click="deleteRedirectTarget = r">
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </template>
      </CardContent>
    </Card>

    <!-- IP 访问规则 -->
    <Card>
      <CardHeader class="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle class="flex items-center gap-2 text-base">
            <Globe class="size-4 text-primary" />
            IP 访问规则
          </CardTitle>
          <CardDescription>对 IP / IP 段 / 国家 / ASN 设置放行、阻止或质询</CardDescription>
        </div>
        <Button size="sm" @click="openAdd">
          <Plus class="size-4" />
          添加规则
        </Button>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="rulesLoading" class="divide-y">
          <div v-for="i in 4" :key="i" class="flex items-center gap-3 px-4 py-3">
            <Skeleton class="h-5 w-28" />
            <Skeleton class="h-5 flex-1" />
            <Skeleton class="h-5 w-40" />
            <Skeleton class="h-5 w-8" />
          </div>
        </div>
        <div v-else-if="rulesError" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert class="size-6 text-destructive" />
          </div>
          <div class="text-sm text-destructive">加载访问规则失败：{{ rulesError }}</div>
          <Button size="sm" variant="outline" :disabled="rulesLoading" @click="loadAccessRules">
            <RefreshCw class="size-4" />
            重试
          </Button>
        </div>
        <div v-else-if="!accessRules.length" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <ShieldAlert class="size-6 text-muted-foreground" />
          </div>
          <div class="text-sm text-muted-foreground">暂无访问规则</div>
          <Button size="sm" variant="outline" @click="openAdd">
            <Plus class="size-4" />
            添加规则
          </Button>
        </div>
        <template v-else>
          <div class="grid grid-cols-[120px_minmax(160px,1.5fr)_minmax(160px,2fr)_200px_60px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>动作</span>
            <span>目标</span>
            <span>值</span>
            <span>备注</span>
            <span class="text-right">操作</span>
          </div>
          <div class="divide-y">
            <div
              v-for="r in accessRules"
              :key="r.id"
              class="group grid grid-cols-[120px_minmax(160px,1.5fr)_minmax(160px,2fr)_200px_60px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
            >
              <Badge variant="secondary" :class="modeClass(r.mode)">{{ MODE_LABEL[r.mode] ?? r.mode }}</Badge>
              <span class="truncate text-muted-foreground">{{ r.configuration?.target ?? '—' }}</span>
              <code class="truncate font-mono text-xs" :title="r.configuration?.value">{{ r.configuration?.value ?? '—' }}</code>
              <span class="truncate text-xs text-muted-foreground" :title="r.notes">{{ r.notes || '—' }}</span>
              <div class="flex justify-end">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-destructive hover:text-destructive opacity-60 group-hover:opacity-100"
                  title="删除"
                  @click="deleteTarget = r"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </template>
      </CardContent>
    </Card>

    <!-- Page Rules -->
    <Card>
      <CardHeader class="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle class="flex items-center gap-2 text-base">
            <Flame class="size-4 text-primary" />
            Page Rules
          </CardTitle>
          <CardDescription>基于 URL 模式的缓存与行为规则</CardDescription>
        </div>
        <Button size="sm" @click="openAddPage">
          <Plus class="size-4" />
          新建规则
        </Button>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="pageRulesLoading" class="divide-y">
          <div v-for="i in 4" :key="i" class="flex items-center gap-3 px-4 py-3">
            <Skeleton class="h-5 flex-1" />
            <Skeleton class="h-5 w-48" />
            <Skeleton class="h-5 w-16" />
          </div>
        </div>
        <div v-else-if="pageRulesError" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <Flame class="size-6 text-destructive" />
          </div>
          <div class="text-sm text-destructive">加载 Page Rules 失败：{{ pageRulesError }}</div>
          <Button size="sm" variant="outline" :disabled="pageRulesLoading" @click="loadPageRules">
            <RefreshCw class="size-4" />
            重试
          </Button>
        </div>
        <div v-else-if="!pageRules.length" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <Flame class="size-6 text-muted-foreground" />
          </div>
          <div class="text-sm text-muted-foreground">暂无 Page Rules</div>
          <Button size="sm" variant="outline" @click="openAddPage">
            <Plus class="size-4" />
            新建规则
          </Button>
        </div>
        <template v-else>
          <div class="grid grid-cols-[minmax(200px,2fr)_minmax(220px,2fr)_70px_90px_60px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>URL 匹配</span>
            <span>动作</span>
            <span>优先级</span>
            <span>状态</span>
            <span class="text-right">操作</span>
          </div>
          <div class="divide-y">
            <div
              v-for="r in pageRules"
              :key="r.id"
              class="group grid grid-cols-[minmax(200px,2fr)_minmax(220px,2fr)_70px_90px_60px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
            >
              <span class="truncate font-mono text-xs" :title="r.targets?.[0]?.constraint?.value">
                {{ r.targets?.[0]?.constraint?.value ?? '—' }}
              </span>
              <span class="truncate text-xs text-muted-foreground" :title="summarizeActions(r.actions)">
                {{ summarizeActions(r.actions) }}
              </span>
              <span class="text-muted-foreground">{{ r.priority }}</span>
              <Badge
                variant="secondary"
                :class="r.status === 'active' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'"
              >
                {{ r.status === 'active' ? '启用' : '禁用' }}
              </Badge>
              <div class="flex justify-end">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-destructive hover:text-destructive opacity-60 group-hover:opacity-100"
                  title="删除"
                  @click="deletePageTarget = r"
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </template>
      </CardContent>
    </Card>

    <!-- 添加重定向 -->
    <Dialog v-model:open="addRedirectOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加重定向规则</DialogTitle>
          <DialogDescription>来源填路径（如 /old 或 /blog/*）或完整 URL。目标必须是完整 URL。</DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="flex items-center justify-between rounded-md border px-3 py-2">
            <Label>自定义表达式</Label>
            <Switch
              :model-value="redirectForm.customExpr"
              @update:model-value="(v: boolean) => (redirectForm.customExpr = v)"
            />
          </div>
          <div v-if="!redirectForm.customExpr" class="space-y-1.5">
            <Label>来源路径 / URL</Label>
            <Input v-model="redirectForm.source" placeholder="/old 或 https://example.com/old" class="font-mono" />
          </div>
          <div v-else class="space-y-1.5">
            <Label>表达式</Label>
            <Textarea v-model="redirectForm.expression" class="min-h-20 font-mono text-xs" spellcheck="false" />
          </div>
          <div class="space-y-1.5">
            <Label>目标 URL</Label>
            <Input v-model="redirectForm.target" placeholder="https://example.com/new" class="font-mono" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label>状态码</Label>
              <Select v-model="redirectForm.status">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="301">301 永久</SelectItem>
                  <SelectItem value="302">302 临时</SelectItem>
                  <SelectItem value="307">307 临时（保留方法）</SelectItem>
                  <SelectItem value="308">308 永久（保留方法）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex items-end pb-1">
              <label class="flex items-center gap-2 text-sm">
                <Switch
                  :model-value="redirectForm.preserveQuery"
                  @update:model-value="(v: boolean) => (redirectForm.preserveQuery = v)"
                />
                保留查询串
              </label>
            </div>
          </div>
          <div class="space-y-1.5">
            <Label>描述</Label>
            <Input v-model="redirectForm.description" placeholder="可选" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="addRedirectOpen = false">取消</Button>
          <Button :disabled="creatingRedirect" @click="submitAddRedirect">
            {{ creatingRedirect ? '创建中…' : '创建' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deleteRedirectTarget" @update:open="(v) => !v && (deleteRedirectTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除重定向</DialogTitle>
          <DialogDescription>
            确定删除 {{ deleteRedirectTarget?.description || deleteRedirectTarget?.id }}？
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteRedirectTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deletingRedirect" @click="confirmDeleteRedirect">
            {{ deletingRedirect ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 添加 WAF 自定义规则 -->
    <Dialog v-model:open="addWafOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加 WAF 自定义规则</DialogTitle>
          <DialogDescription>选用模板或填写 Cloudflare 规则语言表达式。创建为追加，不会覆盖既有规则。</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-2">
            <Label>模板</Label>
            <Select :model-value="wafForm.template" @update:model-value="(v) => applyWafTemplate(String(v))">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="t in WAF_TEMPLATES" :key="t.id" :value="t.id">{{ t.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-2">
            <Label>动作</Label>
            <Select v-model="wafForm.action">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="a in WAF_CREATE_ACTIONS" :key="a" :value="a">{{ WAF_ACTION_LABEL[a] }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-2">
            <Label>描述</Label>
            <Input v-model="wafForm.description" placeholder="规则用途说明" />
          </div>
          <div class="space-y-2">
            <Label>表达式</Label>
            <Textarea v-model="wafForm.expression" class="min-h-24 font-mono text-xs" spellcheck="false" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="addWafOpen = false">取消</Button>
          <Button :disabled="creatingWaf" @click="submitAddWaf">
            <Loader2 v-if="creatingWaf" class="size-4 animate-spin" />
            {{ creatingWaf ? '创建中…' : '创建' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deleteWafTarget" @update:open="(v) => !v && (deleteWafTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 WAF 规则</DialogTitle>
          <DialogDescription>
            确定删除规则 <span class="font-medium text-foreground">{{ deleteWafTarget?.description || deleteWafTarget?.id }}</span>？
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteWafTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deletingWaf" @click="confirmDeleteWaf">
            {{ deletingWaf ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="addCacheOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加缓存规则</DialogTitle>
          <DialogDescription>匹配表达式的请求将启用边缘缓存。默认 <code class="font-mono">true</code> 表示全部请求。</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-2">
            <Label>描述</Label>
            <Input v-model="cacheForm.description" placeholder="如 缓存所有内容" />
          </div>
          <div class="space-y-2">
            <Label>表达式</Label>
            <Textarea v-model="cacheForm.expression" class="min-h-20 font-mono text-xs" spellcheck="false" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="addCacheOpen = false">取消</Button>
          <Button :disabled="creatingCache" @click="submitAddCache">
            {{ creatingCache ? '创建中…' : '创建' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deleteCacheTarget" @update:open="(v) => !v && (deleteCacheTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除缓存规则</DialogTitle>
          <DialogDescription>
            确定删除规则 <span class="font-medium text-foreground">{{ deleteCacheTarget?.description || deleteCacheTarget?.id }}</span>？
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteCacheTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deletingCache" @click="confirmDeleteCache">
            {{ deletingCache ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 添加访问规则 -->
    <Dialog v-model:open="addOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加访问规则</DialogTitle>
          <DialogDescription>针对该域名创建一条 IP 访问规则</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-2">
              <Label>动作</Label>
              <Select v-model="form.mode">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">阻止</SelectItem>
                  <SelectItem value="challenge">质询</SelectItem>
                  <SelectItem value="managed_challenge">托管质询</SelectItem>
                  <SelectItem value="js_challenge">JS 质询</SelectItem>
                  <SelectItem value="whitelist">允许</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-2">
              <Label>目标类型</Label>
              <Select v-model="form.target">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ip">{{ TARGET_LABEL.ip }}</SelectItem>
                  <SelectItem value="ip6">{{ TARGET_LABEL.ip6 }}</SelectItem>
                  <SelectItem value="ip_range">{{ TARGET_LABEL.ip_range }}</SelectItem>
                  <SelectItem value="country">{{ TARGET_LABEL.country }}</SelectItem>
                  <SelectItem value="asn">{{ TARGET_LABEL.asn }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="space-y-2">
            <Label>值</Label>
            <Input v-model="form.value" :placeholder="TARGET_PLACEHOLDER[form.target]" />
            <p v-if="form.target === 'country'" class="text-xs text-muted-foreground">
              国家代码 + 阻止 仅 Enterprise 套餐支持，其他套餐请改用质询类动作
            </p>
          </div>
          <div class="space-y-2">
            <Label>备注（可选）</Label>
            <Input v-model="form.notes" placeholder="说明该规则用途" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="creating" @click="addOpen = false">取消</Button>
          <Button :disabled="creating" @click="submitAdd">
            <Loader2 v-if="creating" class="size-4 animate-spin" />
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除访问规则确认 -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除访问规则</DialogTitle>
          <DialogDescription>
            确认删除规则
            <code class="mx-1 font-mono">{{ deleteTarget?.configuration?.value }}</code>
            （{{ deleteTarget ? MODE_LABEL[deleteTarget.mode] : '' }}）？此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deleting" @click="confirmDelete">
            <Loader2 v-if="deleting" class="size-4 animate-spin" />
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 新建 Page Rule -->
    <Dialog v-model:open="addPageOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建 Page Rule</DialogTitle>
          <DialogDescription>匹配 URL 模式并应用缓存动作</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <p v-if="pageRules.length >= 3" class="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            免费套餐上限 3 条（禁用的规则也计数），继续创建可能失败
          </p>
          <div class="space-y-2">
            <Label>URL 匹配模式</Label>
            <Input v-model="pageForm.url" placeholder="如 example.com/*" />
            <p class="text-xs text-muted-foreground">支持 * 通配符（最多 4 个）；省略协议可同时匹配 http/https</p>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-2">
              <Label>动作</Label>
              <Select v-model="pageForm.action">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="a in ACTION_OPTIONS" :key="a.id" :value="a.id">{{ a.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <!-- 枚举型动作：下拉选值 -->
            <div v-if="currentActionDef.input === 'select'" class="space-y-2">
              <Label>值</Label>
              <Select v-model="pageForm.value">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="o in currentActionDef.options ?? []" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <!-- TTL 型动作：整数秒 -->
            <div v-else-if="currentActionDef.input === 'number'" class="space-y-2">
              <Label>TTL（秒）</Label>
              <!-- browser_cache_ttl 允许 0（尊重源站响应头），edge_cache_ttl 最小为 1 -->
              <Input v-model="pageForm.value" type="number" :min="currentActionDef.id === 'browser_cache_ttl' ? 0 : 1" step="1" placeholder="如 14400" />
            </div>
            <!-- forwarding_url：值列放重定向状态码，URL 在下方整行输入 -->
            <div v-else-if="currentActionDef.input === 'forwarding'" class="space-y-2">
              <Label>重定向状态码</Label>
              <Select v-model="pageForm.fwdStatus">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="301">301（永久）</SelectItem>
                  <SelectItem value="302">302（临时）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <!-- 无值动作 -->
            <div v-else class="space-y-2">
              <Label>值</Label>
              <Input disabled placeholder="无需值" />
            </div>
          </div>
          <div v-if="currentActionDef.input === 'forwarding'" class="space-y-2">
            <Label>转发目标 URL</Label>
            <Input v-model="pageForm.fwdUrl" placeholder="如 https://example.com/$1" />
            <p class="text-xs text-muted-foreground">可用 $1、$2 引用匹配模式中的通配符</p>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-2">
              <Label>优先级</Label>
              <Input v-model.number="pageForm.priority" type="number" min="1" />
            </div>
            <div class="space-y-2">
              <Label>状态</Label>
              <Select v-model="pageForm.status">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">启用</SelectItem>
                  <SelectItem value="disabled">禁用</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="creatingPage" @click="addPageOpen = false">取消</Button>
          <Button :disabled="creatingPage" @click="submitAddPage">
            <Loader2 v-if="creatingPage" class="size-4 animate-spin" />
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除 Page Rule 确认 -->
    <Dialog :open="!!deletePageTarget" @update:open="(v) => { if (!v) deletePageTarget = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 Page Rule</DialogTitle>
          <DialogDescription>
            确认删除规则
            <code class="mx-1 font-mono">{{ deletePageTarget?.targets?.[0]?.constraint?.value }}</code>
            ？此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deletePageTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deletingPage" @click="confirmDeletePage">
            <Loader2 v-if="deletingPage" class="size-4 animate-spin" />
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
