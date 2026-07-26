<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Zap, Globe, Rocket, Trash2, RefreshCw, Loader2, ShieldCheck, Link2, TriangleAlert } from '@lucide/vue'
import { zonesApi } from '@/api/zones'
import {
  DEFAULT_ORIGIN_DOMAIN,
  PREFERRED_ORIGIN_DOMAINS,
  deployAccelerate,
  detectAccelerated,
  generateWorkerName,
  listAcceleratedZones,
  removeAccelerate,
  type AccelerateConfig,
  type AcceleratedZone,
  type DeployProgress,
} from '@/api/accelerate'
import type { Zone } from '@/types/cloudflare'
import WorkerScriptPreview from './WorkerScriptPreview.vue'

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
/*                                Tab1 新建加速                                */
/* -------------------------------------------------------------------------- */

const form = reactive({
  zoneId: '' as string,
  host: '', // zone 下的主机名，如 www 或 @
  originUrl: '',
  cacheTtl: 60,
  originDomain: DEFAULT_ORIGIN_DOMAIN,
  customOrigin: '',
  workerName: '',
})

const customOriginMode = computed(() => form.originDomain === '__custom__')

/** 拼出完整访问域名 */
const accessDomain = computed(() => {
  const zone = zones.value.find((z) => z.id === form.zoneId)
  if (!zone) return ''
  const host = form.host.trim()
  if (!host || host === '@') return zone.name
  return `${host}.${zone.name}`
})

// 访问域名变化时自动生成 Worker 名称（用户未手动改过时跟随）
let workerNameTouched = false
watch(accessDomain, (d) => {
  if (d && !workerNameTouched) form.workerName = generateWorkerName(d)
})

function onWorkerNameInput() {
  // 清空时复位 touched，恢复按访问域名自动生成
  if (!form.workerName.trim()) {
    workerNameTouched = false
    if (accessDomain.value) form.workerName = generateWorkerName(accessDomain.value)
  } else {
    workerNameTouched = true
  }
}

const originDomainValue = computed(() =>
  customOriginMode.value ? form.customOrigin.trim() : form.originDomain,
)

interface StepState {
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
}
const steps = ref<StepState[]>([])
const progress = ref(0)
const deploying = ref(false)
const deployedUrl = ref('')

function resetSteps() {
  steps.value = [
    { label: '上传 Worker 脚本', status: 'pending' },
    { label: '配置 Worker 路由与 CNAME', status: 'pending' },
    { label: '完成', status: 'pending' },
  ]
  progress.value = 0
}

function applyProgress(p: DeployProgress) {
  const idx = p.step === 'upload' ? 0 : p.step === 'dns' ? 1 : 2
  // 标记之前步骤为完成
  for (let i = 0; i < idx; i++) {
    if (steps.value[i].status !== 'error') steps.value[i].status = 'done'
  }
  if (p.ok) {
    steps.value[idx].status = p.step === 'done' ? 'done' : 'running'
  } else {
    steps.value[idx].status = 'error'
  }
  progress.value = Math.min(100, Math.round(((idx + (p.step === 'done' ? 1 : 0.5)) / 3) * 100))
  // 展示编排层带出的步骤消息；步骤失败用 warning 暴露原因，避免「步骤打叉但 toast 报成功」
  if (!p.ok) {
    toast.warning(p.message || '部署步骤出现问题')
    return
  }
  if (p.step === 'upload') toast.info(p.message || '正在上传 Worker 脚本…')
  else if (p.step === 'dns') toast.info(p.message || '正在配置 DNS 与路由…')
  else if (p.step === 'done') toast.success(p.message || '加速部署完成')
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
  // 主机名仅允许单级前缀（字母/数字/连字符），防止误填完整域名拼出 www.example.com.example.com
  const host = form.host.trim()
  if (host && host !== '@' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(host)) {
    toast.error('主机名格式不正确', { description: '仅支持单级前缀（字母/数字/连字符），不要填完整域名' })
    return
  }
  // 源站 URL 用 URL 解析校验，仅接受 http/https
  try {
    const u = new URL(form.originUrl.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
  } catch {
    toast.error('源站域名格式不正确', { description: '需为完整 URL，如 https://origin.example.com' })
    return
  }
  if (customOriginMode.value && !form.customOrigin.trim()) {
    toast.error('请填写自定义优选回源域名')
    return
  }
  const workerName = form.workerName.trim()
  if (!workerName) {
    toast.error('请填写 Worker 名称')
    return
  }
  if (!/^[a-z0-9_-]{1,63}$/.test(workerName)) {
    toast.error('Worker 名称格式不正确', { description: '仅支持小写字母、数字、连字符与下划线，且不超过 63 字符' })
    return
  }

  const config: AccelerateConfig = {
    accessDomain: accessDomain.value,
    originUrl: form.originUrl.trim(),
    cacheTtl: Number(form.cacheTtl) || 0,
    originDomain: originDomainValue.value || DEFAULT_ORIGIN_DOMAIN,
    workerName,
    // 用户已在表单选定 zone，直传避免按域名反查选错（父子 zone 并存场景）
    zoneId: form.zoneId,
  }

  deploying.value = true
  deployedUrl.value = ''
  resetSteps()
  try {
    const res = await deployAccelerate(config, applyProgress)
    deployedUrl.value = `https://${config.accessDomain}`
    toast.success('一键加速部署完成', {
      description: `Worker ${res.workerName} · CNAME → ${config.originDomain}`,
    })
    // 刷新已加速列表，让新部署立即可见
    void detect()
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
/*                              Tab2 已加速域名                                */
/* -------------------------------------------------------------------------- */

const accelerated = ref<AcceleratedZone[]>([])
const detecting = ref(false)
const deleteTarget = ref<AcceleratedZone | null>(null)
const deleting = ref(false)

async function detect() {
  detecting.value = true
  try {
    const zlist = await listAcceleratedZones()
    accelerated.value = await detectAccelerated(zlist)
  } catch (e) {
    toast.error('探测已加速域名失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    detecting.value = false
  }
}

onMounted(detect)

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await removeAccelerate(deleteTarget.value.zone.id, deleteTarget.value.record.id, deleteTarget.value.workerName)
    toast.success('已移除加速配置')
    deleteTarget.value = null
    await detect()
  } catch (e) {
    toast.error('移除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

/** 从 CNAME 记录提取源站信息（脚本预览中的源站 URL 不可反查，仅展示访问域名） */
function originHint(item: AcceleratedZone): string {
  return item.record.content
}
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部说明卡片 -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Zap class="size-5 text-primary" />
          一键网站加速
        </CardTitle>
        <CardDescription>
          本面板的核心创新功能：自动部署一个回源 Worker 脚本到 Cloudflare 边缘网络，
          并为访问域名配置 CNAME 指向优选回源域名，实现全站加速。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
            <Rocket class="mt-0.5 size-4 text-primary" />
            <div>
              <div class="text-sm font-medium">Worker 回源</div>
              <div class="text-xs text-muted-foreground">边缘节点反向代理到源站，可选 Cache API 缓存</div>
            </div>
          </div>
          <div class="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
            <Link2 class="mt-0.5 size-4 text-primary" />
            <div>
              <div class="text-sm font-medium">优选回源域名</div>
              <div class="text-xs text-muted-foreground">CNAME 指向 cdn.cnno.de 等优选入口</div>
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
        <TabsTrigger value="new">新建加速</TabsTrigger>
        <TabsTrigger value="list">已加速域名</TabsTrigger>
      </TabsList>

      <!-- Tab1 新建加速 -->
      <TabsContent value="new" class="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">加速配置</CardTitle>
            <CardDescription>填写访问域名与源站信息，一键部署回源 Worker</CardDescription>
          </CardHeader>
          <CardContent class="space-y-5">
            <!-- 访问域名 -->
            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <Label>访问域名所在 Zone</Label>
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
              <div class="space-y-2">
                <Label>主机名（留空 = 根域）</Label>
                <Input
                  v-model="form.host"
                  placeholder="如 www 或 api，留空使用根域"
                  :disabled="!form.zoneId"
                />
              </div>
            </div>

            <div class="flex items-center gap-2 text-sm">
              <Globe class="size-4 text-muted-foreground" />
              <span class="text-muted-foreground">完整访问域名：</span>
              <Badge variant="secondary">{{ accessDomain || '—' }}</Badge>
            </div>

            <!-- 源站 -->
            <div class="space-y-2">
              <Label>源站域名</Label>
              <Input v-model="form.originUrl" placeholder="https://origin.example.com" />
              <p class="text-xs text-muted-foreground">Worker 将请求回源到此地址，需以 http:// 或 https:// 开头</p>
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <Label>缓存时间（秒）</Label>
                <Input v-model.number="form.cacheTtl" type="number" min="0" placeholder="0 = 不缓存" />
                <p class="text-xs text-muted-foreground">使用 Cache API 在边缘缓存，0 表示每次回源</p>
              </div>
              <div class="space-y-2">
                <Label>优选回源域名</Label>
                <Select v-model="form.originDomain">
                  <SelectTrigger class="w-full">
                    <SelectValue placeholder="选择优选域名" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="d in PREFERRED_ORIGIN_DOMAINS" :key="d" :value="d">
                      {{ d }}
                    </SelectItem>
                    <SelectItem value="__custom__">自定义…</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  v-if="customOriginMode"
                  v-model="form.customOrigin"
                  placeholder="自定义优选回源域名"
                />
              </div>
            </div>

            <div class="space-y-2">
              <Label>Worker 名称</Label>
              <Input
                :model-value="form.workerName"
                @update:model-value="(v: string | number) => { form.workerName = String(v); onWorkerNameInput() }"
                placeholder="accel-xxx"
              />
              <p class="text-xs text-muted-foreground">默认按访问域名自动生成，可修改</p>
            </div>

            <!-- 脚本预览 -->
            <WorkerScriptPreview
              v-if="form.originUrl"
              :origin-url="form.originUrl"
              :cache-ttl="Number(form.cacheTtl) || 0"
            />

            <!-- 部署按钮 -->
            <div class="flex items-center gap-3 pt-2">
              <Button :disabled="deploying" @click="onDeploy">
                <Loader2 v-if="deploying" class="size-4 animate-spin" />
                <Zap v-else class="size-4" />
                {{ deploying ? '部署中…' : '开始部署' }}
              </Button>
              <span v-if="deployedUrl" class="text-sm">
                访问地址：
                <a :href="deployedUrl" target="_blank" class="text-primary hover:underline">{{ deployedUrl }}</a>
              </span>
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
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Tab2 已加速域名 -->
      <TabsContent value="list" class="space-y-4">
        <Card>
          <CardHeader class="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle class="text-base">已加速域名</CardTitle>
              <CardDescription>扫描账号下所有 zone 的 CNAME 匹配优选回源域名 + 校验 Worker 存在</CardDescription>
            </div>
            <Button variant="outline" size="sm" :disabled="detecting" @click="detect">
              <RefreshCw v-if="detecting" class="size-4 animate-spin" />
              <RefreshCw v-else class="size-4" />
              刷新
            </Button>
          </CardHeader>
          <CardContent>
            <div v-if="detecting" class="py-10 text-center text-sm text-muted-foreground">
              <Loader2 class="mx-auto mb-2 size-5 animate-spin" />
              正在扫描已加速域名…
            </div>
            <div v-else-if="!accelerated.length" class="py-10 text-center text-sm text-muted-foreground">
              暂未探测到已加速域名，去「新建加速」部署一个吧
            </div>
            <div v-else class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b text-left text-xs text-muted-foreground">
                    <th class="px-3 py-2 font-medium">访问域名</th>
                    <th class="px-3 py-2 font-medium">CNAME 目标</th>
                    <th class="px-3 py-2 font-medium">Worker</th>
                    <th class="px-3 py-2 font-medium">状态</th>
                    <th class="px-3 py-2 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr v-for="(item, i) in accelerated" :key="i" class="hover:bg-muted/30">
                    <td class="px-3 py-2 font-medium">{{ item.record.name }}</td>
                    <td class="px-3 py-2 text-muted-foreground">{{ originHint(item) }}</td>
                    <td class="px-3 py-2">
                      <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ item.workerName }}</code>
                    </td>
                    <td class="px-3 py-2">
                      <Badge v-if="item.accelerated" variant="default" class="bg-emerald-500/15 text-emerald-600">正常</Badge>
                      <Badge v-else variant="secondary">Worker 缺失</Badge>
                    </td>
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
          <DialogTitle>确认移除加速</DialogTitle>
          <DialogDescription>
            将删除访问域名
            <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ deleteTarget?.record.name }}</code>
            的 CNAME 记录、Worker 路由以及 Worker 脚本
            <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ deleteTarget?.workerName }}</code>。
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
