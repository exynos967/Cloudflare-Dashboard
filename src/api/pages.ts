import { http, listAll } from './client'
import { useAuthStore } from '@/stores/auth'
import type { PagesDomain, PagesProject, PagesDeployment } from '@/types/cloudflare'

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
  /**
   * 列出账号下所有 Pages 项目（自动翻页）。
   * 注意：该端点的 per_page 上限远低于通用端点（50 会报 8000024
   * "Invalid list options"），对齐 wrangler 官方实现取 10。
   */
  listProjects: () =>
    listAll<PagesProject>(`/accounts/${accountId()}/pages/projects`, {}, { perPage: 10 }),

  /** 获取单个 Pages 项目详情 */
  getProject: (name: string) => http.get<PagesProject>(projectBase(name)),

  /** 创建 Pages 项目（仅创建项目壳，不触发部署） */
  createProject: (name: string, productionBranch = 'main') =>
    http.post<PagesProject>(`/accounts/${accountId()}/pages/projects`, {
      body: { name, production_branch: productionBranch },
    }),

  /** 删除 Pages 项目 */
  deleteProject: (name: string) => http.delete<void>(projectBase(name)),

  /** 列出项目下的部署记录（自动翻页；per_page 同样保守取 10，见 listProjects 注释） */
  listDeployments: (name: string) =>
    listAll<PagesDeployment>(`${projectBase(name)}/deployments`, {}, { perPage: 10 }),

  /** 获取单个部署详情 */
  getDeployment: (name: string, id: string) =>
    http.get<PagesDeployment>(`${projectBase(name)}/deployments/${id}`),

  /**
   * 回滚到指定部署。官方：POST .../deployments/{id}/rollback
   * 仅生产环境成功部署可回滚；失败由 CF 返回错误信息。
   */
  rollbackDeployment: (name: string, deploymentId: string) =>
    http.post<PagesDeployment>(`${projectBase(name)}/deployments/${deploymentId}/rollback`),

  listDomains: (name: string) =>
    listAll<PagesDomain>(`${projectBase(name)}/domains`, {}, { perPage: 20 }),

  addDomain: (name: string, domain: string) =>
    http.post<PagesDomain>(`${projectBase(name)}/domains`, { body: { name: domain } }),

  deleteDomain: (name: string, domain: string) =>
    http.delete<void>(`${projectBase(name)}/domains/${encodeURIComponent(domain)}`),
}
