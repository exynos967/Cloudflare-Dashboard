<script setup lang="ts">
import { Cloud } from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import AnalyticsPanel from '@/components/dashboard/AnalyticsPanel.vue'

const auth = useAuthStore()
</script>

<template>
  <div class="space-y-6">
    <!-- 欢迎卡片 -->
    <div class="rounded-xl border bg-card p-6 shadow-sm">
      <div class="flex items-center gap-3">
        <div class="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Cloud class="size-5" />
        </div>
        <div>
          <h1 class="text-xl font-semibold tracking-tight">欢迎回来，{{ auth.currentAccount?.accountName ?? '访客' }}</h1>
          <p class="text-sm text-muted-foreground">
            {{ auth.currentAccount?.authType === 'token' ? 'API Token 模式' : 'Global API Key 模式' }}
            · 账号 ID {{ auth.currentAccount?.accountId }}
          </p>
        </div>
      </div>
    </div>

    <!-- 分析统计（GraphQL Analytics + recharts 图表） -->
    <AnalyticsPanel />
  </div>
</template>
