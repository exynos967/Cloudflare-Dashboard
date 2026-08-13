<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { ExternalLink, Loader2, Plus, Save, Trash2 } from '@lucide/vue'
import { workersApi } from '@/api/workers'
import type { WorkerBinding, WorkerSchedule, WorkerSecret } from '@/api/workers'
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

// 配置：bindings 只读 / cron / secrets
const bindings = ref<WorkerBinding[]>([])
const schedules = ref<WorkerSchedule[]>([])
const secrets = ref<WorkerSecret[]>([])
const configLoading = ref(false)
const newCron = ref('')
const addingCron = ref(false)
const deletingCron = ref<string | null>(null)
const secretForm = ref({ name: '', text: '' })
const addingSecret = ref(false)
const deleteSecretTarget = ref<WorkerSecret | null>(null)
const deletingSecret = ref(false)

// 请求序号：快速切换 Worker 时丢弃过期响应，避免 A 的代码覆盖 B
let codeSeq = 0
let configSeq = 0

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

async function loadConfig() {
  if (!name.value) return
  const seq = ++configSeq
  configLoading.value = true
  bindings.value = []
  schedules.value = []
  secrets.value = []
  try {
    const [settingsRes, schedulesRes, secretsRes] = await Promise.allSettled([
      workersApi.getSettings(name.value),
      workersApi.getSchedules(name.value),
      workersApi.listScriptSecrets(name.value),
    ])
    if (seq !== configSeq) return
    if (settingsRes.status === 'fulfilled') {
      bindings.value = settingsRes.value.bindings ?? []
    } else {
      toast.error('加载绑定失败', {
        description: settingsRes.reason instanceof Error ? settingsRes.reason.message : String(settingsRes.reason),
      })
    }
    if (schedulesRes.status === 'fulfilled') {
      schedules.value = schedulesRes.value
    } else {
      toast.error('加载定时触发失败', {
        description: schedulesRes.reason instanceof Error ? schedulesRes.reason.message : String(schedulesRes.reason),
      })
    }
    if (secretsRes.status === 'fulfilled') {
      secrets.value = Array.isArray(secretsRes.value) ? secretsRes.value : []
    } else {
      toast.error('加载密钥失败', {
        description: secretsRes.reason instanceof Error ? secretsRes.reason.message : String(secretsRes.reason),
      })
    }
  } finally {
    if (seq === configSeq) configLoading.value = false
  }
}

async function loadAll() {
  if (!name.value) return
  await Promise.all([loadCode(), loadZones(), loadSubdomain(), loadDomains(), loadConfig()])
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
      bindings.value = []
      schedules.value = []
      secrets.value = []
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

/** 绑定摘要：secret_text 永不展示明文 */
function bindingSummary(b: WorkerBinding): string {
  if (b.type === 'secret_text') return '密钥（明文不可见）'
  const parts = [
    b.namespace_id && `KV ${b.namespace_id}`,
    b.bucket_name && `R2 ${b.bucket_name}`,
    b.class_name && `class ${b.class_name}`,
    b.service && `service ${b.service}`,
    b.environment,
    b.id && b.id !== b.namespace_id ? `id ${b.id}` : '',
  ].filter(Boolean)
  return parts.join(' · ') || '—'
}

function isCronExpr(s: string): boolean {
  return s.trim().split(/\s+/).length === 5
}

async function addCron() {
  const cron = newCron.value.trim()
  if (!name.value || !cron) return
  if (!isCronExpr(cron)) {
    toast.error('cron 需为 5 段表达式，如 */5 * * * *')
    return
  }
  addingCron.value = true
  try {
    const current = await workersApi.getSchedules(name.value)
    if (current.some((s) => s.cron === cron)) {
      toast.error('该 cron 已存在')
      return
    }
    await workersApi.putSchedules(name.value, [...current, { cron }])
    toast.success('已添加定时触发')
    newCron.value = ''
    schedules.value = await workersApi.getSchedules(name.value)
  } catch (e) {
    toast.error('添加失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    addingCron.value = false
  }
}

async function removeCron(cron: string) {
  if (!name.value || deletingCron.value) return
  deletingCron.value = cron
  try {
    const current = await workersApi.getSchedules(name.value)
    await workersApi.putSchedules(name.value, current.filter((s) => s.cron !== cron))
    toast.success('已删除定时触发')
    schedules.value = await workersApi.getSchedules(name.value)
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingCron.value = null
  }
}

async function addSecret() {
  const n = secretForm.value.name.trim()
  const text = secretForm.value.text
  if (!name.value || !n || !text) {
    toast.error('请填写密钥名称和内容')
    return
  }
  addingSecret.value = true
  try {
    await workersApi.putSecret(name.value, n, text)
    toast.success('密钥已保存')
    secretForm.value = { name: '', text: '' }
    await loadConfig()
  } catch (e) {
    toast.error('保存密钥失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    addingSecret.value = false
  }
}

async function confirmDeleteSecret() {
  if (!name.value || !deleteSecretTarget.value) return
  deletingSecret.value = true
  try {
    await workersApi.deleteSecret(name.value, deleteSecretTarget.value.name)
    toast.success('密钥已删除')
    deleteSecretTarget.value = null
    await loadConfig()
  } catch (e) {
    toast.error('删除密钥失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingSecret.value = false
  }
}
</script>

<template>
  <Sheet :open="open" @update:open="(v) => emit('update:open', v)">
    <SheetContent side="right" class="flex w-full flex-col gap-0 sm:max-w-3xl">
      <SheetHeader class="border-b px-6 py-4">
        <SheetTitle class="truncate font-mono">{{ name }}</SheetTitle>
        <SheetDescription>编辑脚本代码、路由、自定义域、workers.dev 与绑定/定时/密钥</SheetDescription>
      </SheetHeader>

      <div class="flex-1 overflow-y-auto px-6 py-4">
        <Tabs default-value="code" class="w-full">
          <TabsList class="grid w-full grid-cols-5">
            <TabsTrigger value="code">代码</TabsTrigger>
            <TabsTrigger value="routes">路由</TabsTrigger>
            <TabsTrigger value="domains">自定义域</TabsTrigger>
            <TabsTrigger value="workersdev">workers.dev</TabsTrigger>
            <TabsTrigger value="config">配置</TabsTrigger>
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

          <!-- 配置：bindings 只读 / cron / secrets -->
          <TabsContent value="config" class="space-y-6">
            <div v-if="configLoading" class="space-y-2">
              <Skeleton v-for="i in 5" :key="i" class="h-10 w-full" />
            </div>
            <template v-else>
              <section class="space-y-2">
                <div>
                  <h3 class="text-sm font-medium">绑定</h3>
                  <p class="text-xs text-muted-foreground">只读展示。secret_text 不显示明文；增删绑定请改 wrangler 或官方后台后重新部署。</p>
                </div>
                <div v-if="!bindings.length" class="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                  暂无绑定
                </div>
                <ul v-else class="space-y-2">
                  <li
                    v-for="(b, i) in bindings"
                    :key="`${b.type}-${b.name ?? i}`"
                    class="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div class="min-w-0">
                      <div class="truncate font-mono text-sm">{{ b.name || '（未命名）' }}</div>
                      <div class="truncate text-xs text-muted-foreground">{{ bindingSummary(b) }}</div>
                    </div>
                    <Badge variant="secondary">{{ b.type }}</Badge>
                  </li>
                </ul>
              </section>

              <Separator />

              <section class="space-y-2">
                <div>
                  <h3 class="text-sm font-medium">定时触发（Cron）</h3>
                  <p class="text-xs text-muted-foreground">保存前会先拉取现网列表再合并，避免空 PUT 覆盖未知配置。</p>
                </div>
                <div class="flex gap-2">
                  <Input v-model="newCron" placeholder="*/5 * * * *" class="font-mono" />
                  <Button :disabled="addingCron || !newCron.trim()" @click="addCron">
                    <Plus class="size-4" />
                    添加
                  </Button>
                </div>
                <div v-if="!schedules.length" class="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                  暂无定时触发
                </div>
                <ul v-else class="space-y-2">
                  <li
                    v-for="s in schedules"
                    :key="s.cron"
                    class="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <code class="font-mono text-sm">{{ s.cron }}</code>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:text-destructive"
                      :disabled="deletingCron === s.cron"
                      @click="removeCron(s.cron)"
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </li>
                </ul>
              </section>

              <Separator />

              <section class="space-y-2">
                <div>
                  <h3 class="text-sm font-medium">密钥</h3>
                  <p class="text-xs text-muted-foreground">列表只显示名称。写入后无法再读出明文。</p>
                </div>
                <div class="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
                  <Input v-model="secretForm.name" placeholder="名称，如 API_KEY" class="font-mono" />
                  <Input v-model="secretForm.text" type="password" placeholder="密钥内容" autocomplete="new-password" />
                  <Button :disabled="addingSecret || !secretForm.name.trim() || !secretForm.text" @click="addSecret">
                    <Plus class="size-4" />
                    保存
                  </Button>
                </div>
                <div v-if="!secrets.length" class="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                  暂无密钥
                </div>
                <ul v-else class="space-y-2">
                  <li
                    v-for="s in secrets"
                    :key="s.name"
                    class="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div class="min-w-0">
                      <div class="truncate font-mono text-sm">{{ s.name }}</div>
                      <div class="text-xs text-muted-foreground">{{ s.type || 'secret_text' }}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:text-destructive"
                      @click="deleteSecretTarget = s"
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </li>
                </ul>
              </section>
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

  <Dialog :open="!!deleteSecretTarget" @update:open="(v) => !v && (deleteSecretTarget = null)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>删除密钥</DialogTitle>
        <DialogDescription>
          确定删除密钥 <code class="rounded bg-muted px-1 font-mono">{{ deleteSecretTarget?.name }}</code>？明文无法恢复。
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" @click="deleteSecretTarget = null">取消</Button>
        <Button variant="destructive" :disabled="deletingSecret" @click="confirmDeleteSecret">
          {{ deletingSecret ? '删除中…' : '确认删除' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
