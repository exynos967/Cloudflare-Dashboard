<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { toast } from 'vue-sonner'
import {
  Share2,
  Cloud,
  ShieldCheck,
  Loader2,
  RefreshCw,
  Trash2,
  Globe,
  Link2,
  AlertCircle,
  TriangleAlert,
} from '@lucide/vue'
import { zonesApi } from '@/api/zones'
import {
  DEFAULT_PREFERRED_DOMAIN,
  PREFERRED_DOMAINS,
  deploySaas,
  isValidIp,
  listSaasDeployments,
  removeSaas,
  type OriginMode,
  type SaasDeployConfig,
  type SaasDeployProgress,
  type SaasDeployment,
} from '@/api/saas'
import type { Zone } from '@/types/cloudflare'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'

/* -------------------------------------------------------------------------- */
/*                              zone 列表加载                                  */
/* -------------------------------------------------------------------------- */

const zones = ref<Zone[]>([])
const zonesLoading = ref(false)

async function loadZones() {
  zonesLoading.value = true
  try {
    zones.value = await zonesApi.listAll()
  } catch (e) {
    toast.error('加载域名列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    zonesLoading.value = false
  }
}

onMounted(loadZones)

/* -------------------------------------------------------------------------- */
/*                              Tab1 新建部署                                  */
/* -------------------------------------------------------------------------- */

const form = reactive({
  zoneId: '' as string,
  prefix: 'www', // 访问域名前缀，留空或 @ 表示根域
  originMode: 'domain' as OriginMode, // 源站模式：domain=源站域名（非 CF 代理）；ip=源站 IP（传统服务器）
  originDomain: '', // domain 模式=源站域名(非 CF 代理，如对象存储/CDN 域名)；ip 模式=回源域名(账号下 zone 子域)
  originIp: '', // 仅 ip 模式显示，源站真实 IP
  preferredDomain: DEFAULT_PREFERRED_DOMAIN,
  customPreferred: '', // 优选域名选「自定义…」时填的自定义域名
})

/** 优选域名是否为自定义模式（选中 __custom__） */
const customPreferredMode = computed(() => form.preferredDomain === '__custom__')
/** 实际用于部署的优选域名 */
const preferredDomainValue = computed(() =>
  customPreferredMode.value ? form.customPreferred.trim() : form.preferredDomain,
)

/** 拼出完整访问域名：前缀为空或 @ 时 = 主域名，否则 `${前缀}.${主域名}` */
const accessDomain = computed(() => {
  const zone = zones.value.find((z) => z.id === form.zoneId)
  if (!zone) return ''
  const prefix = form.prefix.trim()
  if (!prefix || prefix === '@') return zone.name
  return `${prefix}.${zone.name}`
})

/** 源站 IP 校验状态 */
const originIpInvalid = computed(() => {
  const v = form.originIp.trim()
  if (!v) return false
  return !isValidIp(v)
})

/** 回源域名输入框的 label/placeholder/提示随源站模式变化 */
const originDomainLabel = computed(() =>
  form.originMode === 'domain' ? '源站域名' : '回源域名',
)
const originDomainPlaceholder = computed(() =>
  form.originMode === 'domain'
    ? 'origin.example.com 或 bucket.s3.amazonaws.com'
    : 'saas-origin.example.com',
)
const originDomainHint = computed(() =>
  form.originMode === 'domain'
    ? '源站已有公网域名（非 CF 代理，如对象存储/CDN/自建服务器域名），将在 zone 内自动创建回源 CNAME 子域指向它作为 fallback origin'
    : '账号下某 zone 的子域名，需可创建 A 记录，作为 fallback origin',
)

interface StepState {
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
}
const steps = ref<StepState[]>([])
const progress = ref(0)
const deploying = ref(false)
/** 部署成功后展示的 deployment 信息 */
const deployedInfo = ref<SaasDeployment | null>(null)
/** 需手动 CNAME 提示（含访问域名 + 优选域名） */
const manualCnameHint = ref<{ accessDomain: string; preferredDomain: string } | null>(null)

function resetSteps() {
  steps.value = [
    { label: '预检既有配置', status: 'pending' },
    { label: '配置回源记录', status: 'pending' },
    { label: '配置回退源', status: 'pending' },
    { label: '接入访问域名', status: 'pending' },
    { label: '配置访问域名 CNAME', status: 'pending' },
    { label: '完成', status: 'pending' },
  ]
  progress.value = 0
}

/** 部署步骤索引映射：precheck=0, dns=1, fallback=2, hostname=3, cname=4, done=5 */
function stepIndex(step: SaasDeployProgress['step']): number {
  switch (step) {
    case 'precheck':
      return 0
    case 'dns':
      return 1
    case 'fallback':
      return 2
    case 'hostname':
      return 3
    case 'cname':
      return 4
    default:
      return 5
  }
}

function applyProgress(p: SaasDeployProgress) {
  const idx = stepIndex(p.step)
  // 标记之前步骤为完成
  for (let i = 0; i < idx; i++) {
    if (steps.value[i].status !== 'error') steps.value[i].status = 'done'
  }
  if (p.ok) {
    steps.value[idx].status = p.step === 'done' ? 'done' : 'running'
  } else {
    steps.value[idx].status = 'error'
  }
  progress.value = Math.min(100, Math.round(((idx + (p.step === 'done' ? 1 : 0.5)) / 6) * 100))
  // 步骤失败用 warning 暴露原因，避免「步骤打叉但 toast 报成功」
  if (!p.ok) {
    toast.warning(p.message || '部署步骤出现问题')
    return
  }
  if (p.step === 'precheck') toast.info(p.message || '正在预检既有配置…')
  else if (p.step === 'dns') toast.info(p.message || '正在配置回源记录…')
  else if (p.step === 'fallback') toast.info(p.message || '正在配置回退源…')
  else if (p.step === 'hostname') toast.info(p.message || '正在接入访问域名…')
  else if (p.step === 'cname') toast.info(p.message || '正在配置访问域名 CNAME…')
  else if (p.step === 'done') toast.success(p.message || 'SaaS 优选部署完成')
}

async function onDeploy() {
  if (!form.zoneId) {
    toast.error('请先选择访问域名所在的 zone')
    return
  }
  if (!accessDomain.value) {
    toast.error('访问域名不完整')
    return
  }
  // 前缀仅允许单级（字母/数字/连字符），防止误填完整域名拼出 www.example.com.example.com
  const prefix = form.prefix.trim()
  if (prefix && prefix !== '@' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(prefix)) {
    toast.error('访问域名前缀格式不正确', { description: '仅支持单级前缀（字母/数字/连字符），不要填完整域名' })
    return
  }
  if (!form.originDomain.trim()) {
    toast.error(form.originMode === 'domain' ? '请填写源站域名' : '请填写回源域名')
    return
  }
  if (form.originMode === 'ip') {
    if (!form.originIp.trim()) {
      toast.error('请填写源站 IP')
      return
    }
    if (originIpInvalid.value) {
      toast.error('源站 IP 格式不正确')
      return
    }
  }
  if (customPreferredMode.value && !form.customPreferred.trim()) {
    toast.error('请填写自定义优选域名')
    return
  }
  if (!preferredDomainValue.value) {
    toast.error('请选择优选域名')
    return
  }
  // 回源域名不能与访问域名相同
  if (
    form.originDomain.trim().toLowerCase() === accessDomain.value.toLowerCase()
  ) {
    toast.error('回源域名不能与访问域名相同')
    return
  }

  const config: SaasDeployConfig = {
    accessDomain: accessDomain.value,
    originMode: form.originMode,
    originDomain: form.originDomain.trim(),
    originIp: form.originMode === 'ip' ? form.originIp.trim() : undefined,
    preferredDomain: preferredDomainValue.value,
    // 用户已在表单选定 zone，直传避免按域名反查选错（父子 zone 并存场景）
    zoneId: form.zoneId,
  }

  deploying.value = true
  deployedInfo.value = null
  manualCnameHint.value = null
  resetSteps()
  try {
    const res = await deploySaas(config, applyProgress)
    deployedInfo.value = res.deployment
    if (res.manualCname) {
      manualCnameHint.value = {
        accessDomain: config.accessDomain,
        preferredDomain: config.preferredDomain,
      }
      toast.warning('部署完成，但需手动配置 CNAME', {
        description: `${config.accessDomain} → CNAME ${config.preferredDomain}`,
      })
    } else {
      toast.success('SaaS 优选部署完成', {
        description: `CNAME 已自动配置（${config.accessDomain} → ${config.preferredDomain}）`,
      })
    }
    // 刷新已部署列表，让新部署立即可见
    void loadDeployments()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 标记当前进行中的步骤为错误
    const idx = steps.value.findIndex((s) => s.status === 'running')
    if (idx >= 0) steps.value[idx].status = 'error'
    toast.error('部署失败', { description: msg })
  } finally {
    deploying.value = false
  }
}

/* -------------------------------------------------------------------------- */
/*                              Tab2 已部署列表                                */
/* -------------------------------------------------------------------------- */

const deployments = ref<SaasDeployment[]>([])
const listLoading = ref(false)
const deleteTarget = ref<SaasDeployment | null>(null)
const deleting = ref(false)

async function loadDeployments() {
  listLoading.value = true
  try {
    deployments.value = await listSaasDeployments()
  } catch (e) {
    toast.error('加载已部署列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    listLoading.value = false
  }
}

onMounted(loadDeployments)

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await removeSaas(deleteTarget.value.originDomain, deleteTarget.value.originZoneId, [deleteTarget.value.hostname])
    toast.success('已移除 SaaS 优选部署')
    deleteTarget.value = null
    await loadDeployments()
  } catch (e) {
    toast.error('移除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

/** 状态映射到 Badge：active=绿"正常"，pending=黄"待生效"，其他=灰 */
function statusVariant(status: string): 'default' | 'secondary' {
  return status === 'active' || status === 'pending' ? 'default' : 'secondary'
}
function statusText(status: string): string {
  if (status === 'active') return '正常'
  if (status === 'pending') return '待生效'
  if (status === 'moved') return '已迁移'
  return status || '—'
}
function statusClass(status: string): string {
  if (status === 'active') return 'bg-emerald-500/15 text-emerald-600'
  if (status === 'pending') return 'bg-amber-500/15 text-amber-600'
  return ''
}
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部说明卡片 -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Share2 class="size-5 text-primary" />
          SaaS 优选加速部署
        </CardTitle>
        <CardDescription>
          基于 Cloudflare for SaaS：在自有 zone 配置回退源，把访问域名作为 custom hostname 接入，
          CNAME 到优选域名实现加速。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
            <Cloud class="mt-0.5 size-4 text-primary" />
            <div>
              <div class="text-sm font-medium">回退源接入</div>
              <div class="text-xs text-muted-foreground">自有 zone 配置 fallback origin，原生 SaaS 能力</div>
            </div>
          </div>
          <div class="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
            <Link2 class="mt-0.5 size-4 text-primary" />
            <div>
              <div class="text-sm font-medium">访问域名加速</div>
              <div class="text-xs text-muted-foreground">第三方域名亦可接入，CNAME 到优选域名</div>
            </div>
          </div>
          <div class="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
            <ShieldCheck class="mt-0.5 size-4 text-primary" />
            <div>
              <div class="text-sm font-medium">凭据不落地</div>
              <div class="text-xs text-muted-foreground">API 凭据仅存浏览器，编排在前端完成</div>
            </div>
          </div>
        </div>
        <Alert variant="destructive">
          <TriangleAlert class="size-4" />
          <AlertTitle>防滥用声明</AlertTitle>
          <AlertDescription>
            本功能仅用于加速你拥有合法权限的源站。不得为赌博、钓鱼、诈骗、侵权等违法或违规站点提供加速、隐匿源站或规避溯源，
            亦不得用于规避 Cloudflare 滥用检测。源站内容与法律责任由部署者自负。
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>

    <Tabs default-value="new" class="w-full">
      <TabsList class="grid w-full max-w-md grid-cols-2">
        <TabsTrigger value="new">新建部署</TabsTrigger>
        <TabsTrigger value="list">已部署列表</TabsTrigger>
      </TabsList>

      <!-- Tab1 新建部署 -->
      <TabsContent value="new" class="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">部署配置</CardTitle>
            <CardDescription>填写访问域名与回源信息，基于 Cloudflare for SaaS 一键部署</CardDescription>
          </CardHeader>
          <CardContent class="space-y-5">
            <!-- 访问域名：前缀 + 主域名 -->
            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <Label>访问域名前缀</Label>
                <Input
                  v-model="form.prefix"
                  placeholder="www"
                  :disabled="!form.zoneId"
                />
                <p class="text-xs text-muted-foreground">留空或 @ 表示直接使用主域名（根域）</p>
              </div>
              <div class="space-y-2">
                <Label>访问域名主域名（zone）</Label>
                <Select v-model="form.zoneId">
                  <SelectTrigger class="w-full">
                    <SelectValue :placeholder="zonesLoading ? '加载中…' : '选择 zone'" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="z in zones" :key="z.id" :value="z.id">
                      {{ z.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div class="flex items-center gap-2 text-sm">
              <Globe class="size-4 text-muted-foreground" />
              <span class="text-muted-foreground">完整访问域名：</span>
              <Badge variant="secondary">{{ accessDomain || '—' }}</Badge>
            </div>

            <!-- 源站模式 -->
            <div class="space-y-2">
              <Label>源站模式</Label>
              <div class="flex gap-2">
                <Button
                  :variant="form.originMode === 'domain' ? 'default' : 'outline'"
                  size="sm"
                  @click="form.originMode = 'domain'"
                >
                  源站域名（已有域名）
                </Button>
                <Button
                  :variant="form.originMode === 'ip' ? 'default' : 'outline'"
                  size="sm"
                  @click="form.originMode = 'ip'"
                >
                  源站 IP（传统服务器）
                </Button>
              </div>
              <p class="text-xs text-muted-foreground">
                源站已有公网域名（非 CF 代理，如对象存储/CDN/自建服务器）选「源站域名」，无需填 IP；源站是传统服务器只有 IP 时选「源站 IP」。
              </p>
              <Alert variant="destructive" class="py-2">
                <AlertDescription class="text-xs">
                  源站域名不能是 CF Worker 或 CF 代理域名（解析到 CF IP），否则 CF 报 Error 1000。
                  源站是 CF Worker 请改用「一键加速」或直接给 Worker 绑自定义域。
                </AlertDescription>
              </Alert>
            </div>

            <!-- 回源域名 / 源站域名（label/placeholder/提示随模式变化） -->
            <div class="space-y-2">
              <Label>{{ originDomainLabel }}</Label>
              <Input v-model="form.originDomain" :placeholder="originDomainPlaceholder" />
              <p class="text-xs text-muted-foreground">{{ originDomainHint }}</p>
            </div>

            <!-- 源站 IP（仅 ip 模式显示） -->
            <div v-if="form.originMode === 'ip'" class="space-y-2">
              <Label>源站 IP</Label>
              <Input v-model="form.originIp" placeholder="1.1.1.1" />
              <p v-if="originIpInvalid" class="text-xs text-destructive">IP 格式不正确，支持 IPv4 / IPv6</p>
              <p v-else class="text-xs text-muted-foreground">回源域名 A/AAAA 记录将指向此 IP</p>
            </div>

            <!-- 优选域名 -->
            <div class="space-y-2">
              <Label>优选域名</Label>
              <Select v-model="form.preferredDomain">
                <SelectTrigger class="w-full">
                  <SelectValue placeholder="选择优选域名" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="d in PREFERRED_DOMAINS" :key="d" :value="d">
                    {{ d }}
                  </SelectItem>
                  <SelectItem value="__custom__">自定义…</SelectItem>
                </SelectContent>
              </Select>
              <Input
                v-if="customPreferredMode"
                v-model="form.customPreferred"
                placeholder="自定义优选域名（如 cdn.example.com）"
              />
              <p class="text-xs text-muted-foreground">访问域名 CNAME 指向此优选域名，保持 DNS only（灰云）</p>
            </div>

            <!-- 部署按钮 -->
            <div class="flex items-center gap-3 pt-2">
              <Button :disabled="deploying" @click="onDeploy">
                <Loader2 v-if="deploying" class="size-4 animate-spin" />
                <Share2 v-else class="size-4" />
                {{ deploying ? '部署中…' : '开始部署' }}
              </Button>
            </div>

            <!-- 进度 -->
            <div v-if="steps.length" class="space-y-3 rounded-lg border bg-muted/30 p-4">
              <div class="flex items-center justify-between text-sm">
                <span class="font-medium">部署进度</span>
                <span class="text-muted-foreground">{{ progress }}%</span>
              </div>
              <Progress :model-value="progress" />
              <ul class="space-y-1.5 text-sm">
                <li
                  v-for="(s, i) in steps"
                  :key="i"
                  class="flex items-center gap-2"
                >
                  <Loader2 v-if="s.status === 'running'" class="size-4 animate-spin text-primary" />
                  <span
                    v-else-if="s.status === 'done'"
                    class="size-4 inline-flex items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 text-[10px]"
                  >✓</span>
                  <span
                    v-else-if="s.status === 'error'"
                    class="size-4 inline-flex items-center justify-center rounded-full bg-destructive/15 text-destructive text-[10px]"
                  >!</span>
                  <span v-else class="size-4 inline-flex rounded-full border" />
                  <span :class="s.status === 'pending' ? 'text-muted-foreground' : ''">{{ s.label }}</span>
                </li>
              </ul>
            </div>

            <!-- 部署结果 -->
            <Alert v-if="deployedInfo" class="bg-emerald-500/5">
              <ShieldCheck class="size-4" />
              <AlertTitle>部署完成</AlertTitle>
              <AlertDescription class="space-y-1 text-xs">
                <div>访问域名：<code class="rounded bg-muted px-1.5 py-0.5">{{ deployedInfo.hostname }}</code></div>
                <div>回源域名：<code class="rounded bg-muted px-1.5 py-0.5">{{ deployedInfo.originDomain }}</code></div>
                <div>所属 zone：<code class="rounded bg-muted px-1.5 py-0.5">{{ deployedInfo.zoneName }}</code></div>
                <div>状态：{{ statusText(deployedInfo.status) }} · SSL：{{ deployedInfo.sslStatus }}</div>
              </AlertDescription>
            </Alert>

            <!-- 手动 CNAME 提示 -->
            <Alert v-if="manualCnameHint" variant="destructive">
              <AlertCircle class="size-4" />
              <AlertTitle>需手动配置 CNAME</AlertTitle>
              <AlertDescription>
                访问域名不在当前账号下，请前往该域名 DNS 服务商，将
                <code class="rounded bg-muted px-1.5 py-0.5">{{ manualCnameHint.accessDomain }}</code>
                CNAME 指向
                <code class="rounded bg-muted px-1.5 py-0.5">{{ manualCnameHint.preferredDomain }}</code>
                （保持 DNS only（灰云），在第三方 DNS 服务商直接添加普通 CNAME 记录即可）。
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Tab2 已部署列表 -->
      <TabsContent value="list" class="space-y-4">
        <Card>
          <CardHeader class="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle class="text-base">已部署列表</CardTitle>
              <CardDescription>聚合账号下所有 zone 的 custom hostnames（SaaS 优选接入记录）</CardDescription>
            </div>
            <Button variant="outline" size="sm" :disabled="listLoading" @click="loadDeployments">
              <RefreshCw v-if="listLoading" class="size-4 animate-spin" />
              <RefreshCw v-else class="size-4" />
              刷新
            </Button>
          </CardHeader>
          <CardContent>
            <div v-if="listLoading" class="py-10 text-center text-sm text-muted-foreground">
              <Loader2 class="mx-auto mb-2 size-5 animate-spin" />
              正在加载已部署列表…
            </div>
            <div v-else-if="!deployments.length" class="py-10 text-center text-sm text-muted-foreground">
              暂未发现 SaaS 优选部署，去「新建部署」接入一个吧
            </div>
            <div v-else class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b text-left text-xs text-muted-foreground">
                    <th class="px-3 py-2 font-medium">访问域名</th>
                    <th class="px-3 py-2 font-medium">回源域名</th>
                    <th class="px-3 py-2 font-medium">所属 zone</th>
                    <th class="px-3 py-2 font-medium">状态</th>
                    <th class="px-3 py-2 font-medium">SSL</th>
                    <th class="px-3 py-2 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr v-for="(item, i) in deployments" :key="i" class="hover:bg-muted/30">
                    <td class="px-3 py-2 font-medium">{{ item.hostname }}</td>
                    <td class="px-3 py-2 text-muted-foreground">{{ item.originDomain || '—' }}</td>
                    <td class="px-3 py-2 text-muted-foreground">{{ item.zoneName }}</td>
                    <td class="px-3 py-2">
                      <Badge :variant="statusVariant(item.status)" :class="statusClass(item.status)">
                        {{ statusText(item.status) }}
                      </Badge>
                    </td>
                    <td class="px-3 py-2 text-muted-foreground">{{ item.sslStatus || '—' }}</td>
                    <td class="px-3 py-2 text-right">
                      <Button variant="ghost" size="icon-sm" @click="deleteTarget = item">
                        <Trash2 class="size-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- 删除确认 -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = null }">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认移除 SaaS 优选部署</DialogTitle>
          <DialogDescription>
            将删除访问域名
            <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ deleteTarget?.hostname }}</code>
            的 custom hostname 及其 CNAME；若该 zone 下已无其他接入，将一并清理回退源与回源 DNS 记录。
            此操作不可撤销，源站不受影响。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" :disabled="deleting" @click="deleteTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deleting" @click="confirmDelete">
            <Loader2 v-if="deleting" class="size-4 animate-spin" />
            <Trash2 v-else class="size-4" />
            确认移除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
