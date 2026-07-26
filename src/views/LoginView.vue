<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Cloud, Loader2, KeyRound, Mail, User } from '@lucide/vue'
import { useAuthStore, type Account } from '@/stores/auth'
import { verifyCredentials } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const authType = ref<'global' | 'token'>('global')
const email = ref('')
const apiKey = ref('')
const loading = ref(false)

/** 账号凭据不可用（密文解密失败或密钥为空）：不允许直接进入 */
function isBroken(acc: Account): boolean {
  return !!acc.corrupted || !acc.apiKey
}

/** 直接使用已有本地账号登录（corrupted 账号拦截并引导重录） */
function pickAccount(acc: Account) {
  if (isBroken(acc)) {
    toast.error('该账号凭据需重新录入', {
      description: '请先用有效凭据登录，再到「账号设置」为该账号重新录入 API Key / Token',
    })
    return
  }
  auth.switchAccount(acc.id)
  router.push((route.query.redirect as string) || '/')
}

async function handleLogin() {
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
    toast.success('登录成功，欢迎！')
    router.push((route.query.redirect as string) || '/')
  } catch (e) {
    toast.error('登录异常', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex min-h-svh items-center justify-center bg-muted/30 p-4">
    <Card class="w-full max-w-md">
      <CardHeader class="text-center">
        <div class="mx-auto mb-2 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Cloud class="size-6" />
        </div>
        <CardTitle class="text-2xl">CF Dashboard</CardTitle>
        <CardDescription>开源 · 自托管 · 凭据零上链的 Cloudflare 管理面板</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- 已有本地账号：直接选择登录，避免重复录入累积重复项 -->
        <template v-if="auth.accounts.length > 0">
          <div class="space-y-2">
            <Label>选择已有账号</Label>
            <Button
              v-for="acc in auth.accounts"
              :key="acc.id"
              variant="outline"
              class="w-full justify-start gap-2"
              @click="pickAccount(acc)"
            >
              <User class="size-4 text-muted-foreground" />
              <span class="truncate">{{ acc.nickname || acc.accountName }}</span>
              <span v-if="isBroken(acc)" class="shrink-0 text-xs text-destructive">凭据需重新录入</span>
              <span class="ml-auto shrink-0 text-xs text-muted-foreground">
                {{ acc.authType === 'token' ? 'API Token' : 'Global Key' }}
              </span>
            </Button>
          </div>
          <div class="relative">
            <Separator />
            <span class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
              或使用新凭据登录
            </span>
          </div>
        </template>

        <Tabs v-model="authType" class="w-full">
          <TabsList class="grid w-full grid-cols-2">
            <TabsTrigger value="global">Global API Key</TabsTrigger>
            <TabsTrigger value="token">API Token</TabsTrigger>
          </TabsList>
        </Tabs>

        <div v-if="authType === 'global'" class="space-y-2">
          <Label for="email">Cloudflare 账号邮箱</Label>
          <div class="relative">
            <Mail class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="email" v-model="email" type="email" placeholder="your@email.com" class="pl-9" />
          </div>
        </div>

        <div class="space-y-2">
          <Label for="key">{{ authType === 'global' ? 'Global API Key' : 'API Token' }}</Label>
          <div class="relative">
            <KeyRound class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="key" v-model="apiKey" type="password" placeholder="••••••••••••" class="pl-9" @keyup.enter="handleLogin" />
          </div>
          <p class="text-xs text-muted-foreground">
            凭据仅存浏览器本地，永不上传任何服务器。Token 建议用最小权限。
          </p>
        </div>

        <Button class="w-full" :disabled="loading" @click="handleLogin">
          <Loader2 v-if="loading" class="size-4 animate-spin" />
          验证并进入
        </Button>

        <p class="text-center text-xs text-muted-foreground">
          还没有账号？
          <a href="https://dash.cloudflare.com/sign-up" target="_blank" class="text-primary hover:underline">立即注册</a>
        </p>
      </CardContent>
    </Card>
  </div>
</template>
