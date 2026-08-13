<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  BarChart3,
  Globe,
  Eye,
  Users,
  ShieldAlert,
  Gauge,
  RefreshCw,
  Activity,
  Server,
} from '@lucide/vue'
import VChart from 'vue-echarts'
import { zonesApi, zoneTraffic, zoneTopCountries, accountWorkers } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { Zone } from '@/types/cloudflare'
import type { CountryRow, TimePoint, WorkerInvocationRow, ZoneSummary } from '@/api/analytics'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { setupECharts } from './echarts'

setupECharts()

/* ---------- 控件状态 ---------- */

type RangeKey = '24h' | '7d' | '30d'

const ranges: { key: RangeKey; label: string }[] = [
  { key: '24h', label: '最近 24 小时' },
  { key: '7d', label: '最近 7 天' },
  { key: '30d', label: '最近 30 天' },
]

const zones = ref<Zone[]>([])
const zonesLoading = ref(true)
const selectedZoneId = ref<string>('')
const range = ref<RangeKey>('7d')

function computeRange(key: RangeKey): { since: string; until: string } {
  const until = new Date()
  const since = new Date()
  if (key === '24h') since.setHours(since.getHours() - 24)
  else if (key === '7d') since.setDate(since.getDate() - 7)
  else since.setDate(since.getDate() - 30)
  return { since: since.toISOString(), until: until.toISOString() }
}

/* ---------- 数据状态 ---------- */

const points = ref<TimePoint[]>([])
const summary = ref<ZoneSummary | null>(null)
const countries = ref<CountryRow[]>([])
const loading = ref(false)
const errorMsg = ref('')

const workerRows = ref<WorkerInvocationRow[]>([])
const workerTotal = ref(0)
const workerLoading = ref(false)
const workerError = ref('')

const auth = useAuthStore()

const hasData = computed(() => points.value.length > 0)

const totalRequestsTrend = computed(() =>
  points.value.reduce((s, p) => s + p.requests, 0),
)

/* ---------- 加载 ---------- */

/** 域名列表加载失败信息（区分错误态与「还没有域名」空态） */
const zonesError = ref('')

async function loadZones() {
  zonesLoading.value = true
  zonesError.value = ''
  try {
    const list = await zonesApi.listAll()
    zones.value = list
    if (!selectedZoneId.value && list.length) selectedZoneId.value = list[0].id
  } catch (e) {
    zonesError.value = e instanceof Error ? e.message : String(e)
    toast.error('加载域名列表失败', { description: zonesError.value })
  } finally {
    zonesLoading.value = false
  }
}

/** 请求序号：切域名/时间范围连发时丢弃后发先至的旧响应 */
let analyticsSeq = 0

async function loadAnalytics() {
  if (!selectedZoneId.value) return
  const seq = ++analyticsSeq
  loading.value = true
  errorMsg.value = ''
  points.value = []
  summary.value = null
  countries.value = []
  const { since, until } = computeRange(range.value)
  try {
    const [traffic, topCountries] = await Promise.all([
      zoneTraffic(selectedZoneId.value, since, until),
      zoneTopCountries(selectedZoneId.value, since, until, 8).catch(() => null),
    ])
    if (seq !== analyticsSeq) return
    points.value = traffic.points
    summary.value = traffic.summary
    if (topCountries) countries.value = topCountries.rows
  } catch (e) {
    if (seq !== analyticsSeq) return
    errorMsg.value = e instanceof Error ? e.message : String(e)
    toast.error('加载分析数据失败', { description: errorMsg.value })
  } finally {
    if (seq === analyticsSeq) loading.value = false
  }
}

let workersSeq = 0

async function loadWorkers() {
  const accountId = auth.currentAccount?.accountId
  if (!accountId) return
  const seq = ++workersSeq
  workerLoading.value = true
  workerError.value = ''
  workerRows.value = []
  workerTotal.value = 0
  const { since, until } = computeRange(range.value)
  try {
    const res = await accountWorkers(accountId, since, until)
    if (seq !== workersSeq) return
    workerRows.value = res.rows
    workerTotal.value = res.total
  } catch (e) {
    if (seq !== workersSeq) return
    workerError.value = e instanceof Error ? e.message : String(e)
    toast.error('加载 Workers 数据失败', { description: workerError.value })
  } finally {
    if (seq === workersSeq) workerLoading.value = false
  }
}

/* ---------- 主题响应 ---------- */

/** 主题切换（html 的 class/attribute 变化）时 bump，驱动图表 computed 重取 CSS 变量配色 */
const themeVersion = ref(0)
let themeObserver: MutationObserver | null = null

onMounted(() => {
  // loadZones 设置 selectedZoneId 后由下方 watch 触发 loadAnalytics，首屏只发一组请求
  loadZones()
  loadWorkers()
  themeObserver = new MutationObserver(() => {
    themeVersion.value++
  })
  themeObserver.observe(document.documentElement, { attributes: true })
})

onUnmounted(() => {
  themeObserver?.disconnect()
  themeObserver = null
})

watch([selectedZoneId, range], () => {
  if (selectedZoneId.value) loadAnalytics()
})

watch(range, loadWorkers)

/* ---------- 渲染辅助 ---------- */

const nf = new Intl.NumberFormat('en-US')
function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '0'
  return nf.format(n)
}
function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`
}
function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

const summaryCards = computed(() => {
  const s = summary.value
  return [
    { label: '总请求数', value: s ? fmtNum(s.requests) : '0', icon: Activity, hint: '区间累计' },
    { label: '页面浏览', value: s ? fmtNum(s.pageViews) : '0', icon: Eye, hint: 'PageViews' },
    { label: '唯一访客', value: s ? fmtNum(s.uniqueVisitors) : '0', icon: Users, hint: 'Uniques' },
    { label: '威胁拦截', value: s ? fmtNum(s.threats) : '0', icon: ShieldAlert, hint: 'Threats' },
    {
      label: '缓存命中率',
      value: s ? pct(s.cacheHitRate) : '0%',
      icon: Gauge,
      hint: fmtBytes(s?.cachedBytes ?? 0),
    },
  ]
})

/* ---------- ECharts 配置（纯对象，配色走 CSS 变量） ---------- */

/** 取 CSS 变量色值（fallback 到默认），供 ECharts 配色使用 */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** 给 oklch/rgb 颜色加 alpha（ECharts 不支持 oklch 拼字符串 alpha，需用 / 语法或 rgba）。
 *  仅支持 oklch(...) 形式，转成带 alpha 的 oklch；其他原样返回。 */
function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^oklch\(([^)]*)\)$/i)
  if (m) return `oklch(${m[1]} / ${alpha})`
  // 形如 rgb(1 2 3) 或 #hex
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      return `rgba(${r},${g},${b},${alpha})`
    }
  }
  return color
}

function fmtAxis(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return `${n}`
}

/** 请求趋势图：双轴面积/折线（请求 + 流量），暗色适配 */
const trendOption = computed(() => {
  // 依赖 themeVersion：主题切换后重新取 CSS 变量，图表配色跟随更新
  void themeVersion.value
  const colorPrimary = cssVar('--chart-1', '#5b8ff9')
  const colorMuted = cssVar('--muted-foreground', '#999')
  const colorBorder = cssVar('--border', '#eee')
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: cssVar('--popover', '#fff'),
      borderColor: colorBorder,
      textStyle: { color: cssVar('--popover-foreground', '#333'), fontSize: 12 },
      // 关闭 axisPointer 触发的 emphasis 淡出（showSymbol:false 时已知 bug，hover 点会消失）
      axisPointer: { type: 'line', triggerEmphasis: false },
      // series.data 只放数值（对象展开会让 label 等字段被 ECharts 当成保留配置），
      // 这里用 dataIndex 回查 points 取原始数据
      formatter: (params: Array<{ dataIndex: number }>) => {
        const p = points.value[params[0]?.dataIndex ?? -1]
        if (!p) return ''
        return `<div style="font-weight:600">${p.label}</div>
          <div>请求 ${fmtNum(p.requests)}</div>
          <div>流量 ${fmtBytes(p.bytes)}</div>
          <div>威胁 ${fmtNum(p.threats)}</div>`
      },
    },
    grid: { left: 48, right: 16, top: 16, bottom: 28 },
    xAxis: {
      type: 'category',
      data: points.value.map((p) => p.label),
      boundaryGap: false,
      axisLine: { lineStyle: { color: colorBorder } },
      axisLabel: { color: colorMuted, fontSize: 11, hideOverlap: true },
      axisTick: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: '请求',
        nameTextStyle: { color: colorMuted, fontSize: 10 },
        axisLabel: { color: colorMuted, fontSize: 11, formatter: (v: number) => fmtAxis(v) },
        splitLine: { lineStyle: { color: colorBorder, type: 'dashed' } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
    ],
    series: [
      {
        name: '请求',
        type: 'line',
        smooth: true,
        showSymbol: false,
        // data 只放数值：tooltip 通过 dataIndex 回查 points，避免展开对象踩 ECharts 保留字段（label 等）
        data: points.value.map((p) => p.requests),
        lineStyle: { color: colorPrimary, width: 2 },
        itemStyle: { color: colorPrimary },
        // 彻底禁用 emphasis 态（showSymbol:false hover 点消失为 ECharts 已知 bug，
        // emphasis.disabled 是未文档化但官方确认有效的 workaround，见 apache/echarts#19766）
        emphasis: { disabled: true },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: withAlpha(colorPrimary, 0.4) },
              { offset: 1, color: withAlpha(colorPrimary, 0) },
            ],
          },
        },
      },
    ],
  }
})

/** 国家分布：横向柱状图 */
const countryOption = computed(() => {
  // 依赖 themeVersion：主题切换后重新取 CSS 变量，图表配色跟随更新
  void themeVersion.value
  const colorPrimary = cssVar('--chart-1', '#5b8ff9')
  const colorMuted = cssVar('--muted-foreground', '#999')
  const colorBorder = cssVar('--border', '#eee')
  const rows = [...countries.value].reverse() // 反转使 Top1 在顶部
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: cssVar('--popover', '#fff'),
      borderColor: colorBorder,
      textStyle: { color: cssVar('--popover-foreground', '#333'), fontSize: 12 },
      // series.data 只放数值，tooltip 用 dataIndex 回查 rows 取原始数据
      formatter: (params: Array<{ dataIndex: number }>) => {
        const c = rows[params[0]?.dataIndex ?? -1]
        if (!c) return ''
        return `<div style="font-weight:600">${c.country || 'Unknown'}</div>
          <div>请求 ${fmtNum(c.requests)}</div>
          <div>流量 ${fmtBytes(c.bytes)}</div>`
      },
    },
    grid: { left: 96, right: 24, top: 8, bottom: 24 },
    xAxis: {
      type: 'value',
      axisLabel: { color: colorMuted, fontSize: 11, formatter: (v: number) => fmtAxis(v) },
      splitLine: { lineStyle: { color: colorBorder, type: 'dashed' } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'category',
      data: rows.map((c) => c.country || 'Unknown'),
      axisLabel: { color: colorMuted, fontSize: 12 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: 'bar',
        data: rows.map((c) => c.requests),
        itemStyle: {
          color: colorPrimary,
          borderRadius: [0, 4, 4, 0],
        },
        emphasis: { disabled: true },
        barMaxWidth: 18,
      },
    ],
  }
})

const workerByDay = computed(() => {
  const map = new Map<string, { label: string; requests: number; errors: number }>()
  for (const r of workerRows.value) {
    const cur = map.get(r.label) ?? { label: r.label, requests: 0, errors: 0 }
    cur.requests += r.requests
    cur.errors += r.errors
    map.set(r.label, cur)
  }
  return [...map.values()]
})

const workerByScript = computed(() => {
  const map = new Map<string, { script: string; requests: number; errors: number }>()
  for (const r of workerRows.value) {
    const cur = map.get(r.script) ?? { script: r.script, requests: 0, errors: 0 }
    cur.requests += r.requests
    cur.errors += r.errors
    map.set(r.script, cur)
  }
  return [...map.values()].sort((a, b) => b.requests - a.requests).slice(0, 8)
})

const workerTrendOption = computed(() => {
  void themeVersion.value
  const colorPrimary = cssVar('--chart-1', '#5b8ff9')
  const colorErr = cssVar('--chart-2', '#f59e0b')
  const colorMuted = cssVar('--muted-foreground', '#999')
  const colorBorder = cssVar('--border', '#eee')
  const days = workerByDay.value
  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: cssVar('--popover', '#fff'),
      borderColor: colorBorder,
      textStyle: { color: cssVar('--popover-foreground', '#333'), fontSize: 12 },
      axisPointer: { type: 'line', triggerEmphasis: false },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const p = days[params[0]?.dataIndex ?? -1]
        if (!p) return ''
        return `<div style="font-weight:600">${p.label}</div>
          <div>调用 ${fmtNum(p.requests)}</div>
          <div>错误 ${fmtNum(p.errors)}</div>`
      },
    },
    legend: {
      data: ['调用', '错误'],
      textStyle: { color: colorMuted, fontSize: 11 },
      top: 0,
    },
    grid: { left: 48, right: 16, top: 28, bottom: 28 },
    xAxis: {
      type: 'category',
      data: days.map((p) => p.label),
      boundaryGap: false,
      axisLine: { lineStyle: { color: colorBorder } },
      axisLabel: { color: colorMuted, fontSize: 11, hideOverlap: true },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: colorMuted, fontSize: 11, formatter: (v: number) => fmtAxis(v) },
      splitLine: { lineStyle: { color: colorBorder, type: 'dashed' } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: '调用',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: days.map((p) => p.requests),
        lineStyle: { color: colorPrimary, width: 2 },
        itemStyle: { color: colorPrimary },
        emphasis: { disabled: true },
      },
      {
        name: '错误',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: days.map((p) => p.errors),
        lineStyle: { color: colorErr, width: 2 },
        itemStyle: { color: colorErr },
        emphasis: { disabled: true },
      },
    ],
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- 标题 + 控件 -->
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-3">
        <div class="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <BarChart3 class="size-5" />
        </div>
        <div>
          <h2 class="text-lg font-semibold tracking-tight">分析统计</h2>
          <p class="text-sm text-muted-foreground">
            Cloudflare GraphQL Analytics · zone HTTP 请求 + 账号 Workers 调用
          </p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Select v-model="selectedZoneId">
          <SelectTrigger class="w-[220px]">
            <SelectValue placeholder="选择域名" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="z in zones" :key="z.id" :value="z.id">
              {{ z.name }}
            </SelectItem>
          </SelectContent>
        </Select>

        <Select v-model="range">
          <SelectTrigger class="w-[160px]">
            <SelectValue placeholder="时间范围" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="r in ranges" :key="r.key" :value="r.key">
              {{ r.label }}
            </SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="sm"
          :disabled="loading || workerLoading"
          class="ml-auto"
          @click="() => { loadAnalytics(); loadWorkers() }"
        >
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading || workerLoading }" />
          刷新
        </Button>
      </div>
    </div>

    <!-- 域名加载 -->
    <div v-if="zonesLoading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <Skeleton v-for="i in 5" :key="i" class="h-24 rounded-xl" />
    </div>

    <!-- 域名列表加载失败（区别于「还没有域名」空态） -->
    <Card v-else-if="zonesError">
      <CardContent class="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <ShieldAlert class="size-8 text-destructive" />
        <div>
          <p class="text-sm font-medium">加载域名列表失败</p>
          <p class="mt-1 text-sm text-muted-foreground">{{ zonesError }}</p>
        </div>
        <Button variant="outline" size="sm" @click="loadZones">
          <RefreshCw class="size-4" />
          重试
        </Button>
      </CardContent>
    </Card>

    <!-- 无域名 -->
    <Card v-else-if="!zones.length">
      <CardContent class="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <Globe class="size-8 text-muted-foreground" />
        <p class="text-sm text-muted-foreground">
          还没有域名，无法查看分析数据。请先到
          <RouterLink to="/zones" class="text-primary hover:underline">域名管理</RouterLink>
          添加。
        </p>
      </CardContent>
    </Card>

    <template v-else-if="selectedZoneId">
      <!-- 汇总卡片 -->
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <template v-if="loading && !summary">
          <Skeleton v-for="i in 5" :key="i" class="h-24 rounded-xl" />
        </template>
        <template v-else>
          <div
            v-for="card in summaryCards"
            :key="card.label"
            class="rounded-xl border bg-card p-5 shadow-sm transition hover:border-primary/40"
          >
            <div class="flex items-center justify-between">
              <span class="text-sm text-muted-foreground">{{ card.label }}</span>
              <component :is="card.icon" class="size-4 text-muted-foreground" />
            </div>
            <div class="mt-2 text-2xl font-semibold">{{ card.value }}</div>
            <div class="mt-1 text-xs text-muted-foreground">{{ card.hint }}</div>
          </div>
        </template>
      </div>

      <!-- 错误 -->
      <Card v-if="errorMsg">
        <CardContent class="flex items-start gap-3 py-4 text-sm text-destructive">
          <ShieldAlert class="size-4 mt-0.5 shrink-0" />
          <div>
            <p class="font-medium">GraphQL 查询失败</p>
            <p class="mt-1 text-muted-foreground">{{ errorMsg }}</p>
            <p class="mt-1 text-xs text-muted-foreground">
              提示：API Token 需包含 <code class="rounded bg-muted px-1">Zone.Analytics</code> 读权限。
            </p>
          </div>
        </CardContent>
      </Card>

      <!-- 请求趋势图（ECharts） -->
      <Card>
        <CardHeader class="pb-2">
          <div class="flex items-center justify-between">
            <CardTitle class="text-base">请求趋势</CardTitle>
            <Badge variant="secondary">
              {{ points.length }} 个数据点 · 共 {{ fmtNum(totalRequestsTrend) }} 请求
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <VChart
            v-if="hasData"
            class="w-full"
            style="height: 288px"
            :option="trendOption"
            autoresize
          />
          <div
            v-else-if="loading"
            class="flex h-72 items-end gap-1"
          >
            <Skeleton v-for="i in 24" :key="i" class="flex-1" :style="{ height: `${20 + ((i * 7) % 60)}%` }" />
          </div>
          <div
            v-else
            class="flex h-72 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <BarChart3 class="size-8 opacity-40" />
            <p>该时间范围内没有请求数据</p>
            <p class="text-xs">尝试切换其他域名或扩大时间范围</p>
          </div>
        </CardContent>
      </Card>

      <!-- 流量来源 / 国家（ECharts） -->
      <Card>
        <CardHeader class="pb-2">
          <div class="flex items-center justify-between">
            <CardTitle class="text-base">流量来源 · Top 国家</CardTitle>
            <Badge v-if="countries.length" variant="secondary">
              {{ countries.length }} 个国家 · 最近 24h
            </Badge>
          </div>
          <p class="text-xs text-muted-foreground">
            国家分布走 Adaptive 明细集，免费 zone 时间范围上限 1 天，故仅取最近 24 小时
          </p>
        </CardHeader>
        <CardContent>
          <VChart
            v-if="countries.length"
            class="w-full"
            style="height: 320px"
            :option="countryOption"
            autoresize
          />
          <div v-else-if="loading" class="space-y-3">
            <Skeleton v-for="i in 6" :key="i" class="h-8 rounded" />
          </div>
          <div
            v-else
            class="flex h-80 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Globe class="size-8 opacity-40" />
            <p>暂无国家分布数据</p>
          </div>
        </CardContent>
      </Card>
    </template>

    <!-- Workers 调用（account 维度，不依赖 zone） -->
    <Card>
      <CardHeader class="pb-2">
        <div class="flex items-center justify-between gap-2">
          <CardTitle class="flex items-center gap-2 text-base">
            <Server class="size-4 text-primary" />
            Workers 调用
          </CardTitle>
          <Badge variant="secondary">
            {{ fmtNum(workerTotal) }} 次 · {{ workerByScript.length }} 个脚本
          </Badge>
        </div>
        <p class="text-xs text-muted-foreground">账号维度 GraphQL workersInvocationsAdaptive，与上方域名选择无关</p>
      </CardHeader>
      <CardContent class="space-y-4">
        <div v-if="workerError" class="text-sm text-destructive">
          {{ workerError }}
          <p class="mt-1 text-xs text-muted-foreground">API Token 需包含 Account Analytics 读权限。</p>
        </div>
        <VChart
          v-else-if="workerByDay.length"
          class="w-full"
          style="height: 240px"
          :option="workerTrendOption"
          autoresize
        />
        <div v-else-if="workerLoading" class="flex h-60 items-end gap-1">
          <Skeleton v-for="i in 16" :key="i" class="flex-1" :style="{ height: `${20 + ((i * 11) % 60)}%` }" />
        </div>
        <div v-else class="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <Server class="size-8 opacity-40" />
          <p>该时间范围内没有 Workers 调用</p>
        </div>
        <div v-if="workerByScript.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-xs text-muted-foreground">
                <th class="px-2 py-1.5 font-medium">脚本</th>
                <th class="px-2 py-1.5 text-right font-medium">调用</th>
                <th class="px-2 py-1.5 text-right font-medium">错误</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in workerByScript" :key="s.script" class="border-b last:border-0">
                <td class="truncate px-2 py-1.5 font-mono text-xs">{{ s.script }}</td>
                <td class="px-2 py-1.5 text-right tabular-nums">{{ fmtNum(s.requests) }}</td>
                <td class="px-2 py-1.5 text-right tabular-nums">{{ fmtNum(s.errors) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
