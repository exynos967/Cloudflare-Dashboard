import { http } from './client'
import { useAuthStore } from '@/stores/auth'
import type { D1Database, D1QueryResult } from '@/types/cloudflare'

/** 取当前账号的 Cloudflare account id（D1 为 account 维度资源） */
function accountId(): string {
  const acc = useAuthStore().currentAccount
  if (!acc) throw new Error('未登录')
  return acc.accountId
}

function dbBase(uuid: string): string {
  return `/accounts/${accountId()}/d1/database/${uuid}`
}

export const d1Api = {
  /** 列出账号下所有 D1 数据库 */
  listDatabases: () => http.get<D1Database[]>(`/accounts/${accountId()}/d1/database`),

  /** 创建 D1 数据库 */
  createDatabase: (name: string) =>
    http.post<D1Database>(`/accounts/${accountId()}/d1/database`, { body: { name } }),

  /** 删除 D1 数据库 */
  deleteDatabase: (uuid: string) => http.delete<void>(dbBase(uuid)),

  /**
   * 执行 SQL 查询。D1 支持多语句（以 `;` 分隔），返回结果数组。
   * @param params 绑定参数（可选），按位置占位（? / ?nn）传入
   */
  query: (uuid: string, sql: string, params?: unknown[]) =>
    http.post<D1QueryResult[]>(dbBase(uuid) + '/query', { body: { sql, params } }),

  /** 列出当前数据库的所有表名（按名排序，过滤 sqlite_ / _cf_ 内部表） */
  listTables: (uuid: string) =>
    d1Api
      .query(
        uuid,
        "SELECT name FROM sqlite_master WHERE type='table'" +
          " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
          " AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'" +
          ' ORDER BY name',
      )
      .then((rs) => {
        const r = rs[0]?.results ?? []
        return r.map((row) => String(row.name))
      }),

  /** 查看表结构（PRAGMA table_info） */
  tableInfo: (uuid: string, table: string) =>
    d1Api
      .query(uuid, `PRAGMA table_info(${quoteIdent(table)})`)
      .then((rs) => rs[0]?.results ?? []),
}

/** 转义 SQLite 标识符，用于拼接到 PRAGMA / 反引号场景，防注入 */
function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"'
}
