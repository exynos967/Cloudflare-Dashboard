import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { watch } from 'vue'
import {
  LayoutDashboard,
  Globe,
  Zap,
  Server,
  Database,
  Boxes,
  HardDrive,
  Rocket,
  Network,
  Share2,
  Wrench,
  Settings,
} from '@lucide/vue'
import type { Component } from 'vue'
import { useAuthStore } from '@/stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    icon?: Component
    group?: string
    order?: number
    public?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/DashboardLayout.vue'),
    children: [
      { path: '', name: 'dashboard', component: () => import('@/views/DashboardView.vue'), meta: { title: '概览', icon: LayoutDashboard, group: '概览', order: 1 } },
      { path: 'zones', name: 'zones', component: () => import('@/views/zones/ZonesView.vue'), meta: { title: '域名管理', icon: Globe, group: '域名与加速', order: 1 } },
      { path: 'zones/:zoneId', name: 'zone-detail', component: () => import('@/views/zones/ZoneDetailView.vue'), meta: { title: '域名详情', icon: Globe, group: '域名与加速', order: 2 } },
      { path: 'accelerate', name: 'accelerate', component: () => import('@/views/accelerate/AccelerateView.vue'), meta: { title: '一键加速', icon: Zap, group: '域名与加速', order: 3 } },
      { path: 'saas', name: 'saas', component: () => import('@/views/saas/SaasView.vue'), meta: { title: 'SaaS优选', icon: Share2, group: '域名与加速', order: 4 } },
      { path: 'workers', name: 'workers', component: () => import('@/views/workers/WorkersView.vue'), meta: { title: 'Workers', icon: Server, group: '构建与计算', order: 1 } },
      { path: 'pages', name: 'pages', component: () => import('@/views/pages/PagesView.vue'), meta: { title: 'Pages', icon: Rocket, group: '构建与计算', order: 2 } },
      { path: 'r2', name: 'r2', component: () => import('@/views/r2/R2View.vue'), meta: { title: 'R2 存储', icon: HardDrive, group: '存储', order: 1 } },
      { path: 'kv', name: 'kv', component: () => import('@/views/kv/KvView.vue'), meta: { title: 'KV 存储', icon: Boxes, group: '存储', order: 2 } },
      { path: 'd1', name: 'd1', component: () => import('@/views/d1/D1View.vue'), meta: { title: 'D1 数据库', icon: Database, group: '存储', order: 3 } },
      { path: 'tunnel', name: 'tunnel', component: () => import('@/views/tunnel/TunnelView.vue'), meta: { title: 'Tunnel', icon: Network, group: 'Zero Trust', order: 1 } },
      { path: 'tools', name: 'tools', component: () => import('@/views/tools/ToolsView.vue'), meta: { title: '工具箱', icon: Wrench, group: '工具', order: 1 } },
      { path: 'settings', name: 'settings', component: () => import('@/views/settings/SettingsView.vue'), meta: { title: '设置', icon: Settings, group: '工具', order: 2 } },
    ],
  },
  // 404 兜底：未知路径统一回概览（未登录时由守卫再转登录页）
  { path: '/:pathMatch(.*)*', redirect: { name: 'dashboard' } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  // 凭据从 localStorage 异步解密加载，未就绪前不拦截，避免刷新瞬间误跳登录页
  if (!auth.ready) {
    // store 初始化在模块加载时已启动，正常几个微任务内就绪；
    // 超时兜底防止初始化异常导致守卫死等（超时后按未就绪放行，由后续判断转登录页）
    await new Promise<void>((resolve) => {
      if (auth.ready) return resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const stop = watch(
        () => auth.ready,
        (v) => {
          if (v) done()
        },
      )
      function done() {
        stop()
        clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(done, 10_000)
    })
  }
  if (!to.meta.public && !auth.isAuthed) {
    return { name: 'login', query: { redirect: (to.fullPath === '/login' ? '/' : to.fullPath) } }
  }
  if (to.name === 'login' && auth.isAuthed) {
    return { name: 'dashboard' }
  }
})

export default router
