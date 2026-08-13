<script setup lang="ts">
import { computed } from 'vue'
import { Codemirror } from 'vue-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { usePreferredDark } from '@vueuse/core'
import { useTheme } from '@/composables/useTheme'

const props = withDefaults(
  defineProps<{
    modelValue: string
    disabled?: boolean
    height?: string
  }>(),
  { height: '24rem' },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const theme = useTheme()
const preferredDark = usePreferredDark()
const extensions = computed(() => {
  const dark = theme.value === 'dark' || (theme.value === 'auto' && preferredDark.value)
  return dark ? [javascript(), oneDark] : [javascript()]
})
</script>

<template>
  <div class="overflow-hidden rounded-md border" :class="disabled ? 'pointer-events-none opacity-60' : ''">
    <Codemirror
      :model-value="modelValue"
      :extensions="extensions"
      :indent-with-tab="true"
      :tab-size="2"
      :style="{ height }"
      @update:model-value="(v: string) => emit('update:modelValue', v)"
    />
  </div>
</template>
