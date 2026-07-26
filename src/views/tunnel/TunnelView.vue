<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import {
  Activity,
  Copy,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from '@lucide/vue'
import { tunnelApi, type Tunnel, type TunnelConnection, type IngressRule, type TunnelConfigBody } from '@/api/tunnel'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
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
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/* ---------- 列表 ---------- */
const tunnels = ref<Tunnel[]>([])
const loading = ref(true)

/* ---------- 创建 ---------- */
const createOpen = ref(false)
const createName = ref('')
const creating = ref(false)
const createdToken = ref<string | null>(null)
const createdName = ref<string>('')

/* ---------- 详情对话框 ---------- */
const connTarget = ref<Tunnel | null>(null)
const connList = ref<TunnelConnection[]>([])
const connLoading = ref(false)

const cfgTarget = ref<Tunnel | null>(null)
const cfgLoading = ref(false)

/* ---------- 删除 ---------- */
const deleteTarget = ref<Tunnel | null>(null)
const deleting = ref(false)

async function load() {
  loading.value = true
  try {
    tunnels.value = await tunnelApi.listTunnels()
  } catch (e) {
    toast.error('加载 Tunnel 列表失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate() {
  createName.value = ''
  createdToken.value = null
  createdName.value = ''
  createOpen.value = true
}

async function submitCreate() {
  if (!createName.value.trim()) {
    toast.error('请填写 Tunnel 名称')
    return
  }
  creating.value = true
  try {
    const t = await tunnelApi.createTunnel(createName.value.trim())
    createdName.value = t.name
    // 创建响应不含 token，需单独调 token 端点获取
    createdToken.value = await tunnelApi.getTunnelToken(t.id)
    toast.success('Tunnel 已创建，请复制 token 配置 cloudflared')
    await load()
  } catch (e) {
    toast.error('创建 Tunnel 失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creating.value = false
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('已复制到剪贴板')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

async function viewConnections(t: Tunnel) {
  connTarget.value = t
  connList.value = []
  connLoading.value = true
  try {
    connList.value = await tunnelApi.getConnections(t.id)
  } catch (e) {
    toast.error('获取连接信息失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    connLoading.value = false
  }
}

async function viewConfig(t: Tunnel) {
  cfgTarget.value = t
  cfgLoading.value = true
  cfgLoadFailed.value = false
  editingRoutes.value = []
  loadedConfig.value = null
  try {
    // 从未配置过的隧道返回 null / config 为 null
    const cfg = await tunnelApi.getConfig(t.id)
    loadedConfig.value = cfg?.config ?? null
    const rules = loadedConfig.value?.ingress?.length
      ? loadedConfig.value.ingress
      : [{ service: 'http_status:404' }]
    editingRoutes.value = rules.map(parseService)
  } catch (e) {
    // 加载失败时禁用编辑与保存，避免用空配置覆盖线上已有配置
    cfgLoadFailed.value = true
    toast.error('获取配置失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    cfgLoading.value = false
  }
}

/* ---------- 公开应用程序路由编辑 ---------- */
// 编辑态：把 service 拆成 协议+地址+端口 三段，贴 CF 官方 Public Hostname 表单体验
interface EditableRoute {
  hostname: string
  protocol: string
  address: string
  port: string
  /** 是否为 catch-all（无 hostname，仅 service 兜底，如 http_status:404） */
  isCatchAll: boolean
  /** catch-all 原始 service 文本 */
  catchAllService: string
  /** 原始 ingress 规则对象（新增路由为 null）；保存时仅覆盖 hostname/service，path/originRequest 等字段原样保留 */
  original: IngressRule | null
}

const PROTOCOLS = ['http://', 'https://', 'tcp://', 'ssh://', 'unix:', 'http_status:']

/** 把 ingress 规则解析为可编辑态（保留原始规则对象，保存时透传未编辑字段） */
function parseService(r: IngressRule): EditableRoute {
  const hostname = r.hostname ?? ''
  const service = (r.service ?? '').trim()
  if (!hostname) {
    // catch-all（无 hostname）
    return { hostname: '', protocol: '', address: '', port: '', isCatchAll: true, catchAllService: service, original: r }
  }
  // 尝试解析 协议://地址:端口
  const m = service.match(/^(https?|tcp|ssh):\/\/([^:\/]+)(?::(\d+))?/)
  if (m) {
    return { hostname, protocol: `${m[1]}://`, address: m[2], port: m[3] ?? '', isCatchAll: false, catchAllService: service, original: r }
  }
  // 解析失败（unix:/http_status: 等非标准），整体塞 address
  return { hostname, protocol: '', address: service, port: '', isCatchAll: false, catchAllService: service, original: r }
}

/** 把可编辑态拼回 service 字符串 */
function buildService(r: EditableRoute): string {
  if (r.isCatchAll) return r.catchAllService.trim() || 'http_status:404'
  if (r.protocol === 'unix:' || r.protocol === 'http_status:') return r.address.trim()
  const addr = r.address.trim() || 'localhost'
  const port = r.port.trim() ? `:${r.port.trim()}` : ''
  return `${r.protocol}${addr}${port}`
}

const editingRoutes = ref<EditableRoute[]>([])
const cfgSaving = ref(false)
/** 加载时的原始 config（保存时透传 warp-routing/originRequest 等顶层字段） */
const loadedConfig = ref<TunnelConfigBody | null>(null)
/** 配置加载失败时禁用「添加路由/保存」，防止覆盖线上配置 */
const cfgLoadFailed = ref(false)

function addRoute() {
  const routes = [...editingRoutes.value]
  routes.splice(routes.length - 1, 0, {
    hostname: '',
    protocol: 'http://',
    address: 'localhost',
    port: '8080',
    isCatchAll: false,
    catchAllService: '',
    original: null,
  })
  editingRoutes.value = routes
}

function removeRoute(idx: number) {
  editingRoutes.value.splice(idx, 1)
}

/** 校验路由集 */
function validateRoutes(routes: EditableRoute[]): string | null {
  if (!routes.length) return '至少需要一条 catch-all 兜底规则'
  for (let i = 0; i < routes.length - 1; i++) {
    const r = routes[i]
    if (!r.hostname.trim()) return `第 ${i + 1} 条规则缺少公开域名`
    if (!r.address.trim()) return `第 ${i + 1} 条规则缺少服务地址`
  }
  const last = routes[routes.length - 1]
  if (!last.isCatchAll) return '末条须为无公开域名的 catch-all 兜底规则'
  return null
}

async function saveConfig() {
  if (!cfgTarget.value) return
  const err = validateRoutes(editingRoutes.value)
  if (err) {
    toast.error('配置校验失败', { description: err })
    return
  }
  cfgSaving.value = true
  try {
    // 基于原始规则对象仅覆盖 hostname/service，path/originRequest 等字段原样保留
    const ingress = editingRoutes.value.map((r) => {
      const base: IngressRule = r.original ? { ...r.original } : {} as IngressRule
      if (r.isCatchAll) {
        delete base.hostname
      } else {
        base.hostname = r.hostname.trim()
      }
      base.service = buildService(r)
      return base
    }).filter((r) => r.service)
    // 顶层 config 的其他字段（warp-routing、originRequest 等）原样透传
    await tunnelApi.putConfig(cfgTarget.value.id, { ...(loadedConfig.value ?? {}), ingress })
    toast.success('配置已保存，cloudflared 下次连接即生效')
    await viewConfig(cfgTarget.value)
  } catch (e) {
    toast.error('保存配置失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    cfgSaving.value = false
  }
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await tunnelApi.deleteTunnel(deleteTarget.value.id)
    toast.success('已删除 Tunnel')
    deleteTarget.value = null
    await load()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deleting.value = false
  }
}

function statusVariant(status: string) {
  if (status === 'healthy') return 'default' as const
  if (status === 'down') return 'destructive' as const
  return 'secondary' as const
}

function fmtDate(s: string | undefined): string {
  if (!s) return '-'
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return s
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">Tunnel 隧道</h1>
        <p class="text-sm text-muted-foreground">管理 Cloudflare Tunnel，安全地将内网服务暴露到公网</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
        <Button size="sm" @click="openCreate">
          <Plus class="size-4" />
          新建 Tunnel
        </Button>
      </div>
    </div>

    <!-- 列表 -->
    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-16 w-full" />
    </div>

    <Card v-else-if="!tunnels.length" class="border-dashed">
      <CardContent class="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Network class="size-6" />
        </div>
        <div class="font-medium">还没有 Tunnel</div>
        <p class="text-sm text-muted-foreground">新建一个 Tunnel，使用 cloudflared 连接内网服务</p>
        <Button size="sm" @click="openCreate">
          <Plus class="size-4" />
          新建 Tunnel
        </Button>
      </CardContent>
    </Card>

    <Card v-else>
      <CardContent class="p-0">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th class="px-4 py-3 font-medium">名称</th>
                <th class="px-4 py-3 font-medium">Tunnel ID</th>
                <th class="px-4 py-3 font-medium">状态</th>
                <th class="px-4 py-3 font-medium">创建时间</th>
                <th class="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="t in tunnels"
                :key="t.id"
                class="border-b last:border-0 hover:bg-muted/40"
              >
                <td class="px-4 py-3 font-medium">{{ t.name }}</td>
                <td class="max-w-[220px] truncate px-4 py-3 font-mono text-xs text-muted-foreground">{{ t.id }}</td>
                <td class="px-4 py-3">
                  <Badge :variant="statusVariant(t.status)">{{ t.status }}</Badge>
                </td>
                <td class="px-4 py-3 text-muted-foreground">{{ fmtDate(t.created_at) }}</td>
                <td class="px-4 py-3">
                  <div class="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" title="查看连接" @click="viewConnections(t)">
                      <Activity class="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="查看配置" @click="viewConfig(t)">
                      <Settings2 class="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:text-destructive"
                      title="删除"
                      @click="deleteTarget = t"
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

    <!-- 创建 / 展示 token（token 仅显示一次：展示阶段禁止 ESC/点击遮罩误关，只能点按钮关闭） -->
    <Dialog v-model:open="createOpen">
      <DialogContent
        class="sm:max-w-lg"
        :show-close-button="!createdToken"
        @escape-key-down="(e) => { if (createdToken) e.preventDefault() }"
        @interact-outside="(e) => { if (createdToken) e.preventDefault() }"
      >
        <DialogHeader>
          <DialogTitle>新建 Tunnel</DialogTitle>
          <DialogDescription>
            Cloudflare 会自动生成 tunnel secret。创建后请立即复制 token，<strong>该 token 仅显示一次</strong>。
          </DialogDescription>
        </DialogHeader>

        <template v-if="!createdToken">
          <div class="space-y-1.5">
            <Label for="tunnel-name">Tunnel 名称</Label>
            <Input
              id="tunnel-name"
              v-model="createName"
              placeholder="my-tunnel"
              class="font-mono"
              autocomplete="off"
            />
            <p class="text-xs text-muted-foreground">用于标识该 Tunnel，建议与用途相关</p>
          </div>
          <DialogFooter>
            <Button variant="outline" @click="createOpen = false">取消</Button>
            <Button :disabled="creating || !createName.trim()" @click="submitCreate">
              {{ creating ? '创建中…' : '创建' }}
            </Button>
          </DialogFooter>
        </template>

        <template v-else>
          <div class="space-y-4">
            <div class="space-y-1.5">
              <Label>Tunnel 名称</Label>
              <div class="font-mono text-sm">{{ createdName }}</div>
            </div>
            <div class="space-y-1.5">
              <Label>Tunnel Token</Label>
              <div class="flex items-center gap-2">
                <Input :model-value="createdToken" readonly class="font-mono text-xs" />
                <Button size="icon" variant="outline" @click="copy(createdToken!)">
                  <Copy class="size-4" />
                </Button>
              </div>
            </div>
            <div class="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              在运行 cloudflared 的机器上执行：
              <code class="mt-1 block rounded bg-background px-2 py-1 font-mono">cloudflared tunnel run --token {{ createdToken?.slice(0, 24) }}…</code>
              或写入配置文件 credentials 引用。详细文档参见 Cloudflare 官方指引。
            </div>
          </div>
          <DialogFooter>
            <Button @click="createOpen = false">完成</Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>

    <!-- 连接信息 -->
    <Dialog :open="!!connTarget" @update:open="(v) => !v && (connTarget = null)">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>连接信息 · {{ connTarget?.name }}</DialogTitle>
          <DialogDescription>当前活跃的 cloudflared 连接</DialogDescription>
        </DialogHeader>
        <div v-if="connLoading" class="space-y-2">
          <Skeleton v-for="i in 2" :key="i" class="h-10 w-full" />
        </div>
        <div v-else-if="!connList.length" class="py-8 text-center text-sm text-muted-foreground">
          暂无活跃连接。请确认 cloudflared 已用 token 启动。
        </div>
        <ScrollArea v-else class="max-h-72">
          <div class="space-y-2 pr-2">
            <div
              v-for="c in connList"
              :key="c.id"
              class="rounded-md border p-3 text-xs"
            >
              <div class="flex items-center justify-between">
                <span class="font-mono text-muted-foreground">{{ c.id }}</span>
                <Badge variant="secondary">{{ c.colo_name }}</Badge>
              </div>
              <div class="mt-2 grid grid-cols-2 gap-1 text-muted-foreground">
                <div>来源 IP：{{ c.origin_ip }}</div>
                <div>连接时间：{{ fmtDate(c.opened_at) }}</div>
              </div>
            </div>
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" @click="connTarget = null">关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 配置（可编辑 ingress 规则） -->
    <Dialog :open="!!cfgTarget" @update:open="(v) => !v && (cfgTarget = null)">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>配置 · {{ cfgTarget?.name }}</DialogTitle>
          <DialogDescription>
            配置公开应用程序路由：把公开域名转发到本地服务（如
            <code class="rounded bg-muted px-1 font-mono text-xs">http://localhost:8080</code>）。末条为 catch-all 兜底。
          </DialogDescription>
        </DialogHeader>
        <div v-if="cfgLoading" class="space-y-2">
          <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
        </div>
        <ScrollArea v-else class="max-h-[60vh]">
          <div class="space-y-2 pr-2">
            <div
              v-for="(r, i) in editingRoutes"
              :key="i"
              class="rounded-md border p-3"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-muted-foreground">
                  路由 {{ i + 1 }}
                  <Badge v-if="r.isCatchAll" variant="secondary" class="ml-1">catch-all 兜底</Badge>
                </span>
                <Button
                  v-if="!r.isCatchAll"
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground hover:text-destructive"
                  @click="removeRoute(i)"
                >
                  <Trash2 class="size-4" />
                </Button>
              </div>

              <!-- 普通路由：公开域名 + 服务(协议/地址/端口) -->
              <template v-if="!r.isCatchAll">
                <div class="mt-2 space-y-1">
                  <Label class="text-xs">公开域名</Label>
                  <Input
                    v-model="r.hostname"
                    placeholder="app.example.com"
                    class="h-8 text-xs"
                  />
                </div>
                <div class="mt-2 grid gap-2 sm:grid-cols-[110px_1fr_90px]">
                  <div class="space-y-1">
                    <Label class="text-xs">协议</Label>
                    <Select v-model="r.protocol">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="p in PROTOCOLS" :key="p" :value="p">{{ p }}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="space-y-1">
                    <Label class="text-xs">服务地址</Label>
                    <Input
                      v-model="r.address"
                      :placeholder="r.protocol === 'unix:' ? '/var/run/app.sock' : 'localhost'"
                      class="h-8 text-xs font-mono"
                    />
                  </div>
                  <div v-if="r.protocol !== 'unix:' && r.protocol !== 'http_status:'" class="space-y-1">
                    <Label class="text-xs">端口</Label>
                    <Input
                      v-model="r.port"
                      placeholder="8080"
                      class="h-8 text-xs font-mono"
                    />
                  </div>
                </div>
              </template>

              <!-- catch-all：仅一个 service 文本 -->
              <div v-else class="mt-2 space-y-1">
                <Label class="text-xs">兜底响应 service</Label>
                <Input
                  v-model="r.catchAllService"
                  placeholder="http_status:404"
                  class="h-8 text-xs font-mono"
                />
              </div>
            </div>
            <Button variant="outline" size="sm" class="w-full" :disabled="cfgLoadFailed" @click="addRoute">
              <Plus class="size-4" />
              添加公开域名路由
            </Button>
          </div>
        </ScrollArea>
        <div class="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
          每条路由把一个公开域名转发到本地服务：协议选 http、地址填 localhost、端口填 8080，即等效
          <code class="font-mono">http://localhost:8080</code>。末条 catch-all 兜底未命中请求（建议
          <code class="font-mono">http_status:404</code>）。保存后 cloudflared 重新连接即生效。
        </div>
        <DialogFooter>
          <Button variant="outline" @click="cfgTarget = null">取消</Button>
          <Button :disabled="cfgSaving || cfgLoading || cfgLoadFailed" @click="saveConfig">
            {{ cfgSaving ? '保存中…' : '保存配置' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 删除确认 -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => !v && (deleteTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 Tunnel</DialogTitle>
          <DialogDescription>
            确定删除 Tunnel <code class="rounded bg-muted px-1 font-mono">{{ deleteTarget?.name }}</code>？
            删除前请先停止所有 cloudflared 连接，该操作不可撤销。
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
