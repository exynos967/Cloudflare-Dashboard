import { http, listAll } from './client'
import { useAuthStore } from '@/stores/auth'

function accountId(): string {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录')
  return acc.accountId
}

export interface EmailRoutingSettings {
  enabled?: boolean
  name?: string
  status?: string
  skip_wizard?: boolean
  created?: string
  modified?: string
  tag?: string
}

export interface EmailRoutingMatcher {
  type: 'all' | 'literal'
  field?: 'to'
  value?: string
}

export interface EmailRoutingAction {
  type: 'drop' | 'forward' | 'worker'
  value?: string[]
}

export interface EmailRoutingRule {
  id: string
  name?: string
  enabled?: boolean
  priority?: number
  matchers: EmailRoutingMatcher[]
  actions: EmailRoutingAction[]
}

export interface EmailDestinationAddress {
  id: string
  email: string
  verified?: string | null
  created?: string
  modified?: string
  tag?: string
}

export const emailApi = {
  getSettings: (zoneId: string) =>
    http.get<EmailRoutingSettings>(`/zones/${zoneId}/email/routing`),

  enable: (zoneId: string) =>
    http.post<EmailRoutingSettings>(`/zones/${zoneId}/email/routing/enable`),

  disable: (zoneId: string) =>
    http.post<EmailRoutingSettings>(`/zones/${zoneId}/email/routing/disable`),

  listRules: (zoneId: string) =>
    listAll<EmailRoutingRule>(`/zones/${zoneId}/email/routing/rules`, {}, { perPage: 50 }),

  createRule: (
    zoneId: string,
    data: {
      name?: string
      enabled?: boolean
      matchers: EmailRoutingMatcher[]
      actions: EmailRoutingAction[]
    },
  ) =>
    http.post<EmailRoutingRule>(`/zones/${zoneId}/email/routing/rules`, { body: data }),

  deleteRule: (zoneId: string, ruleId: string) =>
    http.delete<unknown>(`/zones/${zoneId}/email/routing/rules/${ruleId}`),

  listAddresses: () =>
    listAll<EmailDestinationAddress>(
      `/accounts/${accountId()}/email/routing/addresses`,
      {},
      { perPage: 50 },
    ),

  addAddress: (email: string) =>
    http.post<EmailDestinationAddress>(`/accounts/${accountId()}/email/routing/addresses`, {
      body: { email },
    }),

  deleteAddress: (id: string) =>
    http.delete<unknown>(`/accounts/${accountId()}/email/routing/addresses/${id}`),
}
