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
 * 任一来源拉取失败置 bindDetectFailed，工具栏显示警示（识别降级可见）。
 */
const boundHostnames = ref<Set<string>>(new Set())
const bindDetectFailed = ref(false)

function normalizeHost(s: string): string {
  return s.replace(/\.$/, '').toLowerCase().trim()
}

async function loadBoundHostnames() {
  bindDetectFailed.value = false
  const [workerRes, pagesRes] = await Promise.allSettled([
    workersApi.listDomains(),
    pagesApi.listProjects(),
  ])
  const set = new Set<string>()
  if (workerRes.status === 'fulfilled') {
    for (const d of workerRes.value) if (d.hostname) set.add(normalizeHost(d.hostname))
  } else {
    bindDetectFailed.value = true
  }
  if (pagesRes.status === 'fulfilled') {
    for (const p of pagesRes.value) for (const dm of p.domains ?? []) set.add(normalizeHost(dm))
  } else {
    bindDetectFailed.value = true
  }
  boundHostnames.value = set
}

onMounted(loadBoundHostnames)

/** 该记录是否为 Worker/Pages 绑定的强制代理域名（仅 A/AAAA/CNAME 参与判定，避免 apex 同名 MX/TXT 被误锁） */
function isBoundRecord(rec: DNSRecord): boolean {
  if (!['A', 'AAAA', 'CNAME'].includes(rec.type)) return false
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

/** CF 要求以 data 对象提交的结构化类型（content 为只读展示字段，提交 content 必失败） */
const DATA_TYPES: DNSRecordType[] = ['SRV', 'CAA', 'TLSA']

interface FormState {
  type: DNSRecordType
  name: string
  content: string
  ttlMode: 'auto' | 'custom'
  ttl: number
  proxied: boolean
  priority: number | undefined
  comment: string
  /** 结构化子字段：数字用 number | ''（v-model.number 清空后为 ''） */
  srv: { priority: number | ''; weight: number | ''; port: number | ''; target: string }
  caa: { flags: number | ''; tag: string; value: string }
  tlsa: { usage: number | ''; selector: number | ''; matching_type: number | ''; certificate: string }
}

function blankForm(): FormState {
  return {
    type: 'A',
    name: '',
    content: '',
    ttlMode: 'auto',
    ttl: 600,
    // 与 CF 官方 dashboard 一致：可代理类型新建默认开启小黄云（默认类型 A 可代理）
    proxied: true,
    priority: undefined,
    comment: '',
    srv: { priority: '', weight: '', port: '', target: '' },
    caa: { flags: 0, tag: 'issue', value: '' },
    tlsa: { usage: '', selector: '', matching_type: '', certificate: '' },
  }
}

const sheetOpen = ref(false)
const editing = ref<DNSRecord | null>(null)
const submitting = ref(false)
const form = ref<FormState>(blankForm())

/** SRV 优先级已并入结构化子字段，顶层优先级仅 MX 需要 */
const showPriority = computed(() => form.value.type === 'MX')
const isDataType = computed(() => DATA_TYPES.includes(form.value.type))

const namePlaceholder = computed(() =>
  form.value.type === 'SRV' ? '_service._proto.name，如 _sip._tcp' : '如 @ / www / api（留空为 @）',
)

const contentPlaceholder = computed(() => {
  switch (form.value.type) {
    case 'A': return '1.2.3.4（多个用空格或逗号分隔）'
    case 'AAAA': return '2001:db8::1（多个用空格或逗号分隔）'
    case 'CNAME': return '目标主机名，如 target.example.com'
    case 'MX': return '邮件服务器主机名，如 mail.example.com'
    case 'NS': return '名称服务器，如 ns1.example.com'
    case 'TXT': return '文本内容，如 v=spf1 include:_spf.example.com ~all'
    default: return '记录值'
  }
})

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

/** data 缺失时从 content 尽力解析结构化字段（解析失败返回 null，由调用方提示重填） */
function parseDataFromContent(rec: DNSRecord): Record<string, unknown> | null {
  const parts = rec.content.trim().split(/\s+/)
  const nums = parts.map(Number)
  if (rec.type === 'SRV') {
    // 形如 "priority weight port target" 或 "weight port target"（priority 在顶层字段）
    if (parts.length === 4 && nums.slice(0, 3).every(Number.isInteger)) {
      return { priority: nums[0], weight: nums[1], port: nums[2], target: parts[3] }
    }
    if (parts.length === 3 && nums.slice(0, 2).every(Number.isInteger) && rec.priority != null) {
      return { priority: rec.priority, weight: nums[0], port: nums[1], target: parts[2] }
    }
    return null
  }
  if (rec.type === 'CAA') {
    // 形如 '0 issue "ca.example.com"'
    if (parts.length >= 3 && Number.isInteger(nums[0])) {
      return { flags: nums[0], tag: parts[1], value: parts.slice(2).join(' ').replace(/^"|"$/g, '') }
    }
    return null
  }
  if (rec.type === 'TLSA') {
    // 形如 "3 1 1 abcdef..."
    if (parts.length >= 4 && nums.slice(0, 3).every(Number.isInteger)) {
      return { usage: nums[0], selector: nums[1], matching_type: nums[2], certificate: parts.slice(3).join('') }
    }
    return null
  }
  return null
}

/** 将 data 对象回填到结构化子字段 */
function fillDataForm(f: FormState, type: DNSRecordType, data: Record<string, unknown>) {
  const num = (v: unknown): number | '' => (typeof v === 'number' && Number.isFinite(v) ? v : '')
  const str = (v: unknown): string => (v == null ? '' : String(v))
  if (type === 'SRV') {
    f.srv = { priority: num(data.priority), weight: num(data.weight), port: num(data.port), target: str(data.target) }
  } else if (type === 'CAA') {
    const tag = str(data.tag)
    f.caa = { flags: num(data.flags), tag: ['issue', 'issuewild', 'iodef'].includes(tag) ? tag : 'issue', value: str(data.value) }
  } else if (type === 'TLSA') {
    f.tlsa = { usage: num(data.usage), selector: num(data.selector), matching_type: num(data.matching_type), certificate: str(data.certificate) }
  }
}

function openEdit(rec: DNSRecord) {
  editing.value = rec
  const f = blankForm()
  f.type = rec.type
  f.name = rec.name
  f.content = rec.content
  f.ttlMode = rec.ttl === 1 ? 'auto' : 'custom'
  f.ttl = rec.ttl === 1 ? 600 : rec.ttl
  f.proxied = rec.proxied
  f.priority = rec.priority
  f.comment = rec.comment ?? ''
  if (DATA_TYPES.includes(rec.type)) {
    const data = rec.data ?? parseDataFromContent(rec)
    if (data) fillDataForm(f, rec.type, data)
    else toast.info('未能解析原记录的结构化数据，请重新填写各子字段')
  }
  form.value = f
  sheetOpen.value = true
}

/** A/AAAA 支持单条多 IP（空格 / 逗号分隔）；其余单值类型仅去首尾空白（TXT 保留内部空格） */
function splitContent(content: string, type: DNSRecordType): string[] {
  if (type !== 'A' && type !== 'AAAA') return [content.trim()]
  return content
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 整数范围校验（v-model.number 清空为 ''，一并拦截） */
function intInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

/** 结构化子字段校验，返回错误描述（null 为通过） */
function validateDataFields(): string | null {
  const t = form.value.type
  if (t === 'SRV') {
    const { priority, weight, port, target } = form.value.srv
    if (!intInRange(priority, 0, 65535)) return '优先级需为 0-65535 的整数'
    if (!intInRange(weight, 0, 65535)) return '权重需为 0-65535 的整数'
    if (!intInRange(port, 0, 65535)) return '端口需为 0-65535 的整数'
    if (!target.trim()) return '请填写目标（target）'
  } else if (t === 'CAA') {
    const { flags, value } = form.value.caa
    if (!intInRange(flags, 0, 255)) return 'flags 需为 0-255 的整数'
    if (!value.trim()) return '请填写 value'
  } else if (t === 'TLSA') {
    const { usage, selector, matching_type, certificate } = form.value.tlsa
    if (!intInRange(usage, 0, 3)) return 'usage 需为 0-3 的整数'
    if (!intInRange(selector, 0, 1)) return 'selector 需为 0-1 的整数'
    if (!intInRange(matching_type, 0, 2)) return 'matching_type 需为 0-2 的整数'
    const cert = certificate.replace(/\s+/g, '')
    if (!cert || !/^[0-9a-fA-F]+$/.test(cert)) return 'certificate 需为十六进制字符串'
  }
  return null
}

/** 从结构化子字段构造 data 对象（调用前需通过 validateDataFields） */
function buildData(): Record<string, unknown> {
  const t = form.value.type
  if (t === 'SRV') {
    const { priority, weight, port, target } = form.value.srv
    return { priority, weight, port, target: target.trim() }
  }
  if (t === 'CAA') {
    const { flags, tag, value } = form.value.caa
    return { flags, tag, value: value.trim() }
  }
  const { usage, selector, matching_type, certificate } = form.value.tlsa
  return { usage, selector, matching_type, certificate: certificate.replace(/\s+/g, '').toLowerCase() }
}

function buildPayload(): DNSRecordPayload[] {
  const base: Omit<DNSRecordPayload, 'content'> = {
    type: form.value.type,
    name: form.value.name.trim() || '@',
    // 代理开启时 CF 强制 TTL 自动（1），忽略自定义值
    ttl: form.value.proxied ? 1 : form.value.ttlMode === 'auto' ? 1 : form.value.ttl,
  }
  // 备注：编辑时始终提交（清空即删除备注），新建仅非空时提交
  const comment = form.value.comment.trim()
  if (editing.value || comment) base.comment = comment
  // SRV/CAA/TLSA 以 data 对象提交，不发顶层 priority/content
  if (isDataType.value) return [{ ...base, data: buildData() }]
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
  if (isDataType.value) {
    const err = validateDataFields()
    if (err) {
      toast.error('字段校验失败', { description: err })
      return
    }
  } else {
    if (!form.value.content.trim()) {
      toast.error('请填写记录内容')
      return
    }
    // MX 必须提供有效优先级
    if (showPriority.value && !intInRange(form.value.priority, 0, 65535)) {
      toast.error('请填写有效的优先级', { description: 'MX 记录优先级需为 0-65535 的整数' })
      return
    }
    // 编辑模式是对单条记录的更新，不支持多值拆分（新建模式保留多值行为）
    if (editing.value && splitContent(form.value.content, form.value.type).length > 1) {
      toast.error('编辑模式不支持一次输入多个值', { description: '如需多条记录，请分别创建' })
      return
    }
  }
  // 自定义 TTL 校验（代理开启时 TTL 强制自动，跳过）
  const ttl = form.value.ttl
  if (!form.value.proxied && form.value.ttlMode === 'custom' && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60)) {
    toast.error('TTL 无效', { description: '自定义 TTL 需为不小于 60 的整数（秒）' })
    return
  }
  submitting.value = true
  try {
    if (editing.value) {
      const payload = buildPayload()[0]
      if (!payload) throw new Error('记录内容无效')
      await dnsApi.update(props.zoneId, editing.value.id, payload)
      toast.success('DNS 记录已更新')
      sheetOpen.value = false
      await load()
    } else {
      const payloads = buildPayload()
      const fails: { value: string; error: string }[] = []
      let ok = 0
      for (const p of payloads) {
        try {
          await dnsApi.create(props.zoneId, p)
          ok++
        } catch (e) {
          fails.push({
            value: p.content ?? JSON.stringify(p.data),
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
      if (!fails.length) {
        toast.success(`成功创建 ${ok} 条记录`)
        sheetOpen.value = false
      } else {
        // 部分失败：不关 sheet、保留输入，逐条列出「值：原因」（最多 5 条）
        toast.error(`成功 ${ok} 条，失败 ${fails.length} 条`, {
          description: fails.slice(0, 5).map((f) => `${f.value}：${f.error}`).join('\n'),
        })
      }
      await load()
    }
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
    // 用 PATCH 响应体整条回写，TTL/modified_on 等同步（CF 代理开启会强制 TTL=1）
    const updated = await dnsApi.update(props.zoneId, rec.id, { proxied: !rec.proxied })
    Object.assign(rec, updated)
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

/** 导入预检：必填字段缺失返回错误描述（null 为通过） */
function validateImportRecord(rec: DNSRecordPayload): string | null {
  if (typeof rec.type !== 'string' || !rec.type.trim()) return '缺少 type'
  if (typeof rec.name !== 'string' || !rec.name.trim()) return '缺少 name'
  const hasContent = typeof rec.content === 'string' && rec.content.trim() !== ''
  const hasData = rec.data != null && typeof rec.data === 'object'
  if (!hasContent && !hasData) return '缺少 content 或 data'
  return null
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
    if (!arr.length) throw new Error('数组为空')
    // 逐条预检：格式错误的不发请求，直接在结果里标注
    const invalid: { record: DNSRecordPayload; error: string }[] = []
    const valid: DNSRecordPayload[] = []
    for (const item of arr) {
      const rec = (item && typeof item === 'object' ? item : {}) as DNSRecordPayload
      const err = validateImportRecord(rec)
      if (err) invalid.push({ record: rec, error: `格式错误：${err}` })
      else valid.push(rec)
    }
    const results = valid.length ? await dnsApi.importBatch(props.zoneId, valid) : []
    const ok = results.filter((r) => r.ok).length
    const fail = [
      ...invalid,
      ...results
        .filter((r) => !r.ok)
        .map((r) => ({ record: r.record, error: `CF 拒绝：${r.error ?? '未知错误'}` })),
    ]
    importResult.value = { total: arr.length, ok, fail }
    importResultOpen.value = true
    if (valid.length) await load()
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
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false })
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

      <!-- 绑定识别降级警示 -->
      <p v-if="bindDetectFailed" class="w-full text-xs text-amber-600">
        Worker / Pages 绑定识别不可用，代理开关操作请谨慎
      </p>
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
            <div v-if="r.comment" class="truncate text-xs text-muted-foreground" :title="r.comment">
              备注：{{ r.comment }}
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
            <!-- 表单不支持的类型（HTTPS/SVCB/PTR…）隐藏编辑入口，只留删除 -->
            <Button v-if="FORM_TYPES.includes(r.type)" variant="ghost" size="icon-sm" @click="openEdit(r)" title="编辑">
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
            <!-- CF 不允许 PATCH 修改 type，编辑时禁用 -->
            <Select v-model="form.type" :disabled="!!editing">
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
            <Input v-model="form.name" :placeholder="namePlaceholder" />
            <p v-if="form.type === 'SRV'" class="text-xs text-muted-foreground">
              SRV 名称格式：_service._proto.name（如 _sip._tcp 或 _sip._tcp.www）
            </p>
            <p v-else class="text-xs text-muted-foreground">留空使用 @（根域名）。可填子域名前缀或全名。</p>
          </div>

          <!-- SRV/CAA/TLSA：结构化子字段（CF 要求以 data 对象提交） -->
          <div v-if="form.type === 'SRV'" class="grid grid-cols-2 gap-3">
            <div class="space-y-2">
              <Label>优先级</Label>
              <Input v-model.number="form.srv.priority" type="number" min="0" max="65535" placeholder="如 10" />
            </div>
            <div class="space-y-2">
              <Label>权重</Label>
              <Input v-model.number="form.srv.weight" type="number" min="0" max="65535" placeholder="如 5" />
            </div>
            <div class="space-y-2">
              <Label>端口</Label>
              <Input v-model.number="form.srv.port" type="number" min="0" max="65535" placeholder="如 5060" />
            </div>
            <div class="space-y-2">
              <Label>目标</Label>
              <Input v-model="form.srv.target" placeholder="target.example.com" />
            </div>
          </div>

          <div v-else-if="form.type === 'CAA'" class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-2">
                <Label>flags</Label>
                <Input v-model.number="form.caa.flags" type="number" min="0" max="255" placeholder="0" />
              </div>
              <div class="space-y-2">
                <Label>tag</Label>
                <Select v-model="form.caa.tag">
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="issue">issue</SelectItem>
                    <SelectItem value="issuewild">issuewild</SelectItem>
                    <SelectItem value="iodef">iodef</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div class="space-y-2">
              <Label>value</Label>
              <Input v-model="form.caa.value" placeholder="如 letsencrypt.org" />
            </div>
          </div>

          <div v-else-if="form.type === 'TLSA'" class="space-y-3">
            <div class="grid grid-cols-3 gap-3">
              <div class="space-y-2">
                <Label>usage</Label>
                <Input v-model.number="form.tlsa.usage" type="number" min="0" max="3" placeholder="0-3" />
              </div>
              <div class="space-y-2">
                <Label>selector</Label>
                <Input v-model.number="form.tlsa.selector" type="number" min="0" max="1" placeholder="0-1" />
              </div>
              <div class="space-y-2">
                <Label>matching_type</Label>
                <Input v-model.number="form.tlsa.matching_type" type="number" min="0" max="2" placeholder="0-2" />
              </div>
            </div>
            <div class="space-y-2">
              <Label>certificate</Label>
              <Textarea v-model="form.tlsa.certificate" placeholder="证书关联数据（十六进制）" rows="2" />
            </div>
          </div>

          <div v-else class="space-y-2">
            <Label>内容</Label>
            <Textarea
              v-model="form.content"
              :placeholder="contentPlaceholder"
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

          <!-- 代理开启时 CF 强制 TTL 自动，隐藏自定义选项 -->
          <div v-if="form.proxied" class="space-y-2">
            <Label>TTL</Label>
            <p class="text-xs text-muted-foreground">已代理记录的 TTL 由 Cloudflare 自动管理</p>
          </div>
          <div v-else class="grid grid-cols-2 gap-3">
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

          <div class="space-y-2">
            <Label>备注（可选）</Label>
            <Input v-model="form.comment" placeholder="记录用途说明，仅管理面板可见" />
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
            <div class="font-medium">
              {{ f.record.type ?? '?' }} · {{ f.record.name ?? '?' }} →
              {{ f.record.content ?? (f.record.data ? JSON.stringify(f.record.data) : '—') }}
            </div>
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
