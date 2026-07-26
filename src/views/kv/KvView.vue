<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Plus, RefreshCw, Boxes, Trash2, Pencil, Eye, Search, KeyRound } from '@lucide/vue'
import { kvApi } from '@/api/kv'
import type { KVNamespace, KVKey } from '@/types/cloudflare'
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

/* ---------- 命名空间 ---------- */
const namespaces = ref<KVNamespace[]>([])
const nsLoading = ref(true)
const currentNs = ref<KVNamespace | null>(null)
const nsId = computed(() => currentNs.value?.id ?? '')

// 新建命名空间
const nsCreateOpen = ref(false)
const nsTitle = ref('')
const nsCreating = ref(false)

// 删除命名空间
const nsDeleteTarget = ref<KVNamespace | null>(null)
const nsDeleting = ref(false)

async function loadNamespaces() {
  nsLoading.value = true
  try {
    namespaces.value = await kvApi.listNamespaces()
    if (!currentNs.value && namespaces.value.length) {
      currentNs.value = namespaces.value[0]
    } else if (currentNs.value) {
      // 保留选中但同步最新对象
      const fresh = namespaces.value.find((n) => n.id === currentNs.value!.id)
      if (!fresh) currentNs.value = namespaces.value[0] ?? null
      else currentNs.value = fresh
    }
  } catch (e) {
    toast.error('加载命名空间失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    nsLoading.value = false
  }
}

function openNsCreate() {
  nsTitle.value = ''
  nsCreateOpen.value = true
}

async function submitNsCreate() {
  if (nsCreating.value) return // 防 Enter/连点重复提交
  const title = nsTitle.value.trim()
  if (!title) {
    toast.error('请填写命名空间名称')
    return
  }
  nsCreating.value = true
  try {
    const created = await kvApi.createNamespace(title)
    toast.success('命名空间已创建')
    nsCreateOpen.value = false
    await loadNamespaces()
    currentNs.value = created
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    nsCreating.value = false
  }
}

async function doDeleteNs() {
  if (nsDeleting.value) return // 防重复提交
  if (!nsDeleteTarget.value) return
  nsDeleting.value = true
  try {
    await kvApi.deleteNamespace(nsDeleteTarget.value.id)
    toast.success('命名空间已删除')
    if (currentNs.value?.id === nsDeleteTarget.value.id) {
      currentNs.value = null
    }
    nsDeleteTarget.value = null
    await loadNamespaces()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    nsDeleting.value = false
  }
}

/* ---------- keys ---------- */
const keys = ref<KVKey[]>([])
const keysLoading = ref(false)
const search = ref('')

const filteredKeys = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return keys.value
  return keys.value.filter((k) => k.name.toLowerCase().includes(q))
})

async function loadKeys() {
  if (!nsId.value) {
    keys.value = []
    return
  }
  keysLoading.value = true
  try {
    keys.value = await kvApi.listKeys(nsId.value)
  } catch (e) {
    toast.error('加载键列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    keysLoading.value = false
  }
}

watch(nsId, loadKeys)
onMounted(loadNamespaces)

/* ---------- 添加 / 编辑 key ---------- */
interface KeyFormState {
  open: boolean
  mode: 'create' | 'edit'
  originalName: string | null
  key: string
  value: string
  ttl: string
  loading: boolean
}

const form = ref<KeyFormState>({
  open: false,
  mode: 'create',
  originalName: null,
  key: '',
  value: '',
  ttl: '',
  loading: false,
})

const keyError = computed(() => {
  if (!form.value.key) return ''
  if (form.value.key.length > 512) return '键名过长'
  return ''
})

function openCreateKey() {
  if (!currentNs.value) return
  form.value = {
    open: true,
    mode: 'create',
    originalName: null,
    key: '',
    value: '',
    ttl: '',
    loading: false,
  }
}

// getValue 请求序号守卫：连续打开不同键的编辑/查看时，丢弃旧请求迟到的响应
let valueSeq = 0

async function openEditKey(k: KVKey) {
  if (!currentNs.value) return
  const seq = ++valueSeq
  form.value = {
    open: true,
    mode: 'edit',
    originalName: k.name,
    key: k.name,
    value: '',
    ttl: '',
    loading: false,
  }
  try {
    const v = await kvApi.getValue(currentNs.value.id, k.name)
    if (seq !== valueSeq) return
    form.value.value = v
  } catch (e) {
    if (seq !== valueSeq) return
    toast.error('读取值失败', { description: e instanceof Error ? e.message : String(e) })
    form.value.open = false
  }
}

async function submitKeyForm() {
  if (form.value.loading) return // 防 Enter/连点重复提交
  if (!currentNs.value) return
  if (keyError.value) {
    toast.error(keyError.value)
    return
  }
  if (!form.value.key.trim()) {
    toast.error('请填写键名')
    return
  }
  const ttlNum = form.value.ttl ? Number(form.value.ttl) : undefined
  if (ttlNum !== undefined && (!Number.isInteger(ttlNum) || ttlNum < 60)) {
    toast.error('TTL 必须为不小于 60 的整数')
    return
  }
  form.value.loading = true
  try {
    await kvApi.putValue(currentNs.value.id, form.value.key.trim(), form.value.value, ttlNum)
    toast.success(form.value.mode === 'create' ? '键已创建' : '键已更新')
    form.value.open = false
    await loadKeys()
  } catch (e) {
    toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    form.value.loading = false
  }
}

/* ---------- 查看值 ---------- */
const viewer = ref<{
  open: boolean
  loading: boolean
  key: string
  value: string
  mode: 'text' | 'json'
}>({
  open: false,
  loading: false,
  key: '',
  value: '',
  mode: 'text',
})

const viewerDisplay = computed(() => {
  if (viewer.value.mode === 'json') {
    try {
      return JSON.stringify(JSON.parse(viewer.value.value), null, 2)
    } catch {
      return viewer.value.value
    }
  }
  return viewer.value.value
})

async function openViewer(k: KVKey) {
  if (!currentNs.value) return
  const seq = ++valueSeq
  viewer.value = {
    open: true,
    loading: true,
    key: k.name,
    value: '',
    mode: 'text',
  }
  try {
    const v = await kvApi.getValue(currentNs.value.id, k.name)
    if (seq !== valueSeq) return
    viewer.value.value = v
    // 尝试自动 json 检测
    try {
      JSON.parse(v)
      viewer.value.mode = 'json'
    } catch {
      viewer.value.mode = 'text'
    }
  } catch (e) {
    if (seq !== valueSeq) return
    toast.error('读取值失败', { description: e instanceof Error ? e.message : String(e) })
    viewer.value.open = false
  } finally {
    if (seq === valueSeq) viewer.value.loading = false
  }
}

/* ---------- 删除 key ---------- */
const deleteKeyTarget = ref<KVKey | null>(null)
const deletingKey = ref(false)

async function doDeleteKey() {
  if (deletingKey.value) return // 防重复提交
  if (!currentNs.value || !deleteKeyTarget.value) return
  deletingKey.value = true
  try {
    await kvApi.deleteKey(currentNs.value.id, deleteKeyTarget.value.name)
    toast.success('键已删除')
    deleteKeyTarget.value = null
    await loadKeys()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingKey.value = false
  }
}

/* ---------- 格式化 ---------- */
function fmtExp(ts?: number): string {
  if (!ts) return '永久'
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(ts)
  }
}

async function refreshAll() {
  await loadNamespaces()
  // nsId 未变化时 watch 不会触发，这里显式刷新键列表
  await loadKeys()
}

function copyValue() {
  navigator.clipboard.writeText(viewer.value.value)
  toast.success('已复制到剪贴板')
}
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部操作 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">KV 存储</h1>
        <p class="text-sm text-muted-foreground">管理 Cloudflare Workers KV 命名空间与键值</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="nsLoading || keysLoading" @click="refreshAll">
          <RefreshCw class="size-4" :class="{ 'animate-spin': nsLoading }" />
          刷新
        </Button>
        <Button size="sm" :disabled="!currentNs" @click="openCreateKey">
          <Plus class="size-4" />
          新建键
        </Button>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-[280px_1fr]">
      <!-- 左侧：命名空间 -->
      <Card class="h-fit">
        <CardHeader class="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle class="text-sm font-medium">命名空间</CardTitle>
          <Button variant="ghost" size="icon-sm" @click="openNsCreate">
            <Plus class="size-4" />
          </Button>
        </CardHeader>
        <Separator />
        <CardContent class="p-2">
          <div v-if="nsLoading" class="space-y-2 p-2">
            <Skeleton v-for="i in 4" :key="i" class="h-9 w-full" />
          </div>
          <div v-else-if="!namespaces.length" class="px-3 py-8 text-center text-sm text-muted-foreground">
            <Boxes class="mx-auto mb-2 size-6 opacity-50" />
            暂无命名空间
            <div class="mt-3">
              <Button size="sm" variant="outline" @click="openNsCreate">
                <Plus class="size-4" /> 新建
              </Button>
            </div>
          </div>
          <ScrollArea v-else class="h-[60vh] pr-2">
            <div class="space-y-1 px-1">
              <button
                v-for="ns in namespaces"
                :key="ns.id"
                type="button"
                class="group flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition hover:bg-accent"
                :class="currentNs?.id === ns.id ? 'bg-accent' : ''"
                @click="currentNs = ns"
              >
                <span class="flex min-w-0 flex-1 items-center gap-2">
                  <KeyRound class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate font-mono">{{ ns.title }}</span>
                </span>
                <Trash2
                  class="size-3.5 shrink-0 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                  @click.stop="nsDeleteTarget = ns"
                />
              </button>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <!-- 右侧：键列表 -->
      <Card>
        <CardHeader class="space-y-3 pb-3">
          <div class="flex items-center justify-between gap-2">
            <CardTitle class="text-base">
              {{ currentNs ? currentNs.title : '请选择命名空间' }}
            </CardTitle>
            <Badge v-if="currentNs" variant="secondary" class="font-mono text-xs">
              {{ currentNs.id }}
            </Badge>
          </div>
          <div class="relative">
            <Search class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              v-model="search"
              placeholder="搜索键名…"
              class="pl-8"
              :disabled="!currentNs"
            />
          </div>
        </CardHeader>
        <Separator />
        <CardContent class="p-0">
          <!-- 未选择命名空间 -->
          <div v-if="!currentNs" class="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Boxes class="size-6" />
            </div>
            <div class="font-medium">请选择一个命名空间</div>
            <p class="text-sm text-muted-foreground">在左侧选择或新建命名空间以查看其键值</p>
          </div>

          <!-- 加载骨架 -->
          <div v-else-if="keysLoading" class="space-y-2 p-4">
            <Skeleton v-for="i in 5" :key="i" class="h-10 w-full" />
          </div>

          <!-- 空状态 -->
          <div v-else-if="!filteredKeys.length" class="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <KeyRound class="size-6" />
            </div>
            <div class="font-medium">
              {{ search ? '没有匹配的键' : '此命名空间下暂无键' }}
            </div>
            <Button v-if="!search" size="sm" @click="openCreateKey">
              <Plus class="size-4" /> 新建键
            </Button>
          </div>

          <!-- 列表 -->
          <ScrollArea v-else class="h-[60vh]">
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-background text-xs text-muted-foreground">
                <tr class="border-b">
                  <th class="px-4 py-2.5 text-left font-medium">键名</th>
                  <th class="px-4 py-2.5 text-left font-medium">过期时间</th>
                  <th class="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="k in filteredKeys"
                  :key="k.name"
                  class="group border-b last:border-0 transition hover:bg-accent/50"
                >
                  <td class="max-w-0 px-4 py-2.5">
                    <span class="block truncate font-mono text-xs">{{ k.name }}</span>
                  </td>
                  <td class="px-4 py-2.5 text-xs text-muted-foreground">
                    {{ fmtExp(k.expiration) }}
                  </td>
                  <td class="px-4 py-2.5">
                    <div class="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" @click="openViewer(k)">
                        <Eye class="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" @click="openEditKey(k)">
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        class="text-muted-foreground hover:text-destructive"
                        @click="deleteKeyTarget = k"
                      >
                        <Trash2 class="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>

    <!-- 新建命名空间 -->
    <Dialog v-model:open="nsCreateOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建命名空间</DialogTitle>
          <DialogDescription>命名空间是 KV 键值对的容器，名称仅用于展示。</DialogDescription>
        </DialogHeader>
        <div class="space-y-1.5">
          <Label for="ns-title">名称</Label>
          <Input
            id="ns-title"
            v-model="nsTitle"
            placeholder="my-kv"
            class="font-mono"
            autocomplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="nsCreateOpen = false">取消</Button>
          <Button :disabled="nsCreating || !nsTitle.trim()" @click="submitNsCreate">
            {{ nsCreating ? '创建中…' : '创建' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除命名空间确认 -->
    <Dialog :open="!!nsDeleteTarget" @update:open="(v) => !v && (nsDeleteTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除命名空间</DialogTitle>
          <DialogDescription>
            确定删除命名空间 <code class="rounded bg-muted px-1 font-mono">{{ nsDeleteTarget?.title }}</code>？该操作不可撤销，其下所有键值将被永久删除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="nsDeleteTarget = null">取消</Button>
          <Button variant="destructive" :disabled="nsDeleting" @click="doDeleteNs">
            {{ nsDeleting ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 添加 / 编辑 键 -->
    <Dialog v-model:open="form.open">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ form.mode === 'create' ? '新建键' : '编辑键' }}</DialogTitle>
          <DialogDescription>
            {{ form.mode === 'create'
              ? '向当前命名空间写入一个键值对'
              : '修改键的值。注意：修改值会重置其过期时间（如需保留 TTL 请重新填写）。' }}
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label for="kv-key">键名</Label>
            <Input
              id="kv-key"
              v-model="form.key"
              :disabled="form.mode === 'edit'"
              placeholder="my-key"
              class="font-mono"
              autocomplete="off"
            />
            <p class="text-xs" :class="keyError ? 'text-destructive' : 'text-muted-foreground'">
              {{ keyError || '最长 512 字符，支持任意可打印字符' }}
            </p>
          </div>
          <div class="space-y-1.5">
            <Label for="kv-value">值</Label>
            <Textarea
              id="kv-value"
              v-model="form.value"
              class="min-h-48 font-mono text-xs"
              placeholder="可存放任意文本，如配置、JSON、HTML 片段等"
            />
          </div>
          <div class="space-y-1.5">
            <Label for="kv-ttl">过期时间（秒，可选）</Label>
            <Input
              id="kv-ttl"
              v-model="form.ttl"
              type="number"
              placeholder="留空表示永久"
              autocomplete="off"
            />
            <p class="text-xs text-muted-foreground">不小于 60 的整数，留空表示永久保留</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="form.open = false">取消</Button>
          <Button :disabled="form.loading || !!keyError || !form.key.trim()" @click="submitKeyForm">
            {{ form.loading ? '保存中…' : '保存' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 查看值 -->
    <Dialog v-model:open="viewer.open">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>查看键值</DialogTitle>
          <DialogDescription>
            键：<code class="rounded bg-muted px-1 font-mono">{{ viewer.key }}</code>
          </DialogDescription>
        </DialogHeader>
        <div class="flex items-center justify-between">
          <Select v-model="viewer.mode">
            <SelectTrigger class="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">纯文本</SelectItem>
              <SelectItem value="json">JSON</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            :disabled="!viewer.value"
            @click="copyValue"
          >
            复制
          </Button>
        </div>
        <Textarea
          :model-value="viewerDisplay"
          readonly
          class="min-h-64 max-h-[50vh] font-mono text-xs"
          :placeholder="viewer.loading ? '加载中…' : ''"
        />
        <DialogFooter>
          <Button variant="outline" @click="viewer.open = false">关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除键确认 -->
    <Dialog :open="!!deleteKeyTarget" @update:open="(v) => !v && (deleteKeyTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除键</DialogTitle>
          <DialogDescription>
            确定删除键 <code class="rounded bg-muted px-1 font-mono">{{ deleteKeyTarget?.name }}</code>？该操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteKeyTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deletingKey" @click="doDeleteKey">
            {{ deletingKey ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
