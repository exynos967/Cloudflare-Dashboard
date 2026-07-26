<script setup lang="ts">
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2, KeyRound, Mail, Building2 } from '@lucide/vue'
import { useAuthStore, type AuthType } from '@/stores/auth'
import { verifyCredentials } from '@/api'
import type { CFAccount } from '@/types/cloudflare'
import { Button } from '@/components/ui/button'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const open = defineModel<boolean>('open', { required: true })

const auth = useAuthStore()

const authType = ref<AuthType>('global')
const email = ref('')
const apiKey = ref('')
const loading = ref(false)
/** 凭据可见多个 CF 账号时的候选列表（非 null 时进入账号选择步骤） */
const candidates = ref<CFAccount[] | null>(null)

function reset() {
  authType.value = 'global'
  email.value = ''
  apiKey.value = ''
  candidates.value = null
}

async function handleSubmit() {
  if (loading.value) return
  if (authType.value === 'global' && !email.value) return toast.error('请输入 Cloudflare 账号邮箱')
  if (!apiKey.value) return toast.error('请输入 API Key / Token')
  loading.value = true
  try {
    const res = await verifyCredentials({
      authType: authType.value,
      email: email.value,
      apiKey: apiKey.value,
    })
    if (!res.ok || !res.accounts?.length) {
      toast.error('凭据验证失败', { description: res.error })
      return
    }
    // 凭据可见多个 CF 账号时让用户选择，避免默认取第一个
    if (res.accounts.length > 1) {
      candidates.value = res.accounts
      return
    }
    finishAdd(res.accounts[0])
  } catch (e) {
    toast.error('添加账号异常', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}

/** 用选定的 CF 账号完成添加（addAccount 按 accountId+authType 去重） */
function finishAdd(acc: CFAccount) {
  auth.addAccount({
    accountId: acc.id,
    accountName: acc.name,
    nickname: acc.name,
    authType: authType.value,
    email: authType.value === 'global' ? email.value : undefined,
    apiKey: apiKey.value,
  })
  toast.success('账号添加成功')
  reset()
  open.value = false
}

/** 一次性添加凭据下全部 CF 账号 */
function addAllCandidates() {
  const list = candidates.value
  if (!list?.length) return
  for (const acc of [...list].reverse()) {
    auth.addAccount({
      accountId: acc.id,
      accountName: acc.name,
      nickname: acc.name,
      authType: authType.value,
      email: authType.value === 'global' ? email.value : undefined,
      apiKey: apiKey.value,
    })
  }
  toast.success(`已添加 ${list.length} 个账号`)
  reset()
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>添加账号</DialogTitle>
        <DialogDescription>验证 Cloudflare 凭据后添加到本地账号列表。</DialogDescription>
      </DialogHeader>

      <!-- 多账号凭据：选择要添加的 CF 账号 -->
      <div v-if="candidates" class="space-y-3 py-2">
        <Label>该凭据可管理 {{ candidates.length }} 个账号，选择要添加的：</Label>
        <Button
          v-for="c in candidates"
          :key="c.id"
          variant="outline"
          class="w-full justify-start gap-2"
          @click="finishAdd(c)"
        >
          <Building2 class="size-4 text-muted-foreground" />
          <span class="truncate">{{ c.name }}</span>
          <span class="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{{ c.id.slice(0, 8) }}…</span>
        </Button>
        <div class="flex gap-2">
          <Button variant="secondary" class="flex-1" @click="addAllCandidates">全部添加</Button>
          <Button variant="ghost" class="flex-1" @click="candidates = null">返回</Button>
        </div>
      </div>

      <div v-else class="space-y-4 py-2">
        <Tabs v-model="authType" class="w-full">
          <TabsList class="grid w-full grid-cols-2">
            <TabsTrigger value="global">Global API Key</TabsTrigger>
            <TabsTrigger value="token">API Token</TabsTrigger>
          </TabsList>
        </Tabs>

        <div v-if="authType === 'global'" class="space-y-2">
          <Label for="add-email">Cloudflare 账号邮箱</Label>
          <div class="relative">
            <Mail class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="add-email" v-model="email" type="email" placeholder="your@email.com" class="pl-9" />
          </div>
        </div>

        <div class="space-y-2">
          <Label for="add-key">{{ authType === 'global' ? 'Global API Key' : 'API Token' }}</Label>
          <div class="relative">
            <KeyRound class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="add-key"
              v-model="apiKey"
              type="password"
              placeholder="••••••••••••"
              class="pl-9"
              @keyup.enter="handleSubmit"
            />
          </div>
          <p class="text-xs text-muted-foreground">凭据仅存浏览器本地，建议使用最小权限 API Token。</p>
        </div>
      </div>

      <DialogFooter v-if="!candidates">
        <Button variant="outline" :disabled="loading" @click="open = false">取消</Button>
        <Button :disabled="loading" @click="handleSubmit">
          <Loader2 v-if="loading" class="size-4 animate-spin" />
          验证并添加
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
