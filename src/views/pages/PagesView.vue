<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
} from '@lucide/vue'
import { pagesApi } from '@/api/pages'
import type { PagesDeployment, PagesProject } from '@/types/cloudflare'
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
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

// CF 规则：小写字母/数字/连字符，不以连字符结尾，最长 58 字符
const NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/

const projects = ref<PagesProject[]>([])
const loading = ref(true)

// 当前进入的项目（null = 列表视图）
const current = ref<PagesProject | null>(null)
const deployments = ref<PagesDeployment[]>([])
const loadingDeployments = ref(false)

// 新建项目
const createOpen = ref(false)
const createName = ref('')
const createBranch = ref('main')
const creating = ref(false)
const nameError = computed(() => {
  if (!createName.value) return ''
  if (createName.value.length > 58) return '最长 58 个字符'
  if (!NAME_RE.test(createName.value)) return '仅支持小写字母、数字、连字符，须以字母开头且不能以连字符结尾'
  return ''
})

// 删除确认
const deleteTarget = ref<PagesProject | null>(null)
const deleting = ref(false)

async function load() {
  loading.value = true
  try {
    projects.value = await pagesApi.listProjects()
  } catch (e) {
    toast.error('加载 Pages 项目失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate() {
  createName.value = ''
  createBranch.value = 'main'
  createOpen.value = true
}

async function submitCreate() {
  if (!createName.value || nameError.value) {
    toast.error('项目名不合法')
    return
  }
  creating.value = true
  try {
    await pagesApi.createProject(createName.value, createBranch.value || 'main')
    toast.success('Pages 项目创建成功')
    createOpen.value = false
    await load()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creating.value = false
  }
}

async function enterProject(p: PagesProject) {
  current.value = p
  deployments.value = []
  await loadDeployments(p.name)
}

// 请求序号：快速切换项目时丢弃过期响应，避免 A 的部署记录显示在 B 下
let deploymentsSeq = 0

async function loadDeployments(name: string) {
  const seq = ++deploymentsSeq
  loadingDeployments.value = true
  try {
    const list = await pagesApi.listDeployments(name)
    if (seq !== deploymentsSeq) return
    deployments.value = list
  } catch (e) {
    if (seq !== deploymentsSeq) return
    toast.error('加载部署列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    if (seq === deploymentsSeq) loadingDeployments.value = false
  }
}

function backToList() {
  deploymentsSeq++ // 作废在途请求，避免返回列表后过期响应写入状态
  current.value = null
  deployments.value = []
}

function confirmDelete(p: PagesProject) {
  deleteTarget.value = p
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await pagesApi.deleteProject(deleteTarget.value.name)
    toast.success('已删除')
    if (current.value?.name === deleteTarget.value.name) backToList()
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

function deploymentMessage(d: PagesDeployment): string {
  return d.source?.message ?? d.deployment_trigger?.metadata?.commit_message ?? '—'
}

function stageStatus(d: PagesDeployment): string {
  return d.latest_stage?.status ?? '—'
}

function subdomainUrl(p: PagesProject): string {
  return `https://${p.subdomain}.pages.dev`
}
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部操作 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">Pages</h1>
        <p class="text-sm text-muted-foreground">管理 Cloudflare Pages 项目与部署记录</p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          v-if="!current"
          variant="outline"
          size="sm"
          :disabled="loading"
          @click="load"
        >
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
        <Button v-if="!current" size="sm" @click="openCreate">
          <Plus class="size-4" />
          新建项目
        </Button>
        <Button v-else variant="outline" size="sm" @click="backToList">
          <ArrowLeft class="size-4" />
          返回列表
        </Button>
      </div>
    </div>

    <!-- ============ 项目列表视图 ============ -->
    <template v-if="!current">
      <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton v-for="i in 6" :key="i" class="h-32 rounded-xl" />
      </div>

      <Card v-else-if="!projects.length" class="border-dashed">
        <CardContent class="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Rocket class="size-6" />
          </div>
          <div class="font-medium">还没有 Pages 项目</div>
          <p class="text-sm text-muted-foreground">新建第一个项目，开始部署静态站点与全栈应用</p>
          <Button size="sm" @click="openCreate">
            <Plus class="size-4" />
            新建项目
          </Button>
        </CardContent>
      </Card>

      <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card
          v-for="p in projects"
          :key="p.name"
          class="group cursor-pointer transition hover:shadow-md hover:border-primary/40"
          @click="enterProject(p)"
        >
          <CardHeader class="pb-3">
            <div class="flex items-start justify-between gap-2">
              <CardTitle class="truncate font-mono text-base">{{ p.name }}</CardTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                @click.stop="confirmDelete(p)"
              >
                <Trash2 class="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent class="space-y-2 pt-0 text-xs text-muted-foreground">
            <a
              v-if="p.subdomain"
              :href="subdomainUrl(p)"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 font-mono text-primary hover:underline"
              @click.stop
            >
              {{ p.subdomain }}.pages.dev
              <ExternalLink class="size-3" />
            </a>
            <div v-else class="text-muted-foreground/70">无 subdomain</div>
            <div class="flex flex-wrap items-center gap-1.5">
              <Badge v-if="p.domains.length" variant="secondary">
                <Globe class="size-3" />
                {{ p.domains.length }} 个自定义域
              </Badge>
              <span>创建于 {{ fmtDate(p.created_on) }}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </template>

    <!-- ============ 项目详情视图 ============ -->
    <template v-else>
      <Card>
        <CardHeader class="pb-3">
          <div class="flex items-start justify-between gap-2">
            <div class="space-y-1">
              <CardTitle class="font-mono text-lg">{{ current.name }}</CardTitle>
              <p class="text-xs text-muted-foreground">创建于 {{ fmtDate(current.created_on) }}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-destructive"
              @click="confirmDelete(current)"
            >
              <Trash2 class="size-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent class="space-y-3 pt-0 text-sm">
          <div v-if="current.subdomain" class="flex flex-wrap items-center gap-2">
            <span class="w-24 text-muted-foreground">Subdomain</span>
            <a
              :href="subdomainUrl(current)"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 font-mono text-primary hover:underline"
            >
              {{ current.subdomain }}.pages.dev
              <ExternalLink class="size-3" />
            </a>
          </div>
          <div v-if="current.domains.length" class="flex flex-wrap items-start gap-2">
            <span class="w-24 pt-0.5 text-muted-foreground">自定义域</span>
            <div class="flex flex-wrap gap-2">
              <a
                v-for="d in current.domains"
                :key="d"
                :href="`https://${d}`"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Badge variant="outline" class="gap-1 font-mono hover:bg-accent">
                  <Globe class="size-3" />
                  {{ d }}
                  <ExternalLink class="size-3" />
                </Badge>
              </a>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- 部署列表 -->
      <Card>
        <CardHeader class="pb-3">
          <div class="flex items-center justify-between">
            <CardTitle class="text-base">部署记录</CardTitle>
            <Button
              variant="outline"
              size="sm"
              :disabled="loadingDeployments"
              @click="loadDeployments(current.name)"
            >
              <RefreshCw class="size-4" :class="{ 'animate-spin': loadingDeployments }" />
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent class="pt-0">
          <div v-if="loadingDeployments" class="space-y-2">
            <Skeleton v-for="i in 4" :key="i" class="h-12 w-full" />
          </div>
          <div v-else-if="!deployments.length" class="py-10 text-center text-sm text-muted-foreground">
            暂无部署记录
          </div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-left text-xs text-muted-foreground">
                  <th class="px-2 py-2 font-medium">部署 ID</th>
                  <th class="px-2 py-2 font-medium">环境</th>
                  <th class="px-2 py-2 font-medium">状态</th>
                  <th class="px-2 py-2 font-medium">提交信息</th>
                  <th class="px-2 py-2 font-medium">创建时间</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="d in deployments"
                  :key="d.id"
                  class="border-b last:border-0 hover:bg-muted/40"
                >
                  <td class="px-2 py-2 font-mono text-xs">{{ d.id }}</td>
                  <td class="px-2 py-2">
                    <Badge :variant="d.environment === 'production' ? 'default' : 'secondary'">
                      {{ d.environment === 'production' ? '生产' : '预览' }}
                    </Badge>
                  </td>
                  <td class="px-2 py-2">
                    <Badge variant="outline">{{ stageStatus(d) }}</Badge>
                  </td>
                  <td class="max-w-xs truncate px-2 py-2" :title="deploymentMessage(d)">
                    {{ deploymentMessage(d) }}
                  </td>
                  <td class="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">
                    {{ fmtDate(d.created_on) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </template>

    <!-- 新建项目对话框 -->
    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建 Pages 项目</DialogTitle>
          <DialogDescription>仅创建项目壳，后续可通过 Git 连接或 Direct Upload 上传部署。</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label for="pages-name">项目名</Label>
            <Input
              id="pages-name"
              v-model="createName"
              placeholder="my-site"
              class="font-mono"
              autocomplete="off"
            />
            <p class="text-xs" :class="nameError ? 'text-destructive' : 'text-muted-foreground'">
              {{ nameError || '小写字母开头，仅含小写字母、数字、连字符，不以连字符结尾，最长 58 字符' }}
            </p>
          </div>
          <div class="space-y-1.5">
            <Label for="pages-branch">生产分支</Label>
            <Input
              id="pages-branch"
              v-model="createBranch"
              placeholder="main"
              class="font-mono"
              autocomplete="off"
            />
          </div>
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
          <DialogTitle>删除 Pages 项目</DialogTitle>
          <DialogDescription>
            确定删除项目 <code class="rounded bg-muted px-1 font-mono">{{ deleteTarget?.name }}</code>？该操作不可撤销，关联的部署与自定义域配置将一并移除。
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
  </div>
</template>
