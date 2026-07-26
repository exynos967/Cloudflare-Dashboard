import { http, listAll } from './client'
import { useAuthStore } from '@/stores/auth'
import type { PagesProject, PagesDeployment } from '@/types/cloudflare'

/** 取当前账号的 Cloudflare account id（account 维度调用的前缀） */
function accountId(): string {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录')
  return acc.accountId
}

function projectBase(name: string): string {
  return `/accounts/${accountId()}/pages/projects/${name}`
}

export const pagesApi = {
  /** 列出账号下所有 Pages 项目（自动翻页） */
  listProjects: () =>
    listAll<PagesProject>(`/accounts/${accountId()}/pages/projects`),

  /** 获取单个 Pages 项目详情 */
  getProject: (name: string) => http.get<PagesProject>(projectBase(name)),

  /** 创建 Pages 项目（仅创建项目壳，不触发部署） */
  createProject: (name: string, productionBranch = 'main') =>
    http.post<PagesProject>(`/accounts/${accountId()}/pages/projects`, {
      body: { name, production_branch: productionBranch },
    }),

  /** 删除 Pages 项目 */
  deleteProject: (name: string) => http.delete<void>(projectBase(name)),

  /** 列出项目下的部署记录（自动翻页） */
  listDeployments: (name: string) =>
    listAll<PagesDeployment>(`${projectBase(name)}/deployments`),

  /** 获取单个部署详情 */
  getDeployment: (name: string, id: string) =>
    http.get<PagesDeployment>(`${projectBase(name)}/deployments/${id}`),
}
