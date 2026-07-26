<script setup lang="ts">
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2, KeyRound, Mail } from '@lucide/vue'
import { useAuthStore, type AuthType } from '@/stores/auth'
import { verifyCredentials } from '@/api'
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

function reset() {
  authType.value = 'global'
  email.value = ''
  apiKey.value = ''
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
    const acc = res.accounts[0]
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
  } catch (e) {
    toast.error('添加账号异常', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>添加账号</DialogTitle>
        <DialogDescription>验证 Cloudflare 凭据后添加到本地账号列表。</DialogDescription>
      </DialogHeader>

      <div class="space-y-4 py-2">
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

      <DialogFooter>
        <Button variant="outline" :disabled="loading" @click="open = false">取消</Button>
        <Button :disabled="loading" @click="handleSubmit">
          <Loader2 v-if="loading" class="size-4 animate-spin" />
          验证并添加
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
