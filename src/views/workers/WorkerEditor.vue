<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { ExternalLink, Loader2, Plus, Save, Trash2 } from '@lucide/vue'
import { workersApi } from '@/api/workers'
import { zonesApi } from '@/api/zones'
import type { WorkerDomain, WorkerRoute, Zone } from '@/types/cloudflare'
import {
  Sheet,
  SheetContent,
  SheetDescription,
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const props = defineProps<{
  scriptName: string | null
  open: boolean
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  'deleted': []
}>()

const name = computed(() => props.scriptName ?? '')

// 代码
const code = ref('')
const codeLoading = ref(false)
/** 代码是否已成功加载（加载中/失败时禁止保存，防止空代码覆盖线上脚本） */
const codeLoaded = ref(false)
const saving = ref(false)

// zones
const zones = ref<Zone[]>([])
const zonesLoading = ref(false)

// workers.dev 子域
const subdomain = ref<string>('')
const subdomainEnabled = ref(false)
const subdomainLoading = ref(false)
const subdomainToggling = ref(false)
const workersDevUrl = computed(() =>
  subdomain.value ? `${name.value}.${subdomain.value}.workers.dev` : '',
)

// 路由
const selectedZoneId = ref<string>('')
const routes = ref<WorkerRoute[]>([])
const routesLoading = ref(false)
const newPattern = ref('')
const addingRoute = ref(false)

// 自定义域
const domains = ref<WorkerDomain[]>([])
const domainsLoading = ref(false)
const newDomainZone = ref<string>('')
const newHostname = ref('')
const addingDomain = ref(false)

// 删除确认
const deleteOpen = ref(false)
const deleting = ref(false)

// 请求序号：快速切换 Worker 时丢弃过期响应，避免 A 的代码覆盖 B
let codeSeq = 0

async function loadCode() {
  if (!name.value) return
  const seq = ++codeSeq
  codeLoading.value = true
  codeLoaded.value = false
  code.value = ''
  try {
    const text = await workersApi.getScriptContent(name.value)
    if (seq !== codeSeq) return
    code.value = text
    codeLoaded.value = true
  } catch (e) {
    if (seq !== codeSeq) return
    toast.error('读取脚本失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    if (seq === codeSeq) codeLoading.value = false
  }
}

async function loadZones() {
  zonesLoading.value = true
  try {
    zones.value = await zonesApi.listAll()
    if (zones.value.length && !selectedZoneId.value) selectedZoneId.value = zones.value[0].id
    if (zones.value.length && !newDomainZone.value) newDomainZone.value = zones.value[0].id
  } catch (e) {
    toast.error('加载域名列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    zonesLoading.value = false
  }
}

async function loadSubdomain() {
  subdomainLoading.value = true
  try {
    const sub = await workersApi.getSubdomain()
    subdomain.value = sub.subdomain
    const st = await workersApi.getSubdomainStatus(name.value)
    subdomainEnabled.value = st.enabled
  } catch (e) {
    // 未开通 workers.dev 子域时静默；同步清掉启用态，避免上一脚本状态残留
    subdomain.value = ''
    subdomainEnabled.value = false
  } finally {
    subdomainLoading.value = false
  }
}

async function loadRoutes() {
  if (!selectedZoneId.value) return
  routesLoading.value = true
  try {
    const all = await workersApi.listRoutes(selectedZoneId.value)
    routes.value = all.filter((r) => r.script === name.value)
  } catch (e) {
    toast.error('加载路由失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    routesLoading.value = false
  }
}

async function loadDomains() {
  domainsLoading.value = true
  try {
    const all = await workersApi.listDomains()
    domains.value = all.filter((d) => d.service === name.value)
  } catch (e) {
    toast.error('加载自定义域失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    domainsLoading.value = false
  }
}

async function loadAll() {
  if (!name.value) return
  await Promise.all([loadCode(), loadZones(), loadSubdomain(), loadDomains()])
  await loadRoutes()
}

watch(
  () => [props.open, props.scriptName] as const,
  ([isOpen, n]) => {
    if (isOpen && n) {
      // 切换脚本时先重置状态再加载，避免上一脚本的数据残留
      routes.value = []
      domains.value = []
      subdomain.value = ''
      subdomainEnabled.value = false
      loadAll()
    }
  },
  { immediate: true },
)

watch(selectedZoneId, () => {
  if (props.open) loadRoutes()
})

async function saveCode() {
  if (!name.value) return
  saving.value = true
  try {
    await workersApi.uploadScript(name.value, code.value)
    toast.success('已保存并部署')
  } catch (e) {
    toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    saving.value = false
  }
}

async function toggleSubdomain(v: boolean) {
  if (!name.value) return
  subdomainToggling.value = true
  try {
    await workersApi.setSubdomainStatus(name.value, v)
    subdomainEnabled.value = v
    toast.success(v ? '已启用 workers.dev' : '已禁用 workers.dev')
  } catch (e) {
    toast.error('切换失败', { description: e instanceof Error ? e.message : String(e) })
    subdomainEnabled.value = !v
  } finally {
    subdomainToggling.value = false
  }
}

async function addRoute() {
  if (!selectedZoneId.value || !newPattern.value.trim()) return
  addingRoute.value = true
  try {
    await workersApi.createRoute(selectedZoneId.value, newPattern.value.trim(), name.value)
    toast.success('路由已添加')
    newPattern.value = ''
    await loadRoutes()
  } catch (e) {
    toast.error('添加路由失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    addingRoute.value = false
  }
}

async function deleteRoute(routeId: string) {
  try {
    await workersApi.deleteRoute(selectedZoneId.value, routeId)
    toast.success('路由已删除')
    await loadRoutes()
  } catch (e) {
    toast.error('删除路由失败', { description: e instanceof Error ? e.message : String(e) })
  }
}

async function addDomain() {
  if (!newDomainZone.value || !newHostname.value.trim()) return
  addingDomain.value = true
  try {
    await workersApi.createDomain({
      hostname: newHostname.value.trim(),
      service: name.value,
      zone_id: newDomainZone.value,
    })
    toast.success('自定义域已添加（配置生效需要时间）')
    newHostname.value = ''
    await loadDomains()
  } catch (e) {
    toast.error('添加自定义域失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    addingDomain.value = false
  }
}

async function deleteDomain(domainId: string) {
  try {
    await workersApi.deleteDomain(domainId)
    toast.success('自定义域已删除')
    await loadDomains()
  } catch (e) {
    toast.error('删除自定义域失败', { description: e instanceof Error ? e.message : String(e) })
  }
}

async function deleteSelf() {
  if (!name.value || deleting.value) return
  deleting.value = true
  try {
    await workersApi.deleteScript(name.value)
    toast.success('Worker 已删除')
    deleteOpen.value = false
    emit('deleted')
    emit('update:open', false)
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

function zoneName(id: string): string {
  return zones.value.find((z) => z.id === id)?.name ?? id
}
</script>

<template>
  <Sheet :open="open" @update:open="(v) => emit('update:open', v)">
    <SheetContent side="right" class="flex w-full flex-col gap-0 sm:max-w-3xl">
      <SheetHeader class="border-b px-6 py-4">
        <SheetTitle class="truncate font-mono">{{ name }}</SheetTitle>
        <SheetDescription>编辑脚本代码、路由、自定义域与 workers.dev 子域</SheetDescription>
      </SheetHeader>

      <div class="flex-1 overflow-y-auto px-6 py-4">
        <Tabs default-value="code" class="w-full">
          <TabsList class="grid w-full grid-cols-4">
            <TabsTrigger value="code">代码</TabsTrigger>
            <TabsTrigger value="routes">路由</TabsTrigger>
            <TabsTrigger value="domains">自定义域</TabsTrigger>
            <TabsTrigger value="workersdev">workers.dev</TabsTrigger>
          </TabsList>

          <!-- 代码 -->
          <TabsContent value="code" class="space-y-3">
            <div class="flex items-center justify-between">
              <p class="text-sm text-muted-foreground">修改后点击保存即立即重新部署</p>
              <Button size="sm" :disabled="saving || codeLoading || !codeLoaded" @click="saveCode">
                <Save class="size-4" />
                {{ saving ? '部署中…' : '保存部署' }}
              </Button>
            </div>
            <Separator />
            <div class="space-y-1.5">
              <Label>访问地址</Label>
              <div class="flex flex-wrap gap-2 text-sm">
                <a
                  v-if="subdomainEnabled && workersDevUrl"
                  :href="`https://${workersDevUrl}`"
                  target="_blank"
                  rel="noopener"
                  class="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  https://{{ workersDevUrl }}
                  <ExternalLink class="size-3" />
                </a>
                <a
                  v-for="d in domains"
                  :key="d.id"
                  :href="`https://${d.hostname}`"
                  target="_blank"
                  rel="noopener"
                  class="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  https://{{ d.hostname }}
                  <ExternalLink class="size-3" />
                </a>
                <span v-if="!subdomainEnabled && !domains.length" class="text-muted-foreground">
                  未启用 workers.dev 且无自定义域
                </span>
              </div>
            </div>
            <Separator />
            <div v-if="codeLoading" class="space-y-2">
              <Skeleton class="h-6 w-full" v-for="i in 8" :key="i" />
            </div>
            <Textarea
              v-else
              v-model="code"
              class="min-h-[60vh] font-mono text-xs leading-relaxed"
              spellcheck="false"
            />
          </TabsContent>

          <!-- 路由 -->
          <TabsContent value="routes" class="space-y-4">
            <div class="space-y-1.5">
              <Label>选择域名（Zone）</Label>
              <Select v-model="selectedZoneId">
                <SelectTrigger class="w-full">
                  <SelectValue placeholder="选择域名" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="z in zones" :key="z.id" :value="z.id">
                    {{ z.name }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div class="space-y-2">
              <Label>添加路由</Label>
              <div class="flex gap-2">
                <Input
                  v-model="newPattern"
                  placeholder="例如 app.example.com/* 或 example.com/api/*"
                  class="font-mono"
                />
                <Button :disabled="addingRoute || !newPattern.trim() || !selectedZoneId" @click="addRoute">
                  <Plus class="size-4" />
                  添加
                </Button>
              </div>
              <p class="text-xs text-muted-foreground">路由模式匹配请求主机名 + 路径，匹配后由该 Worker 处理</p>
            </div>

            <Separator />

            <div v-if="routesLoading" class="space-y-2">
              <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
            </div>
            <div v-else-if="!routes.length" class="py-8 text-center text-sm text-muted-foreground">
              该域名下暂无指向此 Worker 的路由
            </div>
            <ul v-else class="space-y-2">
              <li
                v-for="r in routes"
                :key="r.id"
                class="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div class="min-w-0">
                  <div class="truncate font-mono text-sm">{{ r.pattern }}</div>
                  <div class="text-xs text-muted-foreground">{{ zoneName(selectedZoneId) }}</div>
                </div>
                <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive" @click="deleteRoute(r.id)">
                  <Trash2 class="size-4" />
                </Button>
              </li>
            </ul>
          </TabsContent>

          <!-- 自定义域 -->
          <TabsContent value="domains" class="space-y-4">
            <div class="space-y-2">
              <Label>添加自定义域</Label>
              <div class="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
                <Select v-model="newDomainZone">
                  <SelectTrigger class="w-full">
                    <SelectValue placeholder="选择域名" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="z in zones" :key="z.id" :value="z.id">
                      {{ z.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  v-model="newHostname"
                  placeholder="例如 api.example.com"
                  class="font-mono"
                />
                <Button :disabled="addingDomain || !newHostname.trim() || !newDomainZone" @click="addDomain">
                  <Plus class="size-4" />
                  添加
                </Button>
              </div>
              <p class="text-xs text-muted-foreground">添加后将自动创建 DNS 记录与证书，生效可能需要数分钟</p>
            </div>

            <Separator />

            <div v-if="domainsLoading" class="space-y-2">
              <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
            </div>
            <div v-else-if="!domains.length" class="py-8 text-center text-sm text-muted-foreground">
              暂无自定义域
            </div>
            <ul v-else class="space-y-2">
              <li
                v-for="d in domains"
                :key="d.id"
                class="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div class="min-w-0">
                  <div class="truncate font-mono text-sm">{{ d.hostname }}</div>
                  <div class="text-xs text-muted-foreground">{{ d.zone_name }} · {{ d.environment }}</div>
                </div>
                <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive" @click="deleteDomain(d.id)">
                  <Trash2 class="size-4" />
                </Button>
              </li>
            </ul>
          </TabsContent>

          <!-- workers.dev -->
          <TabsContent value="workersdev" class="space-y-4">
            <div v-if="subdomainLoading" class="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 class="size-4 animate-spin" /> 加载中…
            </div>
            <template v-else>
              <div class="rounded-md border p-4">
                <div class="flex items-center justify-between">
                  <div>
                    <div class="font-medium">workers.dev 子域</div>
                    <div v-if="subdomain" class="text-sm text-muted-foreground">
                      子域：<code class="font-mono">{{ subdomain }}</code>
                    </div>
                    <div v-else class="text-sm text-muted-foreground">尚未开通 workers.dev 子域</div>
                  </div>
                  <Switch
                    :model-value="subdomainEnabled"
                    :disabled="subdomainToggling || !subdomain"
                    @update:model-value="toggleSubdomain"
                  />
                </div>
              </div>

              <div v-if="subdomain" class="rounded-md border p-4">
                <div class="text-sm text-muted-foreground">访问地址</div>
                <a
                  v-if="subdomainEnabled"
                  :href="`https://${workersDevUrl}`"
                  target="_blank"
                  rel="noopener"
                  class="mt-1 inline-flex items-center gap-1 font-mono text-primary hover:underline"
                >
                  https://{{ workersDevUrl }}
                  <ExternalLink class="size-3" />
                </a>
                <div v-else class="mt-1 font-mono text-sm text-muted-foreground">
                  {{ workersDevUrl }} <span class="ml-2"><Badge variant="secondary">已禁用</Badge></span>
                </div>
              </div>
              <p v-else class="text-sm text-muted-foreground">
                请先在 Cloudflare 控制台 Workers 概览页开通 workers.dev 子域后刷新。
              </p>
            </template>
          </TabsContent>
        </Tabs>
      </div>

      <!-- 底部 -->
      <div class="flex items-center justify-end gap-2 border-t px-6 py-3">
        <Button variant="destructive" size="sm" @click="deleteOpen = true">
          <Trash2 class="size-4" />
          删除此 Worker
        </Button>
      </div>
    </SheetContent>
  </Sheet>

  <!-- 删除确认 -->
  <Dialog v-model:open="deleteOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>删除 Worker</DialogTitle>
        <DialogDescription>
          确定删除脚本 <code class="rounded bg-muted px-1 font-mono">{{ name }}</code>？该操作不可撤销，关联的路由与自定义域将被解除绑定。
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="deleteOpen = false">取消</Button>
        <Button variant="destructive" :disabled="deleting" @click="deleteSelf">
          {{ deleting ? '删除中…' : '确认删除' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
