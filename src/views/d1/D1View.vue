<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  Database,
  Plus,
  RefreshCw,
  Trash2,
  Play,
  Table2,
  Terminal,
  AlertTriangle,
  Columns3,
} from '@lucide/vue'
import { d1Api } from '@/api/d1'
import type { D1Database, D1QueryResult } from '@/types/cloudflare'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/* ---------- 数据库列表 ---------- */

const databases = ref<D1Database[]>([])
const loading = ref(true)
const selected = ref<D1Database | null>(null)

const createOpen = ref(false)
const createName = ref('')
const creating = ref(false)
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const nameError = computed(() => {
  if (!createName.value) return ''
  if (!NAME_RE.test(createName.value)) return '以字母开头，仅含字母、数字、下划线、连字符'
  return ''
})

const deleteTarget = ref<D1Database | null>(null)
const deleting = ref(false)

async function load() {
  loading.value = true
  try {
    databases.value = await d1Api.listDatabases()
  } catch (e) {
    toast.error('加载 D1 数据库列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate() {
  createName.value = ''
  createOpen.value = true
}

async function submitCreate() {
  if (!createName.value || nameError.value) {
    toast.error('数据库名不合法')
    return
  }
  creating.value = true
  try {
    await d1Api.createDatabase(createName.value)
    toast.success('D1 数据库创建成功')
    createOpen.value = false
    await load()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creating.value = false
  }
}

function confirmDelete(db: D1Database) {
  deleteTarget.value = db
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await d1Api.deleteDatabase(deleteTarget.value.uuid)
    if (selected.value?.uuid === deleteTarget.value.uuid) selected.value = null
    toast.success('已删除')
    deleteTarget.value = null
    await load()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

function selectDb(db: D1Database) {
  selected.value = db
}

function fmtSize(bytes: number): string {
  if (!bytes) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}

/* ---------- SQL 控制台 ---------- */

const tables = ref<string[]>([])
const tablesLoading = ref(false)
const tableSel = ref<string>('')
const tableCols = ref<Record<string, unknown>[]>([])
const colsLoading = ref(false)

const sql = ref<string>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
const paramsText = ref<string>('')
const running = ref(false)
const results = ref<D1QueryResult[]>([])
const activeResult = ref<string>('0')
const error = ref<string>('')
const ranAt = ref<string>('')

// 危险语句二次确认
const DANGER_RE = /(^|[\s;])(DROP|DELETE|TRUNCATE)\b/i
const confirmSqlOpen = ref(false)

async function loadTables() {
  if (!selected.value) return
  tablesLoading.value = true
  try {
    tables.value = await d1Api.listTables(selected.value.uuid)
  } catch (e) {
    toast.error('加载表列表失败', { description: e instanceof Error ? e.message : String(e) })
    tables.value = []
  } finally {
    tablesLoading.value = false
  }
}

watch(selected, (db) => {
  tables.value = []
  tableSel.value = ''
  tableCols.value = []
  results.value = []
  error.value = ''
  ranAt.value = ''
  if (db) loadTables()
})

async function onTableChange(name: string) {
  tableSel.value = name
  if (!selected.value || !name) return
  // 点击表名：插入常用查询到 SQL 编辑器
  sql.value = `SELECT * FROM ${quoteIdent(name)} LIMIT 100;`
  // 同时加载表结构
  colsLoading.value = true
  try {
    tableCols.value = await d1Api.tableInfo(selected.value.uuid, name)
  } catch (e) {
    toast.error('加载表结构失败', { description: e instanceof Error ? e.message : String(e) })
    tableCols.value = []
  } finally {
    colsLoading.value = false
  }
}

function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

function insertSql(snippet: string) {
  sql.value = snippet
}

const QUICK_SQL: { label: string; sql: string }[] = [
  { label: '查看所有表', sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" },
  { label: 'SELECT * LIMIT 100', sql: 'SELECT * FROM <table> LIMIT 100;' },
  {
    label: '建表模板',
    sql: 'CREATE TABLE IF NOT EXISTS sample (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  created_at TEXT DEFAULT CURRENT_TIMESTAMP\n);',
  },
  { label: '清空', sql: '' },
]

function parseParams(): unknown[] | undefined {
  const raw = paramsText.value.trim()
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) throw new Error('params 必须是 JSON 数组')
    return v as unknown[]
  } catch {
    throw new Error('params 不是合法的 JSON 数组')
  }
}

async function runQuery(confirmed = false) {
  if (running.value) return // 防重复执行
  if (!selected.value) return
  const code = sql.value.trim()
  if (!code) {
    toast.error('SQL 不能为空')
    return
  }
  let params: unknown[] | undefined
  try {
    params = parseParams()
  } catch (e) {
    toast.error('参数解析失败', { description: e instanceof Error ? e.message : String(e) })
    return
  }
  // 危险语句二次确认：未确认时只弹窗，由确认按钮以 confirmed=true 重入
  if (DANGER_RE.test(code) && !confirmed) {
    confirmSqlOpen.value = true
    return
  }
  confirmSqlOpen.value = false
  running.value = true
  error.value = ''
  results.value = []
  try {
    const rs = (await d1Api.query(selected.value.uuid, code, params)) ?? []
    results.value = rs
    activeResult.value = '0'
    ranAt.value = new Date().toLocaleString('zh-CN', { hour12: false })
    const ok = rs.filter((r) => r.success).length
    toast.success(`执行完成，共 ${rs.length} 个结果集，成功 ${ok} 个`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    toast.error('查询失败', { description: error.value })
  } finally {
    running.value = false
  }
}

/** SQL 编辑器快捷键：确认弹窗打开时忽略，避免绕过二次确认 */
function onSqlShortcut() {
  if (confirmSqlOpen.value) return
  runQuery()
}

function resultColumns(r: D1QueryResult): string[] {
  const keys = new Set<string>()
  for (const row of r.results ?? []) {
    for (const k of Object.keys(row)) keys.add(k)
  }
  return [...keys]
}

function metaSummary(r: D1QueryResult): string {
  const m = (r.meta ?? {}) as Record<string, unknown>
  const parts: string[] = []
  if (typeof m.changes === 'number') parts.push(`影响 ${m.changes} 行`)
  if (typeof m.duration === 'number') parts.push(`${m.duration} ms`)
  if (typeof m.rows_read === 'number') parts.push(`扫描 ${m.rows_read} 行`)
  if (typeof m.rows_written === 'number') parts.push(`写入 ${m.rows_written} 行`)
  if (typeof m.last_row_id === 'number') parts.push(`last_row_id=${m.last_row_id}`)
  return parts.join(' · ')
}

function displayVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部操作 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">D1 数据库</h1>
        <p class="text-sm text-muted-foreground">管理 Cloudflare D1 SQLite 数据库，内置 SQL 控制台</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
        <Button size="sm" @click="openCreate">
          <Plus class="size-4" />
          新建数据库
        </Button>
      </div>
    </div>

    <!-- 主体：左列表 + 右控制台 -->
    <div class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <!-- 左：数据库列表 -->
      <Card class="h-fit">
        <CardHeader class="pb-3">
          <CardTitle class="flex items-center gap-2 text-sm">
            <Database class="size-4" />
            数据库列表
            <Badge variant="secondary" class="ml-auto">{{ databases.length }}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent class="pt-0">
          <div v-if="loading" class="space-y-2">
            <Skeleton v-for="i in 4" :key="i" class="h-16 rounded-lg" />
          </div>
          <div v-else-if="!databases.length" class="py-10 text-center text-sm text-muted-foreground">
            <Database class="mx-auto mb-2 size-6 opacity-40" />
            暂无数据库
            <div class="mt-3">
              <Button size="sm" variant="outline" @click="openCreate">
                <Plus class="size-4" />
                新建
              </Button>
            </div>
          </div>
          <ScrollArea v-else class="max-h-[70vh]">
            <div class="space-y-1.5 pr-2">
              <button
                v-for="db in databases"
                :key="db.uuid"
                type="button"
                class="group flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition hover:border-primary/40 hover:bg-accent/40"
                :class="selected?.uuid === db.uuid ? 'border-primary bg-accent/60' : 'border-transparent'"
                @click="selectDb(db)"
              >
                <div class="flex items-center gap-2">
                  <Database class="size-4 shrink-0 text-muted-foreground" />
                  <span class="truncate font-mono text-sm font-medium">{{ db.name }}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="ml-auto text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                    @click.stop="confirmDelete(db)"
                  >
                    <Trash2 class="size-4" />
                  </Button>
                </div>
                <div class="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
                  <Badge variant="outline" class="font-mono">{{ fmtSize(db.file_size) }}</Badge>
                  <span class="truncate">{{ fmtDate(db.created_at) }}</span>
                </div>
              </button>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <!-- 右：SQL 控制台 -->
      <Card v-if="!selected" class="border-dashed">
        <CardContent class="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Terminal class="size-6" />
          </div>
          <div class="font-medium">选择左侧数据库以打开 SQL 控制台</div>
          <p class="text-sm text-muted-foreground">支持多语句执行、表结构查看、参数绑定</p>
        </CardContent>
      </Card>

      <div v-else class="space-y-4">
        <!-- 表选择 + 结构 -->
        <Card>
          <CardHeader class="pb-3">
            <CardTitle class="flex flex-wrap items-center gap-2 text-sm">
              <Table2 class="size-4" />
              <span class="font-mono">{{ selected.name }}</span>
              <Badge variant="secondary" class="font-mono">{{ selected.uuid.slice(0, 8) }}</Badge>
              <Separator orientation="vertical" class="mx-1 h-4" />
              <span class="text-xs text-muted-foreground">表 ({{ tables.length }})</span>
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 pt-0">
            <div class="flex flex-wrap items-center gap-2">
              <Select
                :model-value="tableSel"
                :disabled="tablesLoading"
                @update:model-value="(v) => v && onTableChange(String(v))"
              >
                <SelectTrigger class="w-64">
                  <SelectValue :placeholder="tablesLoading ? '加载中…' : '选择表名'" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-if="!tables.length" value="__none__" disabled>无表</SelectItem>
                  <SelectItem v-for="t in tables" :key="t" :value="t" class="font-mono">{{ t }}</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" :disabled="!tables.length" @click="loadTables">
                <RefreshCw class="size-4" :class="{ 'animate-spin': tablesLoading }" />
                刷新表
              </Button>
            </div>

            <!-- 表结构 -->
            <div v-if="colsLoading" class="space-y-1.5">
              <Skeleton class="h-6 w-full" />
              <Skeleton class="h-6 w-full" />
              <Skeleton class="h-6 w-3/4" />
            </div>
            <div
              v-else-if="tableSel && tableCols.length"
              class="overflow-hidden rounded-md border"
            >
              <div class="flex items-center gap-1.5 border-b bg-muted/50 px-3 py-1.5 text-xs font-medium">
                <Columns3 class="size-3.5" />
                表结构 · {{ tableSel }}
              </div>
              <div class="max-h-56 overflow-auto">
                <table class="w-full text-xs">
                  <thead class="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr class="text-left">
                      <th class="px-3 py-1.5 font-medium">#</th>
                      <th class="px-3 py-1.5 font-medium">列名</th>
                      <th class="px-3 py-1.5 font-medium">类型</th>
                      <th class="px-3 py-1.5 font-medium">非空</th>
                      <th class="px-3 py-1.5 font-medium">默认值</th>
                      <th class="px-3 py-1.5 font-medium">主键</th>
                    </tr>
                  </thead>
                  <tbody class="font-mono">
                    <tr
                      v-for="(col, idx) in tableCols"
                      :key="idx"
                      class="border-t hover:bg-accent/30"
                    >
                      <td class="px-3 py-1.5 text-muted-foreground">{{ col.cid }}</td>
                      <td class="px-3 py-1.5">{{ col.name }}</td>
                      <td class="px-3 py-1.5 text-muted-foreground">{{ col.type || '-' }}</td>
                      <td class="px-3 py-1.5">
                        <Badge :variant="col.notnull ? 'secondary' : 'outline'" class="text-[10px]">
                          {{ col.notnull ? 'NOT NULL' : 'NULL' }}
                        </Badge>
                      </td>
                      <td class="px-3 py-1.5 text-muted-foreground">{{ col.dflt_value ?? '-' }}</td>
                      <td class="px-3 py-1.5">
                        <Badge v-if="col.pk" variant="default" class="text-[10px]">PK</Badge>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- SQL 编辑器 -->
        <Card>
          <CardHeader class="pb-3">
            <CardTitle class="flex items-center gap-2 text-sm">
              <Terminal class="size-4" />
              SQL 控制台
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3 pt-0">
            <!-- 快捷 SQL -->
            <div class="flex flex-wrap items-center gap-1.5">
              <Button
                v-for="q in QUICK_SQL"
                :key="q.label"
                variant="outline"
                size="sm"
                @click="insertSql(q.sql)"
              >
                {{ q.label }}
              </Button>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs text-muted-foreground">SQL 语句（支持 `;` 分隔的多语句）</Label>
              <Textarea
                v-model="sql"
                class="min-h-40 font-mono text-xs leading-relaxed"
                spellcheck="false"
                placeholder="SELECT * FROM your_table LIMIT 100;"
                @keydown.meta.enter.prevent="onSqlShortcut"
                @keydown.ctrl.enter.prevent="onSqlShortcut"
              />
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs text-muted-foreground">
                绑定参数（可选，JSON 数组，对应 SQL 中的 <code class="font-mono">?</code>）
              </Label>
              <Input
                v-model="paramsText"
                class="font-mono text-xs"
                spellcheck="false"
                placeholder='例如：["foo", 42]'
              />
            </div>

            <div class="flex items-center gap-2">
              <Button :disabled="running" @click="runQuery()">
                <Play class="size-4" />
                {{ running ? '执行中…' : '执行' }}
              </Button>
              <Badge v-if="ranAt" variant="outline" class="ml-auto text-[10px]">
                {{ ranAt }}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <!-- 结果 -->
        <Card>
          <CardHeader class="pb-3">
            <CardTitle class="flex items-center gap-2 text-sm">
              <Table2 class="size-4" />
              查询结果
              <Badge v-if="results.length" variant="secondary" class="ml-1">
                {{ results.length }} 个结果集
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent class="pt-0">
            <!-- 错误 -->
            <div
              v-if="error"
              class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertTriangle class="mt-0.5 size-4 shrink-0" />
              <div>
                <div class="font-medium">执行出错</div>
                <pre class="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{{ error }}</pre>
              </div>
            </div>

            <!-- 空状态 -->
            <div
              v-else-if="!results.length"
              class="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground"
            >
              <Table2 class="size-6 opacity-40" />
              执行查询后将在此显示结果
            </div>

            <!-- 多结果集切换 -->
            <Tabs v-else v-model="activeResult" class="gap-2">
              <TabsList v-if="results.length > 1" class="w-full justify-start overflow-x-auto">
                <TabsTrigger
                  v-for="(r, idx) in results"
                  :key="idx"
                  :value="String(idx)"
                  class="gap-1"
                >
                  <span>#{{ idx + 1 }}</span>
                  <Badge
                    :variant="r.success ? 'secondary' : 'destructive'"
                    class="text-[10px]"
                  >
                    {{ r.success ? 'OK' : 'FAIL' }}
                  </Badge>
                </TabsTrigger>
              </TabsList>

              <TabsContent
                v-for="(r, idx) in results"
                :key="idx"
                :value="String(idx)"
              >
                <div class="space-y-2">
                  <!-- 该结果集失败 -->
                  <div
                    v-if="!r.success"
                    class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                  >
                    <AlertTriangle class="mt-0.5 size-4 shrink-0" />
                    <pre class="whitespace-pre-wrap break-all font-mono text-xs">
{{ ((r.meta ?? {}) as Record<string, unknown>).errors ?? '该语句执行失败' }}</pre>
                  </div>

                  <template v-else>
                    <!-- 元信息 -->
                    <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">影响：{{ r.results?.length ?? 0 }} 行</Badge>
                      <span v-if="metaSummary(r)">{{ metaSummary(r) }}</span>
                    </div>

                    <!-- 结果表 -->
                    <div v-if="r.results?.length" class="overflow-hidden rounded-md border">
                      <ScrollArea class="max-h-[50vh]">
                        <table class="w-full text-xs">
                          <thead class="sticky top-0 z-10 bg-muted/80 backdrop-blur">
                            <tr class="text-left">
                              <th class="px-2 py-1.5 font-medium text-muted-foreground">#</th>
                              <th
                                v-for="col in resultColumns(r)"
                                :key="col"
                                class="px-3 py-1.5 font-medium"
                              >
                                {{ col }}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr
                              v-for="(row, ri) in r.results"
                              :key="ri"
                              class="border-t hover:bg-accent/30"
                            >
                              <td class="px-2 py-1.5 text-muted-foreground">{{ ri + 1 }}</td>
                              <td
                                v-for="col in resultColumns(r)"
                                :key="col"
                                class="px-3 py-1.5 font-mono"
                              >
                                {{ displayVal(row[col]) }}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </ScrollArea>
                    </div>
                    <div v-else class="rounded-md border border-dashed py-8 text-center text-xs text-muted-foreground">
                      无返回行（{{ metaSummary(r) || '执行成功' }}）
                    </div>
                  </template>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- 新建数据库对话框 -->
    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建 D1 数据库</DialogTitle>
          <DialogDescription>数据库名在账号下需唯一，创建后即可使用 SQL 控制台。</DialogDescription>
        </DialogHeader>
        <div class="space-y-1.5">
          <Label for="d1-name">数据库名</Label>
          <Input
            id="d1-name"
            v-model="createName"
            placeholder="my-database"
            class="font-mono"
            autocomplete="off"
          />
          <p class="text-xs" :class="nameError ? 'text-destructive' : 'text-muted-foreground'">
            {{ nameError || '以字母开头，仅含字母、数字、下划线、连字符' }}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createOpen = false">取消</Button>
          <Button :disabled="creating || !!nameError || !createName" @click="submitCreate">
            {{ creating ? '创建中…' : '创建' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除确认 -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => !v && (deleteTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 D1 数据库</DialogTitle>
          <DialogDescription>
            确定删除数据库 <code class="rounded bg-muted px-1 font-mono">{{ deleteTarget?.name }}</code>？该操作不可撤销，所有数据将被永久删除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deleting" @click="doDelete">
            {{ deleting ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 危险 SQL 二次确认 -->
    <Dialog v-model:open="confirmSqlOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>危险操作确认</DialogTitle>
          <DialogDescription>
            检测到 DROP / DELETE / TRUNCATE 等可能破坏数据的语句，确认要继续执行吗？
          </DialogDescription>
        </DialogHeader>
        <div class="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3">
          <pre class="whitespace-pre-wrap break-all font-mono text-xs">{{ sql }}</pre>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="confirmSqlOpen = false">取消</Button>
          <Button variant="destructive" :disabled="running" @click="runQuery(true)">
            {{ running ? '执行中…' : '确认执行' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
