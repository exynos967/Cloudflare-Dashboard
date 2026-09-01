<script setup lang="ts">
/** 展示生成的 Worker 脚本预览（只读代码块） */
import { computed } from 'vue'
import { generateWorkerScript } from '@/api/accelerate'

const props = defineProps<{
  targetDomain: string
  cacheTtl: number
}>()

const script = computed(() => {
  if (!props.targetDomain) return '// 请填写源站域名'
  return generateWorkerScript(props.targetDomain, props.cacheTtl)
})
</script>

<template>
  <div class="overflow-hidden rounded-lg border bg-muted/30">
    <div class="flex items-center justify-between border-b px-3 py-2">
      <span class="text-xs font-medium text-muted-foreground">Worker 脚本预览</span>
      <span class="text-[10px] text-muted-foreground">ES Module · Workers</span>
    </div>
    <pre class="max-h-72 overflow-auto p-3 text-xs leading-relaxed"><code>{{ script }}</code></pre>
  </div>
</template>
