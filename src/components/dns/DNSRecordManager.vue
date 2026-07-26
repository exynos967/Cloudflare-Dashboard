<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  Plus,
  Search,
  RefreshCw,
  Pencil,
  Trash2,
  Upload,
  Copy,
  Cloud,
  Loader2,
  Lock,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { dnsApi, workersApi, pagesApi, listAll } from '@/api'
import type { DNSRecord, DNSRecordPayload, DNSRecordType } from '@/types/cloudflare'

const props = defineProps<{ zoneId: string; zoneName?: string }>()

/* ---------------- Worker/Pages 绑定域名（强制小黄云，不可关） ---------------- */

/**
 * Worker Custom Domain 与 Pages 自定义域名都强制 proxied=true，CF 不允许关闭。
 * 这些记录 CF 不一定返回 locked=true，故额外拉账号维度的绑定 hostname 列表精确识别。
 * 拉取失败降级为空集合，靠 toggleProxied 的 try/catch 兜底。
 */
const boundHostnames = ref<Set<string>>(new Set())

function normalizeHost(s: string): string {
  return s.replace(/\.$/, '').toLowerCase().trim()
}

async function loadBoundHostnames() {
  try {
    const [workerDomains, pagesProjects] = await Promise.all([
      workersApi.listDomains().catch(() => []),
      pagesApi.listProjects().catch(() => []),
    ])
    const set = new Set<string>()
    for (const d of workerDomains) if (d.hostname) set.add(normalizeHost(d.hostname))
    for (const p of pagesProjects) for (const dm of p.domains ?? []) set.add(normalizeHost(dm))
    boundHostnames.value = set
  } catch {
    boundHostnames.value = new Set()
  }
}

onMounted(loadBoundHostnames)

/** 该记录是否为 Worker/Pages 绑定的强制代理域名 */
function isBoundRecord(rec: DNSRecord): boolean {
  return boundHostnames.value.has(normalizeHost(rec.name))
}

/* ---------------- 列表与加载 ---------------- */

const records = ref<DNSRecord[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    // 自动翻页拉全量，避免超过单页上限的记录被截断
    records.value = await listAll<DNSRecord>(`/zones/${props.zoneId}/dns_records`, {}, { perPage: 1000 })
  } catch (e) {
    toast.error('加载 DNS 记录失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}

watch(() => props.zoneId, load, { immediate: true })

/* ---------------- 过滤与分页 ---------------- */

const RECORD_TYPES: DNSRecordType[] = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'CAA', 'SRV', 'TLSA']

const typeFilter = ref<DNSRecordType | 'ALL'>('ALL')
const proxiedFilter = ref<'ALL' | 'PROXIED' | 'DNS_ONLY'>('ALL')
const keyword = ref('')

const filtered = computed(() => {
  let list = records.value
  if (typeFilter.value !== 'ALL') list = list.filter((r) => r.type === typeFilter.value)
  if (proxiedFilter.value === 'PROXIED') list = list.filter((r) => r.proxied)
  if (proxiedFilter.value === 'DNS_ONLY') list = list.filter((r) => !r.proxied)
  const kw = keyword.value.trim().toLowerCase()
  if (kw) {
    list = list.filter(
      (r) => r.name.toLowerCase().includes(kw) || r.content.toLowerCase().includes(kw),
    )
  }
  return list
})

const PAGE_SIZE = 15
const page = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const pageItems = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return filtered.value.slice(start, start + PAGE_SIZE)
})

watch([typeFilter, proxiedFilter, keyword], () => {
  page.value = 1
})

// 记录变少（删除/过滤）后总页数缩小时，防止当前页码越界导致误显示「暂无记录」
watch(totalPages, (t) => {
  if (page.value > Math.max(1, t)) page.value = Math.max(1, t)
})

function gotoPage(n: number) {
  if (n < 1 || n > totalPages.value) return
  page.value = n
}

/* ---------------- 添加 / 编辑表单 ---------------- */

const FORM_TYPES: DNSRecordType[] = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'CAA', 'SRV', 'TLSA']

/** CF 仅允许 A/AAAA/CNAME 开启代理（小黄云）；TXT/MX/NS/SRV/CAA/TLSA 等不支持代理 */
const PROXIABLE_TYPES: DNSRecordType[] = ['A', 'AAAA', 'CNAME']

function isProxiableType(t: DNSRecordType): boolean {
  return PROXIABLE_TYPES.includes(t)
}

interface FormState {
  type: DNSRecordType
  name: string
  content: string
  ttlMode: 'auto' | 'custom'
  ttl: number
  proxied: boolean
  priority: number | undefined
}

function blankForm(): FormState {
  return {
    type: 'A',
    name: '',
    content: '',
    ttlMode: 'auto',
    ttl: 600,
    proxied: false,
    priority: undefined,
  }
}

const sheetOpen = ref(false)
const editing = ref<DNSRecord | null>(null)
const submitting = ref(false)
const form = ref<FormState>(blankForm())

const showPriority = computed(() => form.value.type === 'MX' || form.value.type === 'SRV')

/** 小黄云是否可编辑：类型支持代理 且 当前编辑的记录未被 CF 锁定 / 非 Worker·Pages 绑定 */
const proxiedEditable = computed(() => {
  if (!isProxiableType(form.value.type)) return false
  if (editing.value?.locked) return false
  if (editing.value && isBoundRecord(editing.value)) return false
  return true
})

/** 切换记录类型时，若新类型不支持代理，自动关闭小黄云（避免提交无效 proxied） */
watch(
  () => form.value.type,
  (t) => {
    if (!isProxiableType(t)) form.value.proxied = false
  },
)

function openCreate() {
  editing.value = null
  form.value = blankForm()
  sheetOpen.value = true
}

function openEdit(rec: DNSRecord) {
  editing.value = rec
  form.value = {
    type: rec.type,
    name: rec.name,
    content: rec.content,
    ttlMode: rec.ttl === 1 ? 'auto' : 'custom',
    ttl: rec.ttl === 1 ? 600 : rec.ttl,
    proxied: rec.proxied,
    priority: rec.priority,
  }
  sheetOpen.value = true
}

/** A/AAAA 支持单条多 IP（空格 / 逗号分隔） */
function splitContent(content: string, type: DNSRecordType): string[] {
  if (type !== 'A' && type !== 'AAAA') return [content]
  return content
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function buildPayload(): DNSRecordPayload[] {
  const base: Omit<DNSRecordPayload, 'content'> = {
    type: form.value.type,
    name: form.value.name.trim() || '@',
    ttl: form.value.ttlMode === 'auto' ? 1 : form.value.ttl,
  }
  // 仅可代理类型且非锁定记录才提交 proxied（CF 对 TXT/MX 等不接受 proxied:true，
  // 锁定记录——如 Worker Custom Domain 绑定——proxied 由 CF 托管不可改，提交会报错）
  const lockedRecord = !!editing.value?.locked || (editing.value ? isBoundRecord(editing.value) : false)
  if (isProxiableType(form.value.type) && !lockedRecord) {
    base.proxied = form.value.proxied
  }
  if (showPriority.value && form.value.priority != null) base.priority = form.value.priority
  return splitContent(form.value.content, form.value.type).map((c) => ({ ...base, content: c }))
}

async function submit() {
  if (!form.value.content.trim()) {
    toast.error('请填写记录内容')
    return
  }
  // MX/SRV 必须提供优先级（v-model.number 清空后值为 ''，一并拦截）
  if (showPriority.value && (form.value.priority == null || String(form.value.priority).trim() === '')) {
    toast.error('请填写优先级', { description: `${form.value.type} 记录必须提供优先级（priority）` })
    return
  }
  // 编辑模式是对单条记录的更新，不支持多值拆分（新建模式保留多值行为）
  if (editing.value && splitContent(form.value.content.trim(), form.value.type).length > 1) {
    toast.error('编辑模式不支持一次输入多个值', { description: '如需多条记录，请分别创建' })
    return
  }
  submitting.value = true
  try {
    if (editing.value) {
      const payload = buildPayload()[0]
      if (!payload) throw new Error('记录内容无效')
      await dnsApi.update(props.zoneId, editing.value.id, payload)
      toast.success('DNS 记录已更新')
    } else {
      const payloads = buildPayload()
      const results: { ok: boolean; error?: string }[] = []
      for (const p of payloads) {
        try {
          await dnsApi.create(props.zoneId, p)
          results.push({ ok: true })
        } catch (e) {
          results.push({ ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
      const ok = results.filter((r) => r.ok).length
      const fail = results.length - ok
      if (fail === 0) toast.success(`成功创建 ${ok} 条记录`)
      else toast.error(`成功 ${ok} 失败 ${fail}`, { description: '请查看失败详情' })
    }
    sheetOpen.value = false
    await load()
  } catch (e) {
    toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    submitting.value = false
  }
}

/* ---------------- proxied 小黄云切换 ---------------- */

const togglingId = ref<string | null>(null)

async function toggleProxied(rec: DNSRecord) {
  if (rec.locked) {
    toast.error('该记录由 Cloudflare 托管锁定，不可修改代理状态')
    return
  }
  if (isBoundRecord(rec)) {
    toast.error('该记录为 Worker / Pages 绑定的自定义域名，强制开启代理且不可关闭')
    return
  }
  if (!rec.proxiable) {
    toast.error('该记录类型不支持代理')
    return
  }
  togglingId.value = rec.id
  try {
    await dnsApi.update(props.zoneId, rec.id, { proxied: !rec.proxied })
    rec.proxied = !rec.proxied
    toast.success(rec.proxied ? '已开启代理（小黄云）' : '已关闭代理（仅 DNS）')
  } catch (e) {
    toast.error('切换代理失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    togglingId.value = null
  }
}

/** 小黄云按钮的禁用原因（用于 title） */
function proxiedDisableReason(rec: DNSRecord): string {
  if (rec.locked) return '由 Cloudflare 托管锁定，不可修改'
  if (isBoundRecord(rec)) return 'Worker / Pages 绑定的自定义域名，强制代理不可关闭'
  if (!rec.proxiable) return '该记录类型不支持代理'
  return '切换代理状态'
}

/* ---------------- 删除 ---------------- */

const deleteTarget = ref<DNSRecord | null>(null)
const deleting = ref(false)

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await dnsApi.delete(props.zoneId, deleteTarget.value.id)
    toast.success('记录已删除')
    deleteTarget.value = null
    await load()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

/* ---------------- 批量导入 ---------------- */

const IMPORT_SAMPLE = [
  { type: 'A', name: 'www', content: '1.2.3.4', ttl: 1, proxied: true },
  { type: 'A', name: 'www', content: '1.2.3.5', ttl: 1, proxied: true },
  { type: 'CNAME', name: 'api', content: 'target.example.com', ttl: 1, proxied: false },
  { type: 'TXT', name: '@', content: 'v=spf1 include:_spf.example.com ~all', ttl: 1, proxied: false },
  { type: 'MX', name: '@', content: 'mail.example.com', ttl: 1, proxied: false, priority: 10 },
]

const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const importResult = ref<
  | { total: number; ok: number; fail: { record: DNSRecordPayload; error: string }[] }
  | null
>(null)
const importResultOpen = ref(false)

function pickFile() {
  fileInput.value?.click()
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importing.value = true
  try {
    const text = await file.text()
    let arr: unknown
    try {
      arr = JSON.parse(text)
    } catch {
      throw new Error('JSON 解析失败，请检查文件格式')
    }
    if (!Array.isArray(arr)) throw new Error('JSON 必须是数组')
    const records = arr as DNSRecordPayload[]
    if (!records.length) throw new Error('数组为空')
    const results = await dnsApi.importBatch(props.zoneId, records)
    const ok = results.filter((r) => r.ok).length
    const fail = results
      .filter((r) => !r.ok)
      .map((r) => ({ record: r.record, error: r.error ?? '未知错误' }))
    importResult.value = { total: results.length, ok, fail }
    importResultOpen.value = true
    await load()
  } catch (e) {
    toast.error('导入失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    importing.value = false
  }
}

function downloadSample() {
  const blob = new Blob([JSON.stringify(IMPORT_SAMPLE, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'dns-records-sample.json'
  a.click()
  URL.revokeObjectURL(url)
}

/* ---------------- 复制 ---------------- */

async function copy(text: string, label = '内容') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label}已复制`)
  } catch {
    toast.error('复制失败')
  }
}

/* ---------------- 展示辅助 ---------------- */

function fmtTtl(ttl: number): string {
  return ttl === 1 ? '自动' : `${ttl}`
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}

function typeClass(type: DNSRecordType): string {
  const map: Record<string, string> = {
    A: 'bg-sky-500/15 text-sky-600',
    AAAA: 'bg-indigo-500/15 text-indigo-600',
    CNAME: 'bg-violet-500/15 text-violet-600',
    TXT: 'bg-amber-500/15 text-amber-600',
    MX: 'bg-emerald-500/15 text-emerald-600',
    NS: 'bg-slate-500/15 text-slate-600',
    CAA: 'bg-rose-500/15 text-rose-600',
    SRV: 'bg-teal-500/15 text-teal-600',
    TLSA: 'bg-fuchsia-500/15 text-fuchsia-600',
  }
  return map[type] ?? 'bg-muted text-muted-foreground'
}
</script>

<template>
  <div class="space-y-4">
    <!-- 工具栏 -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          v-model="keyword"
          placeholder="搜索名称或内容"
          class="w-56 pl-8"
        />
      </div>

      <Select v-model="typeFilter">
        <SelectTrigger class="w-32">
          <SelectValue placeholder="类型" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">全部类型</SelectItem>
          <SelectItem v-for="t in RECORD_TYPES" :key="t" :value="t">{{ t }}</SelectItem>
        </SelectContent>
      </Select>

      <Select v-model="proxiedFilter">
        <SelectTrigger class="w-36">
          <SelectValue placeholder="代理状态" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">全部</SelectItem>
          <SelectItem value="PROXIED">已代理</SelectItem>
          <SelectItem value="DNS_ONLY">仅 DNS</SelectItem>
        </SelectContent>
      </Select>

      <div class="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
        <Button variant="outline" size="sm" :disabled="importing" @click="pickFile">
          <component :is="importing ? Loader2 : Upload" class="size-4" :class="{ 'animate-spin': importing }" />
          批量导入
        </Button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="hidden"
          @change="onFileChange"
        />
        <Button size="sm" @click="openCreate">
          <Plus class="size-4" />
          添加记录
        </Button>
      </div>
    </div>

    <!-- 表格 -->
    <div class="overflow-hidden rounded-lg border">
      <div class="grid grid-cols-[80px_minmax(140px,1fr)_minmax(180px,1.4fr)_120px_90px_90px_100px] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <span>类型</span>
        <span>名称</span>
        <span>内容</span>
        <span>代理状态</span>
        <span class="text-right">优先级</span>
        <span class="text-right">TTL</span>
        <span class="text-right">操作</span>
      </div>

      <div v-if="loading" class="divide-y">
        <div v-for="i in 6" :key="i" class="grid grid-cols-[80px_minmax(140px,1fr)_minmax(180px,1.4fr)_120px_90px_90px_100px] items-center gap-2 px-3 py-3">
          <Skeleton class="h-5 w-12" />
          <Skeleton class="h-5 w-32" />
          <Skeleton class="h-5 w-48" />
          <Skeleton class="h-5 w-16" />
          <Skeleton class="h-5 w-8" />
          <Skeleton class="h-5 w-10" />
          <Skeleton class="h-5 w-16" />
        </div>
      </div>

      <div
        v-else-if="!pageItems.length"
        class="px-3 py-10 text-center text-sm text-muted-foreground"
      >
        暂无 DNS 记录
        <Button variant="link" size="sm" @click="openCreate">添加第一条</Button>
      </div>

      <div v-else class="divide-y">
        <div
          v-for="r in pageItems"
          :key="r.id"
          class="grid grid-cols-[80px_minmax(140px,1fr)_minmax(180px,1.4fr)_120px_90px_90px_100px] items-center gap-2 px-3 py-2.5 text-sm hover:bg-accent/40"
        >
          <Badge :class="typeClass(r.type)" variant="secondary">{{ r.type }}</Badge>

          <div class="min-w-0">
            <div class="truncate font-medium" :title="r.name">{{ r.name }}</div>
            <div class="truncate text-xs text-muted-foreground" :title="r.name">
              修改于 {{ fmtDate(r.modified_on) }}
            </div>
          </div>

          <div class="flex items-center gap-1">
            <span class="truncate" :title="r.content">{{ r.content }}</span>
            <Button variant="ghost" size="icon-sm" @click="copy(r.content, '内容')">
              <Copy class="size-3" />
            </Button>
          </div>

          <div class="flex items-center">
            <button
              type="button"
              class="flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!r.proxiable || r.locked || isBoundRecord(r) || togglingId === r.id"
              :title="proxiedDisableReason(r)"
              @click="toggleProxied(r)"
            >
              <Cloud
                class="size-4 transition"
                :class="[
                  r.proxied ? 'text-amber-500' : 'text-muted-foreground/40',
                  r.locked || isBoundRecord(r) ? 'opacity-60' : '',
                ]"
              />
              <span class="text-xs" :class="r.proxied ? 'text-amber-600' : 'text-muted-foreground'">
                {{ r.proxied ? '已代理' : '仅 DNS' }}
              </span>
              <Lock v-if="r.locked || isBoundRecord(r)" class="size-3 text-muted-foreground" />
            </button>
          </div>

          <span class="text-right text-muted-foreground">{{ r.priority ?? '—' }}</span>
          <span class="text-right text-muted-foreground">{{ fmtTtl(r.ttl) }}</span>

          <div class="flex justify-end gap-1">
            <Button variant="ghost" size="icon-sm" @click="openEdit(r)" title="编辑">
              <Pencil class="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-destructive hover:text-destructive"
              title="删除"
              @click="deleteTarget = r"
            >
              <Trash2 class="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="filtered.length > PAGE_SIZE" class="flex items-center justify-between text-sm">
      <span class="text-muted-foreground">
        共 {{ filtered.length }} 条 · 第 {{ page }} / {{ totalPages }} 页
      </span>
      <div class="flex items-center gap-1">
        <Button variant="outline" size="sm" :disabled="page === 1" @click="gotoPage(page - 1)">
          上一页
        </Button>
        <Button variant="outline" size="sm" :disabled="page === totalPages" @click="gotoPage(page + 1)">
          下一页
        </Button>
      </div>
    </div>

    <!-- 添加 / 编辑表单 -->
    <Sheet v-model:open="sheetOpen">
      <SheetContent class="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{{ editing ? '编辑 DNS 记录' : '添加 DNS 记录' }}</SheetTitle>
          <SheetDescription>
            {{ editing ? '修改记录字段后保存' : 'A / AAAA 记录内容支持空格或逗号分隔多个 IP，自动拆为多条' }}
          </SheetDescription>
        </SheetHeader>

        <div class="space-y-4 px-4">
          <div class="space-y-2">
            <Label>类型</Label>
            <Select v-model="form.type">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="选择记录类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="t in FORM_TYPES" :key="t" :value="t">{{ t }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label>名称</Label>
            <Input v-model="form.name" :placeholder="zoneName ? `如 @ / www / api（留空为 @）` : '如 @ / www / api'" />
            <p class="text-xs text-muted-foreground">留空使用 @（根域名）。可填子域名前缀或全名。</p>
          </div>

          <div class="space-y-2">
            <Label>内容</Label>
            <Textarea
              v-model="form.content"
              :placeholder="form.type === 'A' ? '1.2.3.4（多个用空格或逗号分隔）' : '记录值'"
              rows="2"
            />
          </div>

          <div class="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div class="flex items-center gap-1.5 text-sm font-medium">
                <Cloud class="size-4" :class="form.proxied ? 'text-amber-500' : 'text-muted-foreground'" />
                代理状态（小黄云）
              </div>
              <p v-if="editing?.locked" class="text-xs text-muted-foreground">
                该记录由 Cloudflare 托管锁定，代理状态不可修改
              </p>
              <p v-else-if="editing && isBoundRecord(editing)" class="text-xs text-muted-foreground">
                该记录为 Worker / Pages 绑定的自定义域名，强制开启代理且不可关闭
              </p>
              <p v-else-if="!proxiedEditable" class="text-xs text-muted-foreground">
                当前记录类型不支持代理
              </p>
              <p v-else class="text-xs text-muted-foreground">开启后流量经 Cloudflare 代理</p>
            </div>
            <Switch
              :model-value="form.proxied"
              :disabled="!proxiedEditable"
              @update:model-value="(v: boolean) => (form.proxied = v)"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-2">
              <Label>TTL</Label>
              <Select v-model="form.ttlMode">
                <SelectTrigger class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动</SelectItem>
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div v-if="form.ttlMode === 'custom'" class="space-y-2">
              <Label>TTL（秒）</Label>
              <Input v-model.number="form.ttl" type="number" min="60" />
            </div>
          </div>

          <div v-if="showPriority" class="space-y-2">
            <Label>优先级</Label>
            <Input v-model.number="form.priority" type="number" min="0" placeholder="如 10" />
          </div>
        </div>

        <SheetFooter class="mt-6">
          <Button variant="outline" @click="sheetOpen = false">取消</Button>
          <Button :disabled="submitting" @click="submit">
            <Loader2 v-if="submitting" class="size-4 animate-spin" />
            {{ editing ? '保存' : '创建' }}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>

    <!-- 删除确认 -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 DNS 记录</DialogTitle>
          <DialogDescription>
            确认删除 <span class="font-medium text-foreground">{{ deleteTarget?.name }}</span> 的
            <span class="font-medium text-foreground">{{ deleteTarget?.type }}</span> 记录？此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deleting" @click="confirmDelete">
            <Loader2 v-if="deleting" class="size-4 animate-spin" />
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 导入结果 -->
    <Dialog v-model:open="importResultOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>批量导入结果</DialogTitle>
          <DialogDescription v-if="importResult">
            共 {{ importResult.total }} 条 · 成功
            <span class="font-medium text-emerald-600">{{ importResult.ok }}</span> · 失败
            <span class="font-medium text-destructive">{{ importResult.fail.length }}</span>
          </DialogDescription>
        </DialogHeader>
        <Separator v-if="importResult && importResult.fail.length" />
        <div v-if="importResult && importResult.fail.length" class="max-h-60 space-y-2 overflow-y-auto">
          <div
            v-for="(f, i) in importResult.fail"
            :key="i"
            class="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs"
          >
            <div class="font-medium">{{ f.record.type }} · {{ f.record.name }} → {{ f.record.content }}</div>
            <div class="text-destructive">{{ f.error }}</div>
          </div>
        </div>
        <div class="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          格式示例：
          <pre class="mt-1 overflow-x-auto text-[11px] leading-tight">{{ JSON.stringify(IMPORT_SAMPLE.slice(0, 2), null, 2) }}</pre>
          <Button variant="link" size="sm" class="h-auto p-0" @click="downloadSample">下载完整示例 JSON</Button>
        </div>
        <DialogFooter>
          <Button @click="importResultOpen = false">关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
