<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  ArrowLeft,
  RefreshCw,
  Copy,
  Trash2,
  Loader2,
  Cloud,
  Globe,
  ShieldCheck,
  Zap,
  Rocket,
  Plus,
  Pencil,
  SlidersHorizontal,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  zonesApi,
  CFError,
  applyOptimizationPreset,
  applySingleSetting,
  listZoneSettings,
  SETTING_DEFS,
  getSettingDef,
  optionLabel,
  onoffLabel,
  type OptimizationPreset,
  type ZoneSettingItem,
  type SettingDef,
  type SettingValue,
} from '@/api'
import { usePresetsStore } from '@/stores/presets'
import DNSRecordManager from '@/components/dns/DNSRecordManager.vue'
import ZoneSecurityRules from '@/components/zones/ZoneSecurityRules.vue'
import ZoneEmailRouting from '@/components/zones/ZoneEmailRouting.vue'
import type { Zone } from '@/types/cloudflare'

const route = useRoute()
const router = useRouter()
const zoneId = computed(() => String(route.params.zoneId))

const zone = ref<Zone | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)
const activeTab = ref('dns')

async function load() {
  const id = zoneId.value // 进入时捕获 id，await 后校验，防止切 zone 后旧响应写入新状态
  loading.value = true
  loadError.value = null
  try {
    const z = await zonesApi.get(id)
    if (id !== zoneId.value) return // 已切换 zone，丢弃旧响应
    zone.value = z
  } catch (e) {
    if (id !== zoneId.value) return
    loadError.value = e instanceof Error ? e.message : String(e)
    toast.error('加载域名信息失败', { description: loadError.value })
  } finally {
    // 已切换 zone 时由新一轮 load 管理 loading，不回写
    if (id === zoneId.value) loading.value = false
  }
}

onMounted(load)

// 路由参数 zoneId 变化时组件被复用：重置本地状态并重新加载，避免显示 A 的数据、写入 B 的 zone
watch(zoneId, () => {
  zone.value = null
  loadError.value = null
  zoneSettings.value = {}
  settingsError.value = null
  purgeFilesText.value = ''
  load()
  if (activeTab.value === 'preset') loadZoneSettings()
})

// 切到「配置预设」tab 时懒加载当前 zone settings（单项调节读当前值用）
watch(activeTab, (t) => {
  if (t === 'preset' && Object.keys(zoneSettings.value).length === 0) loadZoneSettings()
})

/* ---------------- 缓存管理 ---------------- */

const purging = ref(false)
const purgingFiles = ref(false)
const purgeFilesText = ref('')
const devModeLoading = ref(false)
/** 清除缓存二次确认（项目统一 Dialog，不用原生 confirm） */
const purgeConfirmOpen = ref(false)

function purgeAll() {
  purgeConfirmOpen.value = true
}

function parsePurgeUrls(): string[] | null {
  const lines = purgeFilesText.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!lines.length) {
    toast.error('请输入至少一个完整 URL')
    return null
  }
  for (const u of lines) {
    try {
      const parsed = new URL(u)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        toast.error(`不是 http(s) URL：${u}`)
        return null
      }
    } catch {
      toast.error(`URL 不合法：${u}`)
      return null
    }
  }
  if (lines.length > 100) {
    toast.error('单次最多 100 条 URL（Cloudflare 单请求上限）')
    return null
  }
  return lines
}

async function purgeByUrls() {
  const files = parsePurgeUrls()
  const id = zoneId.value
  if (!files || !id) return
  purgingFiles.value = true
  try {
    await zonesApi.purgeCache(id, files)
    if (id !== zoneId.value) return
    toast.success(`已提交清除 ${files.length} 条 URL`)
  } catch (e) {
    if (id !== zoneId.value) return
    toast.error('按 URL 清除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    if (id === zoneId.value) purgingFiles.value = false
  }
}

async function confirmPurgeAll() {
  purgeConfirmOpen.value = false
  const id = zoneId.value
  if (!id) return
  purging.value = true
  try {
    await zonesApi.purgeCache(id)
    if (id !== zoneId.value) return
    toast.success('缓存已清除')
  } catch (e) {
    if (id !== zoneId.value) return
    toast.error('清除缓存失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    if (id === zoneId.value) purging.value = false
  }
}

async function toggleDevMode(on: boolean) {
  const id = zoneId.value // 竞态守卫：切 zone 后旧响应不写入新 zone
  devModeLoading.value = true
  try {
    await zonesApi.setDevelopmentMode(id, on)
    if (id !== zoneId.value) return
    if (zone.value) zone.value.development_mode = on ? 1 : 0
    toast.success(on ? '开发模式已开启（跳过缓存）' : '开发模式已关闭')
  } catch (e) {
    toast.error('切换开发模式失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    devModeLoading.value = false
  }
}

/* ---------------- 配置预设 ---------------- */

const presetsStore = usePresetsStore()

const applyingPresetId = ref<string | null>(null)
/** 应用预设进行中：期间锁定单项调节与另存为/编辑/删除，避免并发写冲突 */
const presetApplying = computed(() => applyingPresetId.value !== null)

/** 单项调节：当前 zone 各 setting 实际值 */
const zoneSettings = ref<Record<string, ZoneSettingItem>>({})
const settingsLoading = ref(false)
const settingsError = ref<string | null>(null)
/** 正在写入中的 setting id 集合：并发调节多个设置时各自独立 disabled，互不干扰 */
const singleApplying = ref<Set<string>>(new Set())

async function loadZoneSettings() {
  const id = zoneId.value // 进入时捕获 id，await 后校验，防止切 zone 后旧响应写入新状态
  if (!id) return
  settingsLoading.value = true
  settingsError.value = null
  try {
    const list = await listZoneSettings(id)
    if (id !== zoneId.value) return // 已切换 zone，丢弃旧响应
    const map: Record<string, ZoneSettingItem> = {}
    for (const s of list) map[s.id] = s
    zoneSettings.value = map
  } catch (e) {
    if (id !== zoneId.value) return
    if (e instanceof CFError && (e.status === 403 || e.status === 404)) {
      // 旧套餐可能不支持该列表端点，降级为空（单项调节仍可写，但读不到当前值）
      zoneSettings.value = {}
    } else {
      settingsError.value = e instanceof Error ? e.message : String(e)
      toast.error('加载当前配置失败', { description: settingsError.value })
    }
  } finally {
    if (id === zoneId.value) settingsLoading.value = false
  }
}

/** 取某 setting 当前值 */
function currentValue(id: string): SettingValue | undefined {
  return zoneSettings.value[id]?.value
}

/** 「当前」虚拟预设 id：代表当前网站实际配置，只读不可改名/删除/编辑 */
const CURRENT_PRESET_ID = 'current'
const currentPreset = computed<OptimizationPreset>(() => {
  const settings: Record<string, SettingValue> = {}
  for (const def of SETTING_DEFS) {
    const v = currentValue(def.id)
    if (v !== undefined && v !== null && v !== '') settings[def.id] = v
  }
  return {
    id: CURRENT_PRESET_ID,
    name: '当前',
    builtin: true,
    description: '当前网站的实际配置',
    settings,
  }
})

/** 全部预设：「当前」（只读）+ 用户预设 */
const allPresets = computed<OptimizationPreset[]>(() => [
  currentPreset.value,
  ...presetsStore.allPresets,
])
const selectedPresetId = ref<string>(CURRENT_PRESET_ID)
const selectedPreset = computed(() => allPresets.value.find((p) => p.id === selectedPresetId.value))
const isSelectedCurrent = computed(() => selectedPresetId.value === CURRENT_PRESET_ID)

/** 待应用的预设（项目内 Dialog 二次确认，不用原生 confirm） */
const presetApplyTarget = ref<OptimizationPreset | null>(null)

function applyPreset(preset: OptimizationPreset) {
  if (Object.keys(preset.settings).length === 0) {
    toast.error('该预设没有任何配置项')
    return
  }
  presetApplyTarget.value = preset
}

async function confirmApplyPreset() {
  const preset = presetApplyTarget.value
  if (!preset) return
  presetApplyTarget.value = null
  const id = zoneId.value // 竞态守卫：切 zone 后旧结果不再提示/刷新
  applyingPresetId.value = preset.id
  try {
    const results = await applyOptimizationPreset(id, preset)
    if (id !== zoneId.value) return
    const failed = results.filter((r) => !r.ok)
    const okCount = results.length - failed.length
    if (failed.length === 0) {
      toast.success(`「${preset.name}」已应用`, { description: `全部 ${okCount} 项配置成功` })
    } else {
      // 失败明细：中文标签 + 原因，最多列 5 条
      const lines = failed
        .slice(0, 5)
        .map((r) => `${getSettingDef(r.id)?.label ?? r.id}：${r.error ?? '未知原因'}`)
      if (failed.length > 5) lines.push('…')
      toast.error(`「${preset.name}」部分应用失败`, {
        description: `成功 ${okCount} 项，失败 ${failed.length} 项\n${lines.join('\n')}`,
      })
    }
    // 应用后刷新当前值
    await loadZoneSettings()
  } catch (e) {
    if (id !== zoneId.value) return
    toast.error('应用失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    applyingPresetId.value = null
  }
}

/** 单项调节：实时写一项 */
async function applySingle(defId: string, value: SettingValue) {
  // 重复选中同值不重复 PATCH
  if (value === currentValue(defId)) return
  const zid = zoneId.value // 竞态守卫：切 zone 后旧响应不写入新 zone 的 settings
  singleApplying.value.add(defId)
  try {
    await applySingleSetting(zid, defId, value)
    if (zid !== zoneId.value) return
    // 本地乐观更新
    zoneSettings.value = {
      ...zoneSettings.value,
      [defId]: { ...(zoneSettings.value[defId] ?? { id: defId, editable: true, modified_on: null }), value },
    }
    toast.success(`${getSettingDef(defId)?.label ?? defId} 已更新`)
  } catch (e) {
    toast.error('更新失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    singleApplying.value.delete(defId)
  }
}

/* ---------------- 预设编辑器 ---------------- */

const editorOpen = ref(false)
const editingPreset = ref<OptimizationPreset | null>(null)
/** 编辑中的工作副本（深拷贝，取消不影响原预设） */
const editorDraft = ref<OptimizationPreset | null>(null)

function openEditor(preset: OptimizationPreset) {
  // 内置预设只读：仅编辑深拷贝草稿，保存时才另存为用户预设副本（取消编辑不残留副本）
  editingPreset.value = preset
  // JSON 深拷贝断开引用：preset 可能是响应式 Proxy（structuredClone 克隆 Proxy 必抛 DataCloneError）
  editorDraft.value = JSON.parse(JSON.stringify(preset)) as OptimizationPreset
  editorOpen.value = true
}

function openNewPreset() {
  const draft: OptimizationPreset = {
    id: '', // 创建时由 store 生成
    name: '我的预设',
    builtin: false,
    description: '',
    settings: {},
  }
  editingPreset.value = null
  editorDraft.value = draft
  editorOpen.value = true
}

/** 切换某项是否纳入预设（勾选 = 纳入，并初始化为当前 zone 值或默认） */
function toggleDraftSetting(defId: string, on: boolean) {
  if (!editorDraft.value) return
  const next = { ...editorDraft.value.settings }
  if (on) {
    if (!(defId in next)) {
      const cur = currentValue(defId)
      next[defId] = cur ?? defaultForSetting(defId)
    }
  } else {
    delete next[defId]
  }
  editorDraft.value = { ...editorDraft.value, settings: next }
}

function setDraftValue(defId: string, value: SettingValue) {
  if (!editorDraft.value) return
  editorDraft.value = { ...editorDraft.value, settings: { ...editorDraft.value.settings, [defId]: value } }
}

function saveDraft() {
  if (!editorDraft.value) return
  const name = editorDraft.value.name.trim()
  if (!name) {
    toast.error('请填写预设名称')
    return
  }
  if (Object.keys(editorDraft.value.settings).length === 0) {
    toast.error('请至少勾选 1 项配置')
    return
  }
  if (editingPreset.value) {
    // 编辑已有用户预设（预设可能已在别处被删除，更新失败则中止不假报成功）
    const ok = presetsStore.updatePreset(editingPreset.value.id, {
      name,
      description: editorDraft.value.description,
      settings: editorDraft.value.settings,
    })
    if (!ok) {
      toast.error('预设已不存在')
      return
    }
    toast.success('预设已更新')
  } else {
    // 新建
    presetsStore.createPreset(name, editorDraft.value.settings, editorDraft.value.description)
    toast.success('预设已创建')
  }
  editorOpen.value = false
  editorDraft.value = null
  editingPreset.value = null
}

/**
 * 另存为：把下方「单项调节」区当前的实时配置值快照成一个新用户预设。
 * 不弹窗选择 —— 基于当前 zone 实际配置直接落盘，新建后可点编辑按钮改名/调整。
 */
function saveCurrentAsPreset() {
  const entries = SETTING_DEFS
    .map((d) => [d.id, currentValue(d.id)] as const)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!entries.length) {
    toast.error('暂无可保存的配置', { description: '请先点右上角「刷新」加载当前配置值' })
    return
  }
  const settings = Object.fromEntries(entries) as Record<string, SettingValue>
  // 同名时追加序号，避免多份预设名称完全相同难以区分
  const base = `${zone.value?.name ?? '当前'} 的配置`
  const existing = new Set(presetsStore.allPresets.map((p) => p.name))
  let name = base
  for (let i = 2; existing.has(name); i++) name = `${base} ${i}`
  const created = presetsStore.createPreset(name, settings)
  selectedPresetId.value = created.id
  toast.success(`已将当前配置另存为「${name}」`, {
    description: '可点编辑按钮改名或调整纳入项',
  })
}

/** 待删除的预设（项目内 Dialog 二次确认，不用原生 confirm） */
const presetDeleteTarget = ref<OptimizationPreset | null>(null)
const presetDeleting = ref(false)

function deletePreset(preset: OptimizationPreset) {
  presetDeleteTarget.value = preset
}

async function confirmDeletePreset() {
  if (!presetDeleteTarget.value) return
  // 防御性守卫：内置预设（含「当前」虚拟预设）不可删除
  if (presetDeleteTarget.value.builtin || presetDeleteTarget.value.id === CURRENT_PRESET_ID) {
    toast.error('内置预设不可删除')
    presetDeleteTarget.value = null
    return
  }
  presetDeleting.value = true
  try {
    const id = presetDeleteTarget.value.id
    presetsStore.deletePreset(id)
    // 删的是当前选中预设则回退到第一个
    if (selectedPresetId.value === id) {
      selectedPresetId.value = allPresets.value[0]?.id ?? ''
    }
    toast.success('预设已删除')
    presetDeleteTarget.value = null
  } finally {
    presetDeleting.value = false
  }
}

/* ---------------- 展示辅助 ---------------- */

/** 设置项的展示值（中文文案，对齐 CF 仪表板） */
function displayValue(def: SettingDef, value: SettingValue | undefined): string {
  if (value === undefined) return '—'
  if (def.type === 'onoff') return onoffLabel(value)
  if (def.type === 'number') return fmtSeconds(Number(value))
  if (def.type === 'select' || def.type === 'security_level') {
    return optionLabel(def.id, String(value))
  }
  return String(value)
}

/** select 选项列表：实际值不在枚举内时动态追加（避免 Select 空占位），模板据 def.options 判断标注（当前） */
function selectOptions(def: SettingDef, value: SettingValue | undefined): string[] {
  const opts = def.options ?? []
  if (value === undefined || value === null || value === '') return opts
  const s = String(value)
  return opts.includes(s) ? opts : [...opts, s]
}

/** number 选项列表：同 selectOptions，处理枚举秒数外的实际值 */
function numberSelectOptions(def: SettingDef, value: SettingValue | undefined): number[] {
  const opts = def.numberOptions ?? []
  if (value === undefined || value === null || value === '') return opts
  const n = Number(value)
  return opts.includes(n) ? opts : [...opts, n]
}

function defaultForSetting(defId: string): SettingValue {
  const def = getSettingDef(defId)
  if (!def) return 'off'
  if (def.type === 'onoff') return 'off'
  if (def.type === 'number') return def.numberOptions?.[0] ?? 0
  return def.options?.[0] ?? ''
}

function fmtSeconds(sec: number): string {
  // CF 语义：browser_cache_ttl=0 表示遵循源站响应头（Respect Existing Headers），并非不缓存
  if (sec <= 0) return '遵循源站响应头'
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时`
  if (sec < 2592000) return `${Math.round(sec / 86400)} 天`
  if (sec < 31536000) return `${Math.round(sec / 2592000)} 个月`
  return `${Math.round(sec / 31536000)} 年`
}

const SETTING_GROUPS: { key: SettingDef['group']; label: string }[] = [
  { key: 'ssl', label: 'SSL / HTTPS' },
  { key: 'security', label: '安全防护' },
  { key: 'cache', label: '缓存' },
  { key: 'speed', label: '速度优化' },
]

async function copy(text: string, label = '内容') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label}已复制`)
  } catch {
    toast.error('复制失败')
  }
}

/* ---------------- 删除域名 ---------------- */

const deleteOpen = ref(false)
const deleting = ref(false)

async function confirmDelete() {
  deleting.value = true
  try {
    await zonesApi.delete(zoneId.value)
    toast.success('域名已删除')
    deleteOpen.value = false
    router.push('/zones')
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

/* ---------------- 展示 ---------------- */

const statusText = computed(() => zone.value?.status ?? '')
const isActive = computed(() => zone.value?.status === 'active')
const devModeOn = computed(() => (zone.value?.development_mode ?? 0) > 0)

function fmtDate(s: string | null): string {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- 面包屑 + 返回 -->
    <div class="flex items-center justify-between gap-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink as-child>
              <RouterLink to="/zones">域名管理</RouterLink>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{{ zone?.name ?? zoneId }}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Button variant="ghost" size="sm" @click="router.push('/zones')">
        <ArrowLeft class="size-4" />
        返回列表
      </Button>
    </div>

    <!-- 域名信息卡片 -->
    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Globe class="size-5" />
            </div>
            <div>
              <div class="flex items-center gap-2">
                <CardTitle class="text-lg">{{ zone?.name ?? (loadError ? zoneId : '加载中…') }}</CardTitle>
                <Badge
                  v-if="zone"
                  :class="isActive ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'"
                  variant="secondary"
                >
                  {{ statusText }}
                </Badge>
              </div>
              <CardDescription>
                <template v-if="zone">{{ zone.plan?.name ?? '未知套餐' }} · {{ zone.account?.name ?? zone.account?.id }}</template>
                <template v-else>{{ loadError ? '域名信息加载失败' : '正在加载域名信息' }}</template>
              </CardDescription>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" :disabled="loading" @click="load">
              <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
              刷新
            </Button>
            <Button variant="outline" size="sm" class="text-destructive hover:text-destructive" @click="deleteOpen = true">
              <Trash2 class="size-4" />
              删除域名
            </Button>
          </div>
        </div>
      </CardHeader>
    </Card>

    <!-- 加载失败错误卡片 -->
    <Card v-if="loadError && !zone">
      <CardContent class="flex flex-wrap items-center justify-between gap-4 py-6">
        <div class="min-w-0">
          <div class="text-sm font-medium text-destructive">加载域名信息失败</div>
          <p class="mt-1 break-all text-xs text-muted-foreground">{{ loadError }}</p>
        </div>
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
          重试
        </Button>
      </CardContent>
    </Card>

    <!-- Tabs -->
    <Tabs v-model="activeTab" class="w-full">
      <div class="overflow-x-auto">
      <TabsList>
        <TabsTrigger value="dns">DNS 记录</TabsTrigger>
        <TabsTrigger value="cache">缓存</TabsTrigger>
        <TabsTrigger value="preset">配置预设</TabsTrigger>
        <TabsTrigger value="security">安全规则</TabsTrigger>
        <TabsTrigger value="email">Email</TabsTrigger>
        <TabsTrigger value="overview">概览</TabsTrigger>
      </TabsList>
      </div>

      <!-- DNS 记录 -->
      <TabsContent value="dns" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <Cloud class="size-4 text-primary" />
              DNS 记录管理
            </CardTitle>
            <CardDescription>管理该域名的所有 DNS 记录</CardDescription>
          </CardHeader>
          <CardContent>
            <!-- key 绑定 zoneId：切 zone 强制重建实例，杜绝旧实例在途响应写入 -->
            <DNSRecordManager :key="zoneId" :zone-id="zoneId" :zone-name="zone?.name" />
          </CardContent>
        </Card>
      </TabsContent>

      <!-- 缓存 -->
      <TabsContent value="cache" class="mt-4">
        <div class="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base">
                <Zap class="size-4 text-amber-500" />
                清除缓存
              </CardTitle>
              <CardDescription>优先按 URL 清除；全站清除会影响全部边缘缓存</CardDescription>
            </CardHeader>
            <CardContent class="space-y-3">
              <div class="space-y-1.5">
                <Label>按 URL 清除</Label>
                <Textarea
                  v-model="purgeFilesText"
                  class="min-h-24 font-mono text-xs"
                  placeholder="每行一个完整 URL，如&#10;https://example.com/app.js"
                />
                <p class="text-xs text-muted-foreground">每行一条 UTF-8 完整 URL，不支持通配符。单次最多 100 条。</p>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" :disabled="purgingFiles || purging || !zone" @click="purgeByUrls">
                  <Loader2 v-if="purgingFiles" class="size-4 animate-spin" />
                  清除这些 URL
                </Button>
                <Button variant="destructive" size="sm" :disabled="purging || purgingFiles || !zone" @click="purgeAll">
                  <Loader2 v-if="purging" class="size-4 animate-spin" />
                  清除全部缓存
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base">
                <ShieldCheck class="size-4 text-primary" />
                开发模式
              </CardTitle>
              <CardDescription>开启后绕过缓存，直接回源（3 小时后自动关闭）</CardDescription>
            </CardHeader>
            <CardContent>
              <div class="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <div class="text-sm font-medium">
                    当前状态：
                    <span :class="devModeOn ? 'text-amber-600' : 'text-muted-foreground'">
                      {{ devModeOn ? '已开启' : '已关闭' }}
                    </span>
                  </div>
                  <p class="text-xs text-muted-foreground">用于调试源站内容</p>
                </div>
                <Switch
                  :model-value="devModeOn"
                  :disabled="devModeLoading || !zone"
                  @update:model-value="(v: boolean) => toggleDevMode(v)"
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <!-- 配置预设 -->
      <TabsContent value="preset" class="mt-4">
        <div class="space-y-6">
          <!-- 单项调节（含预设快速应用） -->
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base">
                <SlidersHorizontal class="size-4 text-primary" />
                配置预设与单项调节
              </CardTitle>
              <CardDescription>选择预设一键批量应用，或在下方逐项实时调节；自定义预设可改名、增删、全局保存</CardDescription>
            </CardHeader>
            <CardContent class="space-y-5">
              <!-- 快速应用预设 -->
              <div class="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
                <div class="flex items-center gap-1.5 text-sm font-medium">
                  <component :is="Rocket" class="size-4 text-amber-500" />
                  应用预设
                </div>
                <Select v-model="selectedPresetId">
                  <SelectTrigger class="h-9 w-56">
                    <SelectValue placeholder="选择预设方案" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="p in allPresets" :key="p.id" :value="p.id">
                      {{ p.name }}{{ p.builtin ? '（内置）' : '' }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  :disabled="!selectedPreset || !!applyingPresetId || isSelectedCurrent"
                  :title="isSelectedCurrent ? '当前配置即为网站现有设置，无需应用' : '批量应用该预设'"
                  @click="selectedPreset && applyPreset(selectedPreset)"
                >
                  <Loader2 v-if="applyingPresetId === selectedPresetId" class="size-4 animate-spin" />
                  <component :is="ShieldCheck" v-else class="size-4" />
                  应用
                </Button>
                <Button variant="outline" size="sm" title="将当前配置另存为新预设" :disabled="presetApplying" @click="saveCurrentAsPreset">
                  <Copy class="size-3.5" />
                  另存为
                </Button>
                <Button v-if="selectedPreset && !isSelectedCurrent" variant="outline" size="sm" title="编辑预设" :disabled="presetApplying" @click="selectedPreset && openEditor(selectedPreset)">
                  <Pencil class="size-3.5" />
                </Button>
                <Button v-if="selectedPreset && !selectedPreset.builtin" variant="ghost" size="sm" class="text-destructive hover:text-destructive" title="删除预设" :disabled="presetApplying" @click="selectedPreset && deletePreset(selectedPreset)">
                  <Trash2 class="size-3.5" />
                </Button>
                <Button variant="ghost" size="sm" class="ml-auto" @click="openNewPreset">
                  <Plus class="size-3.5" />
                  新建
                </Button>
              </div>

              <!-- 当前预设警告 + 逐项结果 -->
              <Alert v-if="selectedPreset?.warning" variant="destructive" class="py-2">
                <AlertDescription class="text-xs">{{ selectedPreset.warning }}</AlertDescription>
              </Alert>

              <!-- 单项调节区：刷新按钮置于该区右上角 -->
              <div class="flex items-center justify-between">
                <div class="text-xs font-medium text-muted-foreground">单项实时调节</div>
                <Button variant="ghost" size="sm" :disabled="settingsLoading" @click="loadZoneSettings">
                  <RefreshCw class="size-4" :class="{ 'animate-spin': settingsLoading }" />
                  刷新
                </Button>
              </div>

              <!-- 加载出错：错误信息 + 重试（403/404 已在逻辑层降级，不会走到这里） -->
              <Alert v-if="settingsError" variant="destructive" class="py-3">
                <AlertDescription class="flex flex-wrap items-center justify-between gap-3 text-xs">
                  <span class="break-all">加载当前配置失败：{{ settingsError }}</span>
                  <Button variant="outline" size="sm" :disabled="settingsLoading" @click="loadZoneSettings">
                    <RefreshCw class="size-3.5" :class="{ 'animate-spin': settingsLoading }" />
                    重试
                  </Button>
                </AlertDescription>
              </Alert>

              <!-- 加载中：骨架占位 -->
              <div v-else-if="settingsLoading" class="grid gap-2 sm:grid-cols-2">
                <Skeleton v-for="i in 8" :key="i" class="h-16 rounded-lg" />
              </div>

              <template v-else>
                <div v-for="g in SETTING_GROUPS" :key="g.key">
                  <div class="mb-2 text-xs font-medium text-muted-foreground">{{ g.label }}</div>
                  <div class="grid gap-2 sm:grid-cols-2">
                    <div
                      v-for="def in SETTING_DEFS.filter((d) => d.group === g.key)"
                      :key="def.id"
                      class="flex items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div class="min-w-0">
                        <div class="flex items-center gap-1.5 text-sm">
                          {{ def.label }}
                          <Badge v-if="def.requiresPro" variant="outline" class="text-[10px]">Pro</Badge>
                        </div>
                        <div class="truncate text-xs text-muted-foreground">
                          当前：{{ displayValue(def, currentValue(def.id)) }}
                        </div>
                        <div v-if="zoneSettings[def.id]?.editable === false" class="text-[10px] text-amber-600">
                          套餐不支持修改
                        </div>
                      </div>
                      <!-- onoff -->
                      <Switch
                        v-if="def.type === 'onoff'"
                        :model-value="currentValue(def.id) === 'on'"
                        :disabled="singleApplying.has(def.id) || presetApplying || zoneSettings[def.id]?.editable === false"
                        @update:model-value="(v) => applySingle(def.id, v ? 'on' : 'off')"
                      />
                      <!-- select / security_level -->
                      <Select
                        v-else-if="def.type === 'select' || def.type === 'security_level'"
                        :model-value="String(currentValue(def.id) ?? '')"
                        :disabled="singleApplying.has(def.id) || presetApplying || zoneSettings[def.id]?.editable === false"
                        @update:model-value="(v) => applySingle(def.id, String(v))"
                      >
                        <SelectTrigger class="w-36">
                          <SelectValue placeholder="选择" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="o in selectOptions(def, currentValue(def.id))" :key="o" :value="o">
                            {{ optionLabel(def.id, o) }}{{ def.options?.includes(o) ? '' : '（当前）' }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <!-- number（枚举秒数） -->
                      <Select
                        v-else-if="def.type === 'number'"
                        :model-value="String(currentValue(def.id) ?? '')"
                        :disabled="singleApplying.has(def.id) || presetApplying || zoneSettings[def.id]?.editable === false"
                        @update:model-value="(v) => applySingle(def.id, Number(v))"
                      >
                        <SelectTrigger class="w-36">
                          <SelectValue placeholder="选择" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="o in numberSelectOptions(def, currentValue(def.id))" :key="o" :value="String(o)">
                            {{ fmtSeconds(o) }}{{ def.numberOptions?.includes(o) ? '' : '（当前）' }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </template>
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <!-- 安全规则 -->
      <TabsContent value="security" class="mt-4">
        <!-- key 绑定 zoneId：切 zone 强制重建实例，杜绝旧实例在途响应写入 -->
        <ZoneSecurityRules :key="zoneId" :zone-id="zoneId" />
      </TabsContent>

      <TabsContent value="email" class="mt-4">
        <ZoneEmailRouting :key="zoneId" :zone-id="zoneId" :zone-name="zone?.name" />
      </TabsContent>

      <!-- 预设编辑器 -->
      <Dialog v-model:open="editorOpen">
        <DialogContent class="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{{ editingPreset ? '编辑预设' : '新建预设' }}</DialogTitle>
            <DialogDescription>勾选要纳入预设的配置项并设置目标值，保存后全局可用</DialogDescription>
          </DialogHeader>
          <div v-if="editorDraft" class="space-y-4">
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-1.5">
                <Label>预设名称</Label>
                <Input v-model="editorDraft.name" placeholder="如 我的站点加速" />
              </div>
              <div class="space-y-1.5">
                <Label>描述（可选）</Label>
                <Input v-model="editorDraft.description" placeholder="一句话说明" />
              </div>
            </div>
            <div class="max-h-[50vh] space-y-4 overflow-y-auto rounded-lg border p-3">
              <div v-for="g in SETTING_GROUPS" :key="g.key">
                <div class="mb-2 text-xs font-medium text-muted-foreground">{{ g.label }}</div>
                <div class="space-y-2">
                  <div
                    v-for="def in SETTING_DEFS.filter((d) => d.group === g.key)"
                    :key="def.id"
                    class="flex items-center justify-between gap-3 rounded-md border p-2"
                  >
                    <div class="flex items-center gap-2">
                      <Checkbox
                        :model-value="def.id in editorDraft.settings"
                        @update:model-value="(v) => toggleDraftSetting(def.id, v === true)"
                      />
                      <span class="text-sm">{{ def.label }}</span>
                      <Badge v-if="def.requiresPro" variant="outline" class="text-[10px]">Pro</Badge>
                    </div>
                    <div v-if="def.id in editorDraft.settings" class="flex items-center gap-2">
                      <Switch
                        v-if="def.type === 'onoff'"
                        :model-value="editorDraft.settings[def.id] === 'on'"
                        @update:model-value="(v) => setDraftValue(def.id, v ? 'on' : 'off')"
                      />
                      <Select
                        v-else-if="def.type === 'select' || def.type === 'security_level'"
                        :model-value="String(editorDraft.settings[def.id] ?? '')"
                        @update:model-value="(v) => setDraftValue(def.id, String(v))"
                      >
                        <SelectTrigger class="w-32"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="o in selectOptions(def, editorDraft.settings[def.id])" :key="o" :value="o">
                            {{ optionLabel(def.id, o) }}{{ def.options?.includes(o) ? '' : '（当前）' }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Select
                        v-else-if="def.type === 'number'"
                        :model-value="String(editorDraft.settings[def.id] ?? '')"
                        @update:model-value="(v) => setDraftValue(def.id, Number(v))"
                      >
                        <SelectTrigger class="w-32"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="o in numberSelectOptions(def, editorDraft.settings[def.id])" :key="o" :value="String(o)">
                            {{ fmtSeconds(o) }}{{ def.numberOptions?.includes(o) ? '' : '（当前）' }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" @click="editorOpen = false">取消</Button>
            <Button @click="saveDraft">保存预设</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <!-- 概览 -->
      <TabsContent value="overview" class="mt-4">
        <!-- 域名未激活提示 -->
        <Alert v-if="zone && !isActive" class="mb-4 py-2">
          <AlertDescription class="text-xs">
            域名尚未激活（{{ zone.status }}），部分操作可能被 Cloudflare 拒绝
          </AlertDescription>
        </Alert>
        <Card v-if="zone">
          <CardHeader>
            <CardTitle class="text-base">域名概览</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="rounded-lg border p-3">
                <div class="text-xs text-muted-foreground">域名 ID</div>
                <code class="text-xs">{{ zone.id }}</code>
              </div>
              <div class="rounded-lg border p-3">
                <div class="text-xs text-muted-foreground">状态</div>
                <div class="text-sm">{{ zone.status }}</div>
              </div>
              <div class="rounded-lg border p-3">
                <div class="text-xs text-muted-foreground">类型</div>
                <div class="text-sm">{{ zone.type }}</div>
              </div>
              <div class="rounded-lg border p-3">
                <div class="text-xs text-muted-foreground">套餐</div>
                <div class="text-sm">{{ zone.plan?.name ?? '—' }}</div>
              </div>
              <div class="rounded-lg border p-3">
                <div class="text-xs text-muted-foreground">激活时间</div>
                <div class="text-sm">{{ fmtDate(zone.activated_on) }}</div>
              </div>
              <div class="rounded-lg border p-3">
                <div class="text-xs text-muted-foreground">修改时间</div>
                <div class="text-sm">{{ fmtDate(zone.modified_on) }}</div>
              </div>
            </div>

            <Separator />

            <div>
              <div class="mb-2 text-sm font-medium">权限</div>
              <div class="flex flex-wrap gap-1.5">
                <Badge v-for="p in zone.permissions" :key="p" variant="outline" class="font-mono text-xs">
                  {{ p }}
                </Badge>
              </div>
            </div>

            <Separator />

            <!-- 名称服务器（合并自原顶部信息卡） -->
            <div class="grid gap-4 md:grid-cols-2">
              <!-- Cloudflare 名称服务器 -->
              <div class="space-y-2 rounded-lg border p-4">
                <div class="flex items-center gap-2 text-sm font-medium">
                  <Cloud class="size-4 text-primary" />
                  Cloudflare 名称服务器
                </div>
                <ul class="space-y-1.5">
                  <li v-for="ns in zone.name_servers" :key="ns" class="flex items-center justify-between gap-2 text-sm">
                    <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{{ ns }}</code>
                    <Button variant="ghost" size="icon-sm" @click="copy(ns, 'NS')">
                      <Copy class="size-3" />
                    </Button>
                  </li>
                </ul>
                <p class="text-xs text-muted-foreground">
                  请到域名注册商将 NS 改为上述名称服务器
                </p>
              </div>

              <!-- 原始名称服务器 -->
              <div class="space-y-2 rounded-lg border p-4">
                <div class="flex items-center gap-2 text-sm font-medium">
                  <ArrowLeft class="size-4 text-muted-foreground" />
                  原始名称服务器
                </div>
                <ul v-if="zone.original_name_servers?.length" class="space-y-1.5">
                  <li v-for="ns in zone.original_name_servers" :key="ns" class="text-sm">
                    <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{{ ns }}</code>
                  </li>
                </ul>
                <p v-else class="text-sm text-muted-foreground">无（可能已完全迁移）</p>
                <p v-if="zone.original_registrar" class="text-xs text-muted-foreground">
                  原注册商：{{ zone.original_registrar }}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <div v-else class="rounded-lg border p-10 text-center text-sm text-muted-foreground">
          正在加载域名信息
        </div>
      </TabsContent>
    </Tabs>

    <!-- 删除域名确认 -->
    <Dialog v-model:open="deleteOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除域名</DialogTitle>
          <DialogDescription>
            确认删除域名 <span class="font-medium text-foreground">{{ zone?.name }}</span>？
            删除后该域名将从 Cloudflare 移除，DNS 记录与相关配置将丢失，此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteOpen = false">取消</Button>
          <Button variant="destructive" :disabled="deleting" @click="confirmDelete">
            <Loader2 v-if="deleting" class="size-4 animate-spin" />
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 清除缓存确认 -->
    <Dialog v-model:open="purgeConfirmOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>清除全部缓存</DialogTitle>
          <DialogDescription>
            确认清除域名 <span class="font-medium text-foreground">{{ zone?.name ?? zoneId }}</span> 下的全部缓存？
            清除后访问者将回源重新拉取最新内容。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="purgeConfirmOpen = false">取消</Button>
          <Button variant="destructive" :disabled="purging" @click="confirmPurgeAll">
            <Loader2 v-if="purging" class="size-4 animate-spin" />
            确认清除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 应用预设确认 -->
    <Dialog
      :open="!!presetApplyTarget"
      @update:open="(v) => { if (!v) presetApplyTarget = null }"
    >
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>应用预设</DialogTitle>
          <DialogDescription>
            确认应用 <span class="font-medium text-foreground">{{ presetApplyTarget?.name }}</span>？
            将批量覆盖该域名 {{ Object.keys(presetApplyTarget?.settings ?? {}).length }} 项配置，此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="presetApplyTarget = null">取消</Button>
          <Button :disabled="presetApplying" @click="confirmApplyPreset">
            <Loader2 v-if="presetApplying" class="size-4 animate-spin" />
            确认应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除预设确认 -->
    <Dialog
      :open="!!presetDeleteTarget"
      @update:open="(v) => { if (!v) presetDeleteTarget = null }"
    >
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除预设</DialogTitle>
          <DialogDescription>
            确认删除自定义预设
            <span class="font-medium text-foreground">{{ presetDeleteTarget?.name }}</span>？
            删除后该预设将不再可用，此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="presetDeleteTarget = null">取消</Button>
          <Button variant="destructive" :disabled="presetDeleting" @click="confirmDeletePreset">
            <Loader2 v-if="presetDeleting" class="size-4 animate-spin" />
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
