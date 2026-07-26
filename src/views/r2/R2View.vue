<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import {
  ArrowLeft,
  Database,
  Download,
  HardDrive,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from '@lucide/vue'
import { r2Api, type R2Location } from '@/api/r2'
import type { R2Bucket, R2Object } from '@/types/cloudflare'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'

// CF 桶名规则：3-63 字符，仅小写字母/数字/连字符，且不能以连字符开头或结尾
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

const LOCATION_OPTIONS: { value: R2Location; label: string }[] = [
  { value: 'auto', label: '自动（auto）' },
  { value: 'apac', label: '亚太（apac）' },
  { value: 'eeur', label: '东欧（eeur）' },
  { value: 'enam', label: '北美东部（enam）' },
  { value: 'weur', label: '西欧（weur）' },
  { value: 'wnam', label: '北美西部（wnam）' },
]

/* ---------- 桶列表 ---------- */
const buckets = ref<R2Bucket[]>([])
const loadingBuckets = ref(true)
const currentBucket = ref<string | null>(null)

/* ---------- 对象列表 ---------- */
const objects = ref<R2Object[]>([])
const loadingObjects = ref(false)

/* ---------- 创建桶 ---------- */
const createOpen = ref(false)
const createName = ref('')
const createLocation = ref<R2Location>('auto')
const creating = ref(false)
const nameError = computed(() => {
  if (!createName.value) return ''
  if (createName.value.length < 3 || createName.value.length > 63) return '桶名长度需为 3-63 个字符'
  if (!NAME_RE.test(createName.value)) return '仅支持小写字母、数字、连字符，且不能以连字符开头或结尾'
  return ''
})

/* ---------- 删除确认 ---------- */
const deleteBucketTarget = ref<R2Bucket | null>(null)
const deleteObjectTarget = ref<R2Object | null>(null)
const deleting = ref(false)

/* ---------- 上传 ---------- */
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

async function loadBuckets() {
  loadingBuckets.value = true
  try {
    buckets.value = await r2Api.listBuckets()
  } catch (e) {
    toast.error('加载 R2 桶列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loadingBuckets.value = false
  }
}

// 请求序号守卫：快速切换桶时，丢弃旧桶迟到的 listObjects 响应
let objSeq = 0

async function loadObjects() {
  if (!currentBucket.value) return
  const seq = ++objSeq
  loadingObjects.value = true
  try {
    const list = await r2Api.listObjects(currentBucket.value)
    if (seq !== objSeq) return
    objects.value = list
  } catch (e) {
    if (seq !== objSeq) return
    toast.error('加载对象列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    if (seq === objSeq) loadingObjects.value = false
  }
}

onMounted(loadBuckets)

function openBucket(name: string) {
  currentBucket.value = name
  objects.value = []
  loadObjects()
}

function backToBuckets() {
  objSeq++ // 使在途的对象列表请求失效
  currentBucket.value = null
  objects.value = []
  loadBuckets()
}

function openCreate() {
  createName.value = ''
  createLocation.value = 'auto'
  createOpen.value = true
}

async function submitCreate() {
  if (!createName.value || nameError.value) {
    toast.error('桶名不合法')
    return
  }
  creating.value = true
  try {
    await r2Api.createBucket(createName.value, createLocation.value)
    toast.success('桶创建成功')
    createOpen.value = false
    await loadBuckets()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creating.value = false
  }
}

async function doDeleteBucket() {
  if (!deleteBucketTarget.value) return
  deleting.value = true
  try {
    await r2Api.deleteBucket(deleteBucketTarget.value.name)
    toast.success('已删除桶')
    deleteBucketTarget.value = null
    await loadBuckets()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

async function doDeleteObject() {
  if (!deleteObjectTarget.value || !currentBucket.value) return
  deleting.value = true
  try {
    await r2Api.deleteObject(currentBucket.value, deleteObjectTarget.value.key)
    toast.success('已删除对象')
    deleteObjectTarget.value = null
    await loadObjects()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

function triggerUpload() {
  fileInput.value?.click()
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !currentBucket.value) return
  uploading.value = true
  try {
    const buf = await file.arrayBuffer()
    await r2Api.putObject(currentBucket.value, file.name, buf)
    toast.success('上传成功')
    await loadObjects()
  } catch (err) {
    toast.error('上传失败', { description: err instanceof Error ? err.message : String(err) })
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function downloadObject(obj: R2Object) {
  if (!currentBucket.value) return
  try {
    const blob = await r2Api.getObject(currentBucket.value, obj.key)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = obj.key.split('/').pop() || obj.key
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e) {
    toast.error('下载失败', { description: e instanceof Error ? e.message : String(e) })
  }
}

function fmtSize(bytes: number | string | undefined): string {
  if (bytes == null) return '-'
  const n = typeof bytes === 'string' ? Number(bytes) : bytes
  if (!Number.isFinite(n)) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}

function locationLabel(loc: R2Location): string {
  return LOCATION_OPTIONS.find((o) => o.value === loc)?.label ?? loc
}
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部操作 -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <Button v-if="currentBucket" variant="ghost" size="icon-sm" @click="backToBuckets">
          <ArrowLeft class="size-4" />
        </Button>
        <div>
          <h1 class="text-xl font-semibold tracking-tight">
            {{ currentBucket ? currentBucket : 'R2 对象存储' }}
          </h1>
          <p class="text-sm text-muted-foreground">
            {{ currentBucket ? '管理桶内对象：上传、下载、删除' : '管理 Cloudflare R2 桶与对象' }}
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="currentBucket ? loadingObjects : loadingBuckets"
          @click="currentBucket ? loadObjects() : loadBuckets()"
        >
          <RefreshCw class="size-4" :class="{ 'animate-spin': currentBucket ? loadingObjects : loadingBuckets }" />
          刷新
        </Button>
        <Button v-if="!currentBucket" size="sm" @click="openCreate">
          <Plus class="size-4" />
          新建桶
        </Button>
        <Button v-else size="sm" :disabled="uploading" @click="triggerUpload">
          <Upload class="size-4" />
          {{ uploading ? '上传中…' : '上传对象' }}
        </Button>
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          @change="onFileChange"
        />
      </div>
    </div>

    <!-- ============ 桶列表视图 ============ -->
    <template v-if="!currentBucket">
      <div v-if="loadingBuckets" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton v-for="i in 6" :key="i" class="h-28 rounded-xl" />
      </div>

      <Card v-else-if="!buckets.length" class="border-dashed">
        <CardContent class="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <HardDrive class="size-6" />
          </div>
          <div class="font-medium">还没有 R2 桶</div>
          <p class="text-sm text-muted-foreground">新建第一个桶，开始存储对象</p>
          <Button size="sm" @click="openCreate">
            <Plus class="size-4" />
            新建桶
          </Button>
        </CardContent>
      </Card>

      <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card
          v-for="b in buckets"
          :key="b.name"
          class="group cursor-pointer transition hover:shadow-md hover:border-primary/40"
          @click="openBucket(b.name)"
        >
          <CardHeader class="pb-3">
            <div class="flex items-start justify-between gap-2">
              <CardTitle class="truncate font-mono text-base">{{ b.name }}</CardTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                @click.stop="deleteBucketTarget = b"
              >
                <Trash2 class="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent class="space-y-3 pt-0 text-xs text-muted-foreground">
            <div class="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{{ locationLabel(b.location) }}</Badge>
            </div>
            <div class="flex items-center justify-between">
              <span>创建于 {{ fmtDate(b.creation_date) }}</span>
              <span v-if="b.usage" class="inline-flex items-center gap-1">
                <Database class="size-3" /> {{ fmtSize(b.usage.uploadedBytes) }}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </template>

    <!-- ============ 对象列表视图 ============ -->
    <template v-else>
      <Card>
        <CardContent class="p-0">
          <div v-if="loadingObjects" class="space-y-2 p-4">
            <Skeleton v-for="i in 5" :key="i" class="h-10 w-full" />
          </div>
          <div v-else-if="!objects.length" class="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <HardDrive class="size-6" />
            </div>
            <div class="font-medium">桶内暂无对象</div>
            <Button size="sm" :disabled="uploading" @click="triggerUpload">
              <Upload class="size-4" />
              上传第一个对象
            </Button>
          </div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th class="px-4 py-3 font-medium">名称</th>
                  <th class="px-4 py-3 font-medium">大小</th>
                  <th class="px-4 py-3 font-medium">ETag</th>
                  <th class="px-4 py-3 font-medium">修改时间</th>
                  <th class="px-4 py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="o in objects"
                  :key="o.key"
                  class="border-b last:border-0 hover:bg-muted/40"
                >
                  <td class="max-w-[280px] truncate px-4 py-3 font-mono text-xs">{{ o.key }}</td>
                  <td class="px-4 py-3">{{ fmtSize(o.size) }}</td>
                  <td class="max-w-[160px] truncate px-4 py-3 font-mono text-xs text-muted-foreground">{{ o.etag }}</td>
                  <td class="px-4 py-3 text-muted-foreground">{{ fmtDate(o.last_modified) }}</td>
                  <td class="px-4 py-3">
                    <div class="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" @click="downloadObject(o)">
                        <Download class="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        class="text-muted-foreground hover:text-destructive"
                        @click="deleteObjectTarget = o"
                      >
                        <Trash2 class="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </template>

    <!-- 新建桶对话框 -->
    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建 R2 桶</DialogTitle>
          <DialogDescription>填写桶名与存储区域。桶名创建后不可修改。</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label for="bucket-name">桶名</Label>
            <Input
              id="bucket-name"
              v-model="createName"
              placeholder="my-bucket"
              class="font-mono"
              autocomplete="off"
            />
            <p class="text-xs" :class="nameError ? 'text-destructive' : 'text-muted-foreground'">
              {{ nameError || '3-63 个字符，仅含小写字母、数字、连字符，不能以连字符开头或结尾' }}
            </p>
          </div>
          <div class="space-y-1.5">
            <Label>存储区域</Label>
            <Select v-model="createLocation">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="选择区域" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="o in LOCATION_OPTIONS" :key="o.value" :value="o.value">
                  {{ o.label }}
                </SelectItem>
              </SelectContent>
            </Select>
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

    <!-- 删除桶确认 -->
    <Dialog :open="!!deleteBucketTarget" @update:open="(v) => !v && (deleteBucketTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 R2 桶</DialogTitle>
          <DialogDescription>
            确定删除桶 <code class="rounded bg-muted px-1 font-mono">{{ deleteBucketTarget?.name }}</code>？
            删除前需先清空桶内所有对象，该操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteBucketTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deleting" @click="doDeleteBucket">
            {{ deleting ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除对象确认 -->
    <Dialog :open="!!deleteObjectTarget" @update:open="(v) => !v && (deleteObjectTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除对象</DialogTitle>
          <DialogDescription>
            确定删除对象 <code class="rounded bg-muted px-1 font-mono">{{ deleteObjectTarget?.key }}</code>？该操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteObjectTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deleting" @click="doDeleteObject">
            {{ deleting ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
