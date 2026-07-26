<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { Cloud, Moon, Sun, LogOut, User, Settings as SettingsIcon, ChevronDown } from '@lucide/vue'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useTheme } from '@/composables/useTheme'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Sidebar, SidebarProvider, SidebarHeader, SidebarContent,
  SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton,
  SidebarInset, SidebarTrigger, SidebarRail,
} from '@/components/ui/sidebar'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

const route = useRoute()
const routerInst = useRouter()
const auth = useAuthStore()
const mode = useTheme()
// 系统解析后的实际主题（light/dark）：mode 可能是 'auto'，切换按钮须按实际值判断
const themeState = mode.state

/** 从路由表生成侧边栏菜单（按 group 分组，过滤带参路由） */
const groups = computed(() => {
  const layout = router.options.routes.find((r) => r.path === '/')
  const children = (layout?.children ?? []).filter(
    (c) => c.meta?.group && typeof c.path === 'string' && !c.path.includes(':'),
  )
  const map = new Map<string, typeof children>()
  for (const c of children) {
    const g = c.meta!.group as string
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(c)
  }
  return [...map.entries()].map(([name, items]) => ({
    name,
    items: items.sort((a, b) => (a.meta!.order ?? 0) - (b.meta!.order ?? 0)),
  }))
})

function itemPath(p?: string) {
  return !p ? '/' : '/' + p
}
function isActive(p: string) {
  return route.path === p
}
function toggleTheme() {
  mode.value = themeState.value === 'dark' ? 'light' : 'dark'
}
function goSettings() {
  routerInst.push('/settings')
}
async function logout() {
  // 先离开数据视图再清账号：若先 logout，RouterView :key 立即变 'anon' 重挂载当前视图，
  // 新实例 onMounted 发请求会撞上「未登录」抛错闪 toast
  await routerInst.push('/login')
  auth.logout()
}
</script>

<template>
  <SidebarProvider>
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" :as-child="true">
              <RouterLink to="/">
                <div class="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Cloud class="size-4" />
                </div>
                <div class="grid flex-1 text-left text-sm leading-tight">
                  <span class="font-semibold">CF Dashboard</span>
                  <span class="text-xs text-muted-foreground">开源管理面板</span>
                </div>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup v-for="g in groups" :key="g.name">
          <SidebarGroupLabel>{{ g.name }}</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem v-for="item in g.items" :key="item.name as string">
              <SidebarMenuButton
                :as-child="true"
                :is-active="isActive(itemPath(item.path))"
                :tooltip="item.meta!.title"
              >
                <RouterLink :to="itemPath(item.path)">
                  <component :is="item.meta!.icon" />
                  <span>{{ item.meta!.title }}</span>
                </RouterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>

    <SidebarInset>
      <header class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <div class="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" @click="toggleTheme">
            <Sun v-if="themeState === 'dark'" class="size-4" />
            <Moon v-else class="size-4" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" class="gap-2 px-2">
                <Avatar class="size-7">
                  <AvatarFallback>{{ auth.currentAccount?.accountName?.[0]?.toUpperCase() ?? 'C' }}</AvatarFallback>
                </Avatar>
                <span class="hidden text-sm sm:inline">{{ auth.currentAccount?.accountName }}</span>
                <ChevronDown class="size-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuLabel class="font-normal">
                <div class="flex flex-col">
                  <span class="text-sm font-medium">{{ auth.currentAccount?.accountName }}</span>
                  <span class="text-xs text-muted-foreground">{{ auth.currentAccount?.email ?? 'API Token 模式' }}</span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuLabel class="text-xs text-muted-foreground">切换账号</DropdownMenuLabel>
              <DropdownMenuItem
                v-for="acc in auth.accounts.filter((a) => a.id !== auth.currentAccountId)"
                :key="acc.id"
                @click="auth.switchAccount(acc.id)"
              >
                <User class="size-4" /> {{ acc.accountName }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem @click="goSettings">
                <SettingsIcon class="size-4" /> 账号设置
              </DropdownMenuItem>
              <DropdownMenuItem class="text-destructive" @click="logout">
                <LogOut class="size-4" /> 退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main class="flex-1 p-4 md:p-6">
        <!-- 按当前账号 key 强制重挂载视图：切换账号后全站数据整体刷新 -->
        <RouterView :key="auth.currentAccountId ?? 'anon'" />
      </main>
    </SidebarInset>
  </SidebarProvider>
</template>
