<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2, Mail, Plus, RefreshCw, Trash2 } from '@lucide/vue'
import { emailApi, CFError } from '@/api'
import type { EmailDestinationAddress, EmailRoutingRule, EmailRoutingSettings } from '@/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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

const props = defineProps<{ zoneId: string; zoneName?: string }>()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const settings = ref<EmailRoutingSettings | null>(null)
const settingsLoading = ref(false)
const settingsError = ref('')
const toggling = ref(false)

const rules = ref<EmailRoutingRule[]>([])
const rulesLoading = ref(false)
const rulesError = ref('')

const addresses = ref<EmailDestinationAddress[]>([])
const addressesLoading = ref(false)
const addressesError = ref('')
const newAddress = ref('')
const addingAddress = ref(false)
const deleteAddressTarget = ref<EmailDestinationAddress | null>(null)
const deletingAddress = ref(false)

const addRuleOpen = ref(false)
const creatingRule = ref(false)
const ruleForm = ref({
  local: '',
  dest: '',
  action: 'forward' as 'forward' | 'drop',
})
const deleteRuleTarget = ref<EmailRoutingRule | null>(null)
const deletingRule = ref(false)

async function loadSettings() {
  if (!props.zoneId) return
  settingsLoading.value = true
  settingsError.value = ''
  try {
    settings.value = await emailApi.getSettings(props.zoneId)
  } catch (e) {
    if (e instanceof CFError && e.status === 404) {
      settings.value = { enabled: false }
    } else {
      settingsError.value = e instanceof Error ? e.message : String(e)
      settings.value = null
    }
  } finally {
    settingsLoading.value = false
  }
}

async function loadRules() {
  if (!props.zoneId) return
  rulesLoading.value = true
  rulesError.value = ''
  try {
    rules.value = await emailApi.listRules(props.zoneId)
  } catch (e) {
    if (e instanceof CFError && e.status === 404) {
      rules.value = []
    } else {
      rulesError.value = e instanceof Error ? e.message : String(e)
      rules.value = []
    }
  } finally {
    rulesLoading.value = false
  }
}

async function loadAddresses() {
  addressesLoading.value = true
  addressesError.value = ''
  try {
    addresses.value = await emailApi.listAddresses()
  } catch (e) {
    addressesError.value = e instanceof Error ? e.message : String(e)
    addresses.value = []
  } finally {
    addressesLoading.value = false
  }
}

async function reload() {
  await Promise.all([loadSettings(), loadRules(), loadAddresses()])
}

watch(() => props.zoneId, reload)
onMounted(reload)

const enabled = computed(() => !!settings.value?.enabled)
const canAddRule = computed(() => enabled.value && !!props.zoneName)

function isVerified(a: EmailDestinationAddress): boolean {
  return a.verified != null && a.verified !== ''
}

async function toggleEnabled(v: boolean) {
  if (!props.zoneId || toggling.value) return
  toggling.value = true
  try {
    settings.value = v ? await emailApi.enable(props.zoneId) : await emailApi.disable(props.zoneId)
    toast.success(v ? '已启用 Email Routing（请确认 MX 已指向 Cloudflare）' : '已停用 Email Routing')
    await loadRules()
  } catch (e) {
    toast.error(v ? '启用失败' : '停用失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    toggling.value = false
  }
}

async function addDest() {
  const email = newAddress.value.trim().toLowerCase()
  if (!EMAIL_RE.test(email)) {
    toast.error('请输入合法邮箱')
    return
  }
  addingAddress.value = true
  try {
    await emailApi.addAddress(email)
    toast.success('已添加，请到该邮箱完成验证后才能用于转发')
    newAddress.value = ''
    await loadAddresses()
  } catch (e) {
    toast.error('添加失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    addingAddress.value = false
  }
}

async function confirmDeleteAddress() {
  if (!deleteAddressTarget.value) return
  deletingAddress.value = true
  try {
    await emailApi.deleteAddress(deleteAddressTarget.value.id)
    toast.success('已删除目标地址')
    deleteAddressTarget.value = null
    await loadAddresses()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingAddress.value = false
  }
}

function openAddRule() {
  const verified = addresses.value.filter(isVerified)
  ruleForm.value = {
    local: '',
    dest: verified[0]?.email ?? '',
    action: 'forward',
  }
  addRuleOpen.value = true
}

async function submitRule() {
  if (!props.zoneId) return
  const zone = props.zoneName?.replace(/\.$/, '') || ''
  if (!zone) {
    toast.error('域名信息尚未加载，请稍后再试')
    return
  }
  const local = ruleForm.value.local.trim().toLowerCase()
  if (!local || local.includes('@')) {
    toast.error('请填写本地部分，如 info，不要带 @域名')
    return
  }
  const to = `${local}@${zone}`
  if (ruleForm.value.action === 'forward') {
    if (!ruleForm.value.dest) {
      toast.error('请选择已验证的目标邮箱')
      return
    }
  }
  creatingRule.value = true
  try {
    const created = await emailApi.createRule(props.zoneId, {
      name: `${to} → ${ruleForm.value.action === 'drop' ? '丢弃' : ruleForm.value.dest}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: to }],
      actions:
        ruleForm.value.action === 'drop'
          ? [{ type: 'drop' }]
          : [{ type: 'forward', value: [ruleForm.value.dest] }],
    })
    toast.success(
      created.enabled === false
        ? '规则已创建，但因目标未验证被 Cloudflare 禁用'
        : '规则已创建',
    )
    addRuleOpen.value = false
    await loadRules()
  } catch (e) {
    toast.error('创建失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    creatingRule.value = false
  }
}

async function confirmDeleteRule() {
  if (!props.zoneId || !deleteRuleTarget.value) return
  deletingRule.value = true
  try {
    await emailApi.deleteRule(props.zoneId, deleteRuleTarget.value.id)
    toast.success('已删除规则')
    deleteRuleTarget.value = null
    await loadRules()
  } catch (e) {
    toast.error('删除失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    deletingRule.value = false
  }
}

function matcherText(r: EmailRoutingRule): string {
  const m = r.matchers?.[0]
  if (!m) return '—'
  if (m.type === 'all') return '全部（catch-all）'
  return m.value || '—'
}

function actionText(r: EmailRoutingRule): string {
  const a = r.actions?.[0]
  if (!a) return '—'
  if (a.type === 'drop') return '丢弃'
  if (a.type === 'worker') return `Worker ${a.value?.[0] ?? ''}`
  return a.value?.join(', ') || '转发'
}
</script>

<template>
  <div class="space-y-4">
    <Card>
      <CardHeader class="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle class="flex items-center gap-2 text-base">
            <Mail class="size-4 text-primary" />
            Email Routing
          </CardTitle>
          <CardDescription>
            把本域邮箱转发到已验证的目标地址。启用后请确认 MX 指向 Cloudflare。目标地址为账号级，跨域名共用。
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" :disabled="settingsLoading || rulesLoading" @click="reload">
          <RefreshCw class="size-4" :class="{ 'animate-spin': settingsLoading || rulesLoading }" />
          刷新
        </Button>
      </CardHeader>
      <CardContent class="space-y-3">
        <div v-if="settingsLoading" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" /> 加载状态…
        </div>
        <div v-else-if="settingsError" class="text-sm text-destructive">{{ settingsError }}</div>
        <div v-else class="flex items-center justify-between rounded-lg border p-3">
          <div>
            <div class="text-sm font-medium">路由开关</div>
            <p class="text-xs text-muted-foreground">
              状态：{{ settings?.status || (enabled ? 'enabled' : 'disabled') }}
            </p>
          </div>
          <Switch :model-value="enabled" :disabled="toggling" @update:model-value="toggleEnabled" />
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">目标地址（需验证）</CardTitle>
        <CardDescription>Cloudflare 会发验证邮件；未验证的地址不能用于转发规则。</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="flex gap-2">
          <Input v-model="newAddress" placeholder="you@gmail.com" class="font-mono" />
          <Button size="sm" :disabled="addingAddress || !newAddress.trim()" @click="addDest">
            <Plus class="size-4" />
            添加
          </Button>
        </div>
        <div v-if="addressesLoading" class="space-y-2">
          <Skeleton class="h-8 w-full" />
        </div>
        <p v-else-if="addressesError" class="text-sm text-destructive">{{ addressesError }}</p>
        <p v-else-if="!addresses.length" class="text-sm text-muted-foreground">暂无目标地址</p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="a in addresses"
            :key="a.id"
            class="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span class="truncate font-mono">{{ a.email }}</span>
            <div class="flex items-center gap-1">
              <Badge variant="secondary" :class="isVerified(a) ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600'">
                {{ isVerified(a) ? '已验证' : '待验证' }}
              </Badge>
              <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive" @click="deleteAddressTarget = a">
                <Trash2 class="size-3.5" />
              </Button>
            </div>
          </li>
        </ul>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle class="text-base">转发规则</CardTitle>
          <CardDescription>匹配收件地址并转发或丢弃。免费档有条数上限，超出由 Cloudflare 报错。</CardDescription>
        </div>
        <Button size="sm" :disabled="!canAddRule" @click="openAddRule">
          <Plus class="size-4" />
          添加规则
        </Button>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="rulesLoading" class="space-y-2 px-4 py-4">
          <Skeleton class="h-8 w-full" />
          <Skeleton class="h-8 w-full" />
        </div>
        <div v-else-if="rulesError" class="px-4 py-8 text-center text-sm text-destructive">{{ rulesError }}</div>
        <div v-else-if="!rules.length" class="px-4 py-8 text-center text-sm text-muted-foreground">暂无转发规则</div>
        <div v-else class="divide-y">
          <div
            v-for="r in rules"
            :key="r.id"
            class="flex items-center justify-between gap-3 px-4 py-3 text-sm"
          >
            <div class="min-w-0">
              <div class="truncate font-medium">{{ r.name || matcherText(r) }}</div>
              <div class="truncate font-mono text-xs text-muted-foreground">
                {{ matcherText(r) }} → {{ actionText(r) }}
              </div>
            </div>
            <div class="flex items-center gap-1">
              <Badge variant="secondary" :class="r.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'">
                {{ r.enabled ? '启用' : '禁用' }}
              </Badge>
              <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive" @click="deleteRuleTarget = r">
                <Trash2 class="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <Dialog v-model:open="addRuleOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加转发规则</DialogTitle>
          <DialogDescription>
            收件地址将拼为 <code class="font-mono">本地部分@{{ zoneName || '本域' }}</code>
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label>本地部分</Label>
            <Input v-model="ruleForm.local" placeholder="info" class="font-mono" />
          </div>
          <div class="space-y-1.5">
            <Label>动作</Label>
            <Select v-model="ruleForm.action">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="forward">转发到目标地址</SelectItem>
                <SelectItem value="drop">丢弃</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div v-if="ruleForm.action === 'forward'" class="space-y-1.5">
            <Label>目标地址</Label>
            <Select v-model="ruleForm.dest">
              <SelectTrigger class="w-full"><SelectValue placeholder="选择已验证地址" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="a in addresses.filter(isVerified)" :key="a.id" :value="a.email">
                  {{ a.email }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="!addresses.some(isVerified)" class="text-xs text-amber-600">还没有已验证的目标地址</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="addRuleOpen = false">取消</Button>
          <Button :disabled="creatingRule" @click="submitRule">{{ creatingRule ? '创建中…' : '创建' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deleteRuleTarget" @update:open="(v) => !v && (deleteRuleTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除转发规则</DialogTitle>
          <DialogDescription>确定删除 {{ deleteRuleTarget ? matcherText(deleteRuleTarget) : '' }}？</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteRuleTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deletingRule" @click="confirmDeleteRule">
            {{ deletingRule ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deleteAddressTarget" @update:open="(v) => !v && (deleteAddressTarget = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除目标地址</DialogTitle>
          <DialogDescription>
            确定删除 <code class="font-mono">{{ deleteAddressTarget?.email }}</code>？使用该地址的规则会失效。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteAddressTarget = null">取消</Button>
          <Button variant="destructive" :disabled="deletingAddress" @click="confirmDeleteAddress">
            {{ deletingAddress ? '删除中…' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
