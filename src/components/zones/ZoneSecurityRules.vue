<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { RefreshCw, Loader2, ShieldAlert, Globe, Plus, Trash2, Flame, Layers } from '@lucide/vue'
import { securityApi } from '@/api'
import type {
  CertificatePack,
  CertificatePackCert,
  FirewallAccessRule,
  RulesetRule,
  PageRule,
  PageRuleAction,
} from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  try {
    packs.value = await securityApi.listCerts(props.zoneId)
  } catch (e) {
    toast.error('加载证书列表失败', { description: e instanceof Error ? e.message : String(e) })
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

async function loadWafRules() {
  if (!props.zoneId) return
  wafRulesLoading.value = true
  try {
    wafRules.value = await securityApi.listFirewallRules(props.zoneId)
  } catch (e) {
    toast.error('加载 WAF 自定义规则失败', { description: e instanceof Error ? e.message : String(e) })
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
  if (a === 'skip') return 'bg-emerald-500/15 text-emerald-600'
  return 'bg-muted text-muted-foreground'
}

/* ----------------------------- 缓存规则（zone 维度） ----------------------------- */

const cacheRules = ref<RulesetRule[]>([])
const cacheRulesLoading = ref(false)

async function loadCacheRules() {
  if (!props.zoneId) return
  cacheRulesLoading.value = true
  try {
    cacheRules.value = await securityApi.listCacheRules(props.zoneId)
  } catch (e) {
    toast.error('加载缓存规则失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    cacheRulesLoading.value = false
  }
}

/* ----------------------------- IP 访问规则 ----------------------------- */

const accessRules = ref<FirewallAccessRule[]>([])
const rulesLoading = ref(false)

async function loadAccessRules() {
  if (!props.zoneId) return
  rulesLoading.value = true
  try {
    accessRules.value = await securityApi.listAccessRules(props.zoneId)
  } catch (e) {
    toast.error('加载访问规则失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    rulesLoading.value = false
  }
}

const MODE_LABEL: Record<string, string> = {
  block: '阻止',
  challenge: '质询',
  whitelist: '允许',
  js_challenge: 'JS 质询',
}

function modeClass(m: string): string {
  if (m === 'block') return 'bg-red-500/15 text-red-600'
  if (m === 'whitelist') return 'bg-emerald-500/15 text-emerald-600'
  if (m === 'challenge' || m === 'js_challenge') return 'bg-amber-500/15 text-amber-600'
  return 'bg-muted text-muted-foreground'
}

/* ----------------------------- 添加访问规则 ----------------------------- */

const addOpen = ref(false)
const creating = ref(false)
const form = ref({
  mode: 'block' as FirewallAccessRule['mode'],
  target: 'ip' as 'ip' | 'ip_range' | 'country' | 'asn',
  value: '',
  notes: '',
})

const TARGET_LABEL: Record<string, string> = {
  ip: 'IP 地址',
  ip_range: 'IP 段 (CIDR)',
  country: '国家代码',
  asn: 'ASN',
}

function openAdd() {
  form.value = { mode: 'block', target: 'ip', value: '', notes: '' }
  addOpen.value = true
}

async function submitAdd() {
  const v = form.value.value.trim()
  if (!v) {
    toast.error('请输入规则值')
    return
  }
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

async function loadPageRules() {
  if (!props.zoneId) return
  pageRulesLoading.value = true
  try {
    pageRules.value = await securityApi.listPageRules(props.zoneId)
  } catch (e) {
    toast.error('加载 Page Rules 失败', { description: e instanceof Error ? e.message : String(e) })
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
    return { id: def.id, value: { url: target, status_code: Number(pageForm.value.fwdStatus) } }
  }
  if (def.input === 'number') {
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
    rulesLoading.value ||
    pageRulesLoading.value,
)

async function reload() {
  await Promise.all([loadCerts(), loadWafRules(), loadCacheRules(), loadAccessRules(), loadPageRules()])
}

watch(
  () => props.zoneId,
  () => {
    loadCerts()
    loadWafRules()
    loadCacheRules()
    loadAccessRules()
    loadPageRules()
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
        <p class="text-sm text-muted-foreground">边缘证书、WAF 自定义规则、缓存规则、IP 访问规则与 Page Rules</p>
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
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          <ShieldAlert class="size-4 text-primary" />
          WAF 自定义规则
        </CardTitle>
        <CardDescription>该域名的 WAF 自定义规则（http_request_firewall_custom，只读）</CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="wafRulesLoading" class="divide-y">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3 px-4 py-3">
            <Skeleton class="h-5 flex-1" />
            <Skeleton class="h-5 w-24" />
            <Skeleton class="h-5 w-32" />
          </div>
        </div>
        <div v-else-if="!wafRules.length" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <ShieldAlert class="size-6 text-muted-foreground" />
          </div>
          <div class="text-sm text-muted-foreground">暂无 WAF 自定义规则</div>
        </div>
        <template v-else>
          <div class="grid grid-cols-[minmax(160px,2fr)_minmax(200px,3fr)_110px_90px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>描述</span>
            <span>表达式</span>
            <span>动作</span>
            <span>状态</span>
          </div>
          <div class="divide-y">
            <div
              v-for="r in wafRules"
              :key="r.id"
              class="grid grid-cols-[minmax(160px,2fr)_minmax(200px,3fr)_110px_90px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
            >
              <span class="truncate font-medium" :title="r.description">{{ r.description || '—' }}</span>
              <code class="truncate font-mono text-xs text-muted-foreground" :title="r.expression">{{ r.expression }}</code>
              <Badge variant="secondary" :class="wafActionClass(r.action)">{{ WAF_ACTION_LABEL[r.action] ?? r.action }}</Badge>
              <Badge
                variant="secondary"
                :class="r.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'"
              >
                {{ r.enabled ? '启用' : '禁用' }}
              </Badge>
            </div>
          </div>
        </template>
      </CardContent>
    </Card>

    <!-- 缓存规则 -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          <Layers class="size-4 text-primary" />
          缓存规则
        </CardTitle>
        <CardDescription>该域名的缓存规则（http_request_cache_settings，只读）</CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="cacheRulesLoading" class="divide-y">
          <div v-for="i in 3" :key="i" class="flex items-center gap-3 px-4 py-3">
            <Skeleton class="h-5 flex-1" />
            <Skeleton class="h-5 w-24" />
            <Skeleton class="h-5 w-32" />
          </div>
        </div>
        <div v-else-if="!cacheRules.length" class="flex flex-col items-center gap-3 px-4 py-12 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <Layers class="size-6 text-muted-foreground" />
          </div>
          <div class="text-sm text-muted-foreground">暂无缓存规则</div>
        </div>
        <template v-else>
          <div class="grid grid-cols-[minmax(160px,2fr)_minmax(200px,3fr)_140px_90px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>描述</span>
            <span>表达式</span>
            <span>动作</span>
            <span>状态</span>
          </div>
          <div class="divide-y">
            <div
              v-for="r in cacheRules"
              :key="r.id"
              class="grid grid-cols-[minmax(160px,2fr)_minmax(200px,3fr)_140px_90px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
            >
              <span class="truncate font-medium" :title="r.description">{{ r.description || '—' }}</span>
              <code class="truncate font-mono text-xs text-muted-foreground" :title="r.expression">{{ r.expression }}</code>
              <code class="truncate text-xs text-muted-foreground" :title="r.action">{{ r.action }}</code>
              <Badge
                variant="secondary"
                :class="r.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'"
              >
                {{ r.enabled ? '启用' : '禁用' }}
              </Badge>
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
                  <SelectItem value="ip_range">{{ TARGET_LABEL.ip_range }}</SelectItem>
                  <SelectItem value="country">{{ TARGET_LABEL.country }}</SelectItem>
                  <SelectItem value="asn">{{ TARGET_LABEL.asn }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="space-y-2">
            <Label>值</Label>
            <Input v-model="form.value" :placeholder="form.target === 'country' ? '如 CN' : form.target === 'asn' ? '如 13335' : '如 1.2.3.4 或 1.2.3.0/24'" />
          </div>
          <div class="space-y-2">
            <Label>备注（可选）</Label>
            <Input v-model="form.notes" placeholder="说明该规则用途" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="addOpen = false">取消</Button>
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
          <div class="space-y-2">
            <Label>URL 匹配模式</Label>
            <Input v-model="pageForm.url" placeholder="如 example.com/*" />
            <p class="text-xs text-muted-foreground">支持 * 通配符</p>
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
              <Input v-model="pageForm.value" type="number" min="1" step="1" placeholder="如 14400" />
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
          <Button variant="outline" @click="addPageOpen = false">取消</Button>
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
