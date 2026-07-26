<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Loader2,
  Globe,
  ExternalLink,
  Copy,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
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
import { zonesApi } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { Zone } from '@/types/cloudflare'

const router = useRouter()
const auth = useAuthStore()

const zones = ref<Zone[]>([])
const loading = ref(true)
const keyword = ref('')

/** CF 的 ?name= 是精确匹配，子串搜不到；改为拉全量后本地过滤 */
async function load() {
  loading.value = true
  try {
    zones.value = await zonesApi.listAll()
  } catch (e) {
    toast.error('加载域名列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}

const filteredZones = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return zones.value
  return zones.value.filter((z) => z.name.includes(kw))
})

onMounted(load)

/* ---------------- 添加域名 ---------------- */

const addOpen = ref(false)
const newName = ref('')
const creating = ref(false)
const createdZone = ref<Zone | null>(null)

/** 添加域名固定使用当前账号（请求凭据即当前账号，选其他账号必 403） */
const currentAccountLabel = computed(() => {
  const a = auth.currentAccount
  if (!a) return '—'
  return a.accountName || a.nickname || a.accountId
})

function openAdd() {
  newName.value = ''
  createdZone.value = null
  addOpen.value = true
}

async function submitAdd() {
  // Enter 键可绕过按钮 disabled，函数级并发守卫
  if (creating.value) return
  let name = newName.value.trim().toLowerCase()
  if (!name) {
    toast.error('请输入域名')
    return
  }
  // 剥离 scheme/路径并转 punycode：URL 解析一步完成
  try {
    name = new URL(`http://${name.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')}`).hostname.replace(/\.$/, '')
  } catch {
    toast.error('域名格式不合法')
    return
  }
  if (!name.includes('.')) {
    toast.error('域名格式不合法', { description: '请输入完整域名，如 example.com' })
    return
  }
  const accountId = auth.currentAccount?.accountId
  if (!accountId) {
    toast.error('未找到当前账号，请先添加或切换账号')
    return
  }
  creating.value = true
  try {
    const z = await zonesApi.create(name, { id: accountId })
    createdZone.value = z
    toast.success('域名已创建')
    await load()
  } catch (e) {
    toast.error('创建域名失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creating.value = false
  }
}

async function copy(text: string, label = '内容') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label}已复制`)
  } catch {
    toast.error('复制失败')
  }
}

/* ---------------- 删除域名 ---------------- */

const deleteTarget = ref<Zone | null>(null)
const deleting = ref(false)
/** 强确认：需输入完整域名才允许删除 */
const deleteConfirmText = ref('')
const deleteConfirmed = computed(
  () => !!deleteTarget.value && deleteConfirmText.value.trim().toLowerCase() === deleteTarget.value.name.toLowerCase(),
)

function openDelete(z: Zone) {
  deleteConfirmText.value = ''
  deleteTarget.value = z
}

async function confirmDelete() {
  if (!deleteTarget.value || !deleteConfirmed.value) return
  deleting.value = true
  try {
    await zonesApi.delete(deleteTarget.value.id)
    toast.success('域名已删除')
    deleteTarget.value = null
    await load()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

function fmtDate(s: string): string {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="space-y-6">
    <!-- 标题 + 操作 -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">域名管理</h1>
        <p class="text-sm text-muted-foreground">管理 Cloudflare 域名、DNS 记录与缓存</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
        <Button size="sm" @click="openAdd">
          <Plus class="size-4" />
          添加域名
        </Button>
      </div>
    </div>

    <!-- 搜索 -->
    <div class="relative max-w-md">
      <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        v-model="keyword"
        placeholder="按域名名称搜索"
        class="pl-8"
      />
    </div>

    <!-- 列表 -->
    <Card>
      <CardHeader v-if="!loading && filteredZones.length">
        <CardTitle class="text-base">共 {{ filteredZones.length }} 个域名</CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <!-- 表头 -->
        <div class="grid grid-cols-[minmax(160px,2fr)_100px_minmax(120px,1fr)_minmax(120px,1fr)_140px_60px] gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
          <span>域名</span>
          <span>状态</span>
          <span>套餐</span>
          <span>账户</span>
          <span>修改时间</span>
          <span class="text-right">操作</span>
        </div>

        <!-- loading -->
        <div v-if="loading" class="divide-y">
          <div v-for="i in 6" :key="i" class="grid grid-cols-[minmax(160px,2fr)_100px_minmax(120px,1fr)_minmax(120px,1fr)_140px_60px] items-center gap-2 px-4 py-3">
            <Skeleton class="h-5 w-40" />
            <Skeleton class="h-5 w-14" />
            <Skeleton class="h-5 w-24" />
            <Skeleton class="h-5 w-24" />
            <Skeleton class="h-5 w-32" />
            <Skeleton class="h-5 w-8" />
          </div>
        </div>

        <!-- 空状态 -->
        <div
          v-else-if="!filteredZones.length"
          class="flex flex-col items-center gap-3 px-4 py-16 text-center"
        >
          <div class="flex size-12 items-center justify-center rounded-full bg-muted">
            <Globe class="size-6 text-muted-foreground" />
          </div>
          <div>
            <div class="font-medium">{{ zones.length ? '没有匹配的域名' : '还没有域名' }}</div>
            <p class="text-sm text-muted-foreground">
              {{ zones.length ? '换个关键词试试' : '添加你的第一个 Cloudflare 域名' }}
            </p>
          </div>
          <Button v-if="!zones.length" size="sm" @click="openAdd">
            <Plus class="size-4" />
            添加域名
          </Button>
        </div>

        <!-- 数据行 -->
        <div v-else class="divide-y">
          <div
            v-for="z in filteredZones"
            :key="z.id"
            class="group grid grid-cols-[minmax(160px,2fr)_100px_minmax(120px,1fr)_minmax(120px,1fr)_140px_60px] items-center gap-2 px-4 py-3 text-sm hover:bg-accent/40"
          >
            <button
              type="button"
              class="flex min-w-0 items-center gap-2 text-left"
              @click="router.push(`/zones/${z.id}`)"
            >
              <Globe class="size-4 shrink-0 text-primary" />
              <span class="truncate font-medium hover:text-primary hover:underline" :title="z.name">{{ z.name }}</span>
            </button>

            <Badge
              :class="z.status === 'active' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'"
              variant="secondary"
            >
              {{ z.status }}
            </Badge>

            <span class="truncate text-muted-foreground" :title="z.plan?.name">{{ z.plan?.name ?? '—' }}</span>

            <span class="truncate text-muted-foreground" :title="z.account?.name">{{ z.account?.name ?? z.account?.id ?? '—' }}</span>

            <span class="truncate text-xs text-muted-foreground" :title="fmtDate(z.modified_on)">{{ fmtDate(z.modified_on) }}</span>

            <div class="flex justify-end">
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-destructive hover:text-destructive opacity-60 group-hover:opacity-100"
                title="删除"
                @click.stop="openDelete(z)"
              >
                <Trash2 class="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 添加域名 -->
    <Dialog v-model:open="addOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ createdZone ? '域名创建成功' : '添加域名' }}</DialogTitle>
          <DialogDescription v-if="!createdZone">将域名添加到 Cloudflare 管理</DialogDescription>
        </DialogHeader>

        <div v-if="!createdZone" class="space-y-4">
          <div class="space-y-2">
            <Label>域名</Label>
            <Input v-model="newName" placeholder="example.com" @keydown.enter="submitAdd" />
            <p class="text-xs text-muted-foreground">输入根域名，不要带 http/https</p>
          </div>
          <div class="space-y-2">
            <Label>所属账户</Label>
            <div class="rounded-md border bg-muted/30 px-3 py-2 text-sm">{{ currentAccountLabel }}</div>
            <p class="text-xs text-muted-foreground">域名将添加到当前账号，要在其他账号下添加请先切换账号</p>
          </div>
        </div>

        <div v-else class="space-y-3">
          <div class="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            域名 <span class="font-medium">{{ createdZone.name }}</span> 已创建。
            请到域名注册商将 NS 记录改为 Cloudflare 分配的名称服务器。
          </div>
          <div class="space-y-2">
            <div class="text-sm font-medium">Cloudflare 名称服务器</div>
            <ul class="space-y-1.5">
              <li v-for="ns in createdZone.name_servers" :key="ns" class="flex items-center justify-between gap-2">
                <code class="rounded bg-muted px-2 py-1 font-mono text-xs">{{ ns }}</code>
                <Button variant="ghost" size="icon-sm" @click="copy(ns, 'NS')">
                  <Copy class="size-3" />
                </Button>
              </li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <template v-if="!createdZone">
            <Button variant="outline" @click="addOpen = false">取消</Button>
            <Button :disabled="creating" @click="submitAdd">
              <Loader2 v-if="creating" class="size-4 animate-spin" />
              创建
            </Button>
          </template>
          <template v-else>
            <Button variant="outline" @click="addOpen = false">关闭</Button>
            <Button @click="router.push(`/zones/${createdZone.id}`)">
              <ExternalLink class="size-4" />
              进入详情
            </Button>
          </template>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除确认（删除中禁止关闭 Dialog，防止误触后状态悬空） -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v && !deleting) deleteTarget = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除域名</DialogTitle>
          <DialogDescription>
            确认删除域名 <span class="font-medium text-foreground">{{ deleteTarget?.name }}</span>？
            删除后该域名的 DNS 记录与相关配置将丢失，此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-2">
          <Label>输入完整域名以确认</Label>
          <Input v-model="deleteConfirmText" :placeholder="deleteTarget?.name" :disabled="deleting" />
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="deleting" @click="deleteTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deleting || !deleteConfirmed" @click="confirmDelete">
            <Loader2 v-if="deleting" class="size-4 animate-spin" />
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
