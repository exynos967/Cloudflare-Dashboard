<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Plus, RefreshCw, Server, Trash2, Pencil } from '@lucide/vue'
import { workersApi, type WorkerScriptMeta } from '@/api/workers'
import {
  Button,
} from '@/components/ui/button'
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
import WorkerEditor from './WorkerEditor.vue'

const DEFAULT_TEMPLATE = `export default {
  async fetch(request, env, ctx) {
    return new Response("Hello World!")
  },
}
`

// CF 规则：小写字母/数字/连字符，不以连字符结尾（workers.dev 场景下最长 63 字符）
const NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/

const scripts = ref<WorkerScriptMeta[]>([])
const loading = ref(true)

// 新建 Worker
const createOpen = ref(false)
const createName = ref('')
const createCode = ref(DEFAULT_TEMPLATE)
const creating = ref(false)
const nameError = computed(() => {
  if (!createName.value) return ''
  if (createName.value.length > 63) return '最长 63 个字符'
  if (!NAME_RE.test(createName.value)) return '仅支持小写字母、数字、连字符，须以字母开头且不能以连字符结尾'
  return ''
})

// 编辑
const editorOpen = ref(false)
const editingName = ref<string | null>(null)

// 删除确认
const deleteTarget = ref<WorkerScriptMeta | null>(null)
const deleting = ref(false)

async function load() {
  loading.value = true
  try {
    scripts.value = await workersApi.listScripts()
  } catch (e) {
    toast.error('加载 Worker 列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate() {
  createName.value = ''
  createCode.value = DEFAULT_TEMPLATE
  createOpen.value = true
}

async function submitCreate() {
  if (!createName.value || nameError.value) {
    toast.error('脚本名不合法')
    return
  }
  if (!createCode.value.trim()) {
    toast.error('代码不能为空')
    return
  }
  creating.value = true
  try {
    await workersApi.uploadScript(createName.value, createCode.value)
    toast.success('Worker 创建成功')
    createOpen.value = false
    await load()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creating.value = false
  }
}

function openEditor(name: string) {
  editingName.value = name
  editorOpen.value = true
}

function confirmDelete(s: WorkerScriptMeta) {
  deleteTarget.value = s
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await workersApi.deleteScript(deleteTarget.value.id)
    toast.success('已删除')
    deleteTarget.value = null
    await load()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部操作 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">Workers</h1>
        <p class="text-sm text-muted-foreground">管理 Cloudflare Workers 脚本、路由、自定义域与 workers.dev 子域</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
        <Button size="sm" @click="openCreate">
          <Plus class="size-4" />
          新建 Worker
        </Button>
      </div>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Skeleton v-for="i in 6" :key="i" class="h-28 rounded-xl" />
    </div>

    <!-- 空状态 -->
    <Card v-else-if="!scripts.length" class="border-dashed">
      <CardContent class="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Server class="size-6" />
        </div>
        <div class="font-medium">还没有 Worker 脚本</div>
        <p class="text-sm text-muted-foreground">新建第一个 Worker，开始部署边缘计算脚本</p>
        <Button size="sm" @click="openCreate">
          <Plus class="size-4" />
          新建 Worker
        </Button>
      </CardContent>
    </Card>

    <!-- 列表 -->
    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card
        v-for="s in scripts"
        :key="s.id"
        class="group cursor-pointer transition hover:shadow-md hover:border-primary/40"
        @click="openEditor(s.id)"
      >
        <CardHeader class="pb-3">
          <div class="flex items-start justify-between gap-2">
            <CardTitle class="truncate font-mono text-base">{{ s.id }}</CardTitle>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
              @click.stop="confirmDelete(s)"
            >
              <Trash2 class="size-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent class="space-y-3 pt-0 text-xs text-muted-foreground">
          <div class="flex flex-wrap items-center gap-1.5">
            <Badge v-if="s.usage_model" variant="secondary">{{ s.usage_model }}</Badge>
            <Badge
              v-for="h in s.handlers"
              :key="h"
              variant="outline"
              class="font-mono"
            >{{ h }}</Badge>
          </div>
          <div class="flex items-center justify-between">
            <span>更新于 {{ fmtDate(s.modified_on) }}</span>
            <span class="inline-flex items-center gap-1 text-primary opacity-0 transition group-hover:opacity-100">
              <Pencil class="size-3" /> 编辑
            </span>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- 新建对话框 -->
    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建 Worker</DialogTitle>
          <DialogDescription>填写脚本名与初始代码，提交后将立即部署到 Cloudflare 边缘网络。</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label for="worker-name">脚本名</Label>
            <Input
              id="worker-name"
              v-model="createName"
              placeholder="my-worker"
              class="font-mono"
              autocomplete="off"
            />
            <p class="text-xs" :class="nameError ? 'text-destructive' : 'text-muted-foreground'">
              {{ nameError || '小写字母开头，仅含小写字母、数字、连字符，不以连字符结尾，最长 63 字符' }}
            </p>
          </div>
          <div class="space-y-1.5">
            <Label for="worker-code">初始代码</Label>
            <Textarea
              id="worker-code"
              v-model="createCode"
              class="min-h-64 font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createOpen = false">取消</Button>
          <Button :disabled="creating || !!nameError || !createName" @click="submitCreate">
            {{ creating ? '部署中…' : '创建并部署' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除确认 -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => !v && (deleteTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 Worker</DialogTitle>
          <DialogDescription>
            确定删除脚本 <code class="rounded bg-muted px-1 font-mono">{{ deleteTarget?.id }}</code>？该操作不可撤销，关联的路由与自定义域将被解除绑定。
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

    <!-- 编辑 Sheet -->
    <WorkerEditor
      :script-name="editingName"
      :open="editorOpen"
      @update:open="(v) => (editorOpen = v)"
      @deleted="load"
    />
  </div>
</template>
