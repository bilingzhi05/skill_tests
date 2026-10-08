// ============================================================
// 数据库操作文件
// 作用：封装所有业务 SQLite 数据库操作（建表、查表、插入、查询、更新评审）。
// 页面上的所有数据读写最终都经过这里，页面代码不直接碰数据库。
// 使用 Node.js 内置的 node:sqlite 模块（无需安装任何额外依赖）。
//
// 按用户隔离：每个登录用户都有自己独立的数据库文件，
// 放在各自的数据文件夹里（如 user_data/lingzhi.bi/lingzhi_bi.db），
// 因此下面所有函数的第一个参数都是 username（当前登录名）。
// ============================================================

import { DatabaseSync } from "node:sqlite"
import fs from "fs"
import path from "path"
import { userDataDir, userDbPath } from "@/lib/config"
import { FIELD_NAMES } from "@/lib/columns"

/** 数据库连接缓存：登录名 → 连接。每个用户的库只打开一次，之后复用 */
const dbCache = new Map<string, DatabaseSync>()

/**
 * 获取某个用户的数据库连接。
 * 作用：第一次调用时打开（并自动创建）该用户的数据库文件，
 * 例如 lingzhi.bi → user_data/lingzhi.bi/lingzhi_bi.db；
 * 之后每次调用都复用同一个连接，避免反复打开关闭。
 */
export function getDb(username: string): DatabaseSync {
  const cached = dbCache.get(username)
  if (cached) return cached
  // 确保用户文件夹存在，否则无法在里面创建数据库文件
  fs.mkdirSync(userDataDir(username), { recursive: true })
  const dbPath = userDbPath(username)
  const db = new DatabaseSync(dbPath)
  // WAL 模式：读写性能更好，多人同时访问更稳定
  db.exec("PRAGMA journal_mode = WAL")
  dbCache.set(username, db)
  console.log(`[数据库] 已打开用户「${username}」的数据库文件:`, dbPath)
  return db
}

/**
 * 生成当前时间字符串，格式：2026-08-03 21:30:05。
 * 作用：写入 create_t / update_t 两列。
 */
export function nowString(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 清洗表名。
 * 作用：表名来自 xlsx 文件名，可能包含特殊字符。
 * 这里把「字母、数字、下划线、连字符、点」以外的字符全部替换成下划线，
 * 保证 SQL 安全，防止注入。
 */
export function sanitizeTableName(raw: string): string {
  const cleaned = raw.replace(/[^\w\-.]/g, "_")
  // 表名不能为空，极端情况下给个默认名
  return cleaned || "imported_table"
}

/**
 * 给表名加双引号（SQL 标识符引用），内部出现双引号时转义。
 * 作用：让带连字符等特殊字符的表名也能在 SQL 里安全使用。
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * 判断某张表是否已存在（在指定用户的库里）。
 * 作用：导入 xlsx 前先用表名查一下，存在就直接复用，不重复导入。
 */
export function tableExists(username: string, tableName: string): boolean {
  const row = getDb(username)
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName)
  return !!row
}

/**
 * 创建一张评审数据表（在指定用户的库里）。
 * 作用：按统一字段列表建表，所有业务列都是 TEXT 文本类型；
 * human_judge / human_judge_reason 默认为空（表示「未判定」）。
 */
export function createTable(username: string, tableName: string): void {
  const cols = FIELD_NAMES.map((f) => `${quoteIdent(f)} TEXT`).join(", ")
  getDb(username).exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (${cols})`)
  console.log(`[数据库] 用户「${username}」已创建表:`, tableName)
}

/**
 * 批量插入数据行（写入指定用户的库）。
 * 作用：把解析好的 xlsx 数据逐行写入表中。
 * 每一行单独做异常保护：某一行出错只跳过该行，不会导致整体失败。
 * 返回 { inserted: 成功条数, skipped: 失败条数 }。
 */
export function insertRows(
  username: string,
  tableName: string,
  rows: Record<string, string>[],
): { inserted: number; skipped: number } {
  const fields = FIELD_NAMES
  const placeholders = fields.map(() => "?").join(", ")
  const sql = `INSERT INTO ${quoteIdent(tableName)} (${fields
    .map(quoteIdent)
    .join(", ")}) VALUES (${placeholders})`
  const database = getDb(username)
  const stmt = database.prepare(sql)
  const now = nowString()

  let inserted = 0
  let skipped = 0
  // 手动开启事务批量提交，速度快很多
  database.exec("BEGIN")
  try {
    for (const item of rows) {
      try {
        const values = fields.map((f) =>
          f === "create_t"
            ? item.create_t || now
            : f === "update_t"
              ? item.update_t || now
              : (item[f] ?? null),
        )
        stmt.run(...values)
        inserted++
      } catch (err) {
        skipped++
        console.warn("[数据库] 插入单行失败，已跳过:", err)
      }
    }
    database.exec("COMMIT")
  } catch (err) {
    console.error("[数据库] 批量插入事务失败，已回滚:", err)
    try {
      database.exec("ROLLBACK")
    } catch {
      // 回滚失败时忽略，避免覆盖原始错误
    }
  }
  return { inserted, skipped }
}

/** 行数据过滤条件类型 */
export type RowFilters = {
  judgeVerdict?: string // 按大模型判定过滤（"__NULL__" = 只看未判定，空 = 不过滤）
  humanJudge?: string // 按人工判定过滤（"__NULL__" = 只看未判定，空 = 不过滤）
}

/** 根据过滤条件拼 WHERE 子句（内部共用） */
function buildWhere(filters: RowFilters): { whereSql: string; params: string[] } {
  const where: string[] = []
  const params: string[] = []
  if (filters.judgeVerdict === "__NULL__") {
    // 未判定 = 字段为空或空字符串
    where.push("(\"judge_verdict\" IS NULL OR \"judge_verdict\" = '')")
  } else if (filters.judgeVerdict) {
    where.push('"judge_verdict" = ?')
    params.push(filters.judgeVerdict)
  }
  if (filters.humanJudge === "__NULL__") {
    where.push("(\"human_judge\" IS NULL OR \"human_judge\" = '')")
  } else if (filters.humanJudge) {
    where.push('"human_judge" = ?')
    params.push(filters.humanJudge)
  }
  return {
    whereSql: where.length ? ` WHERE ${where.join(" AND ")}` : "",
    params,
  }
}

/**
 * 统计符合条件的总行数（查指定用户的库）。
 * 作用：列表右上角显示「共 N 条」。
 */
export function countRows(username: string, tableName: string, filters: RowFilters): number {
  const { whereSql, params } = buildWhere(filters)
  const row = getDb(username)
    .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(tableName)}${whereSql}`)
    .get(...params) as { n: number | bigint }
  return Number(row.n)
}

/**
 * 分页查询列表数据（查指定用户的库）。
 * 作用：列表页按过滤条件取数据，支持分页（页码从 1 开始）。
 * 返回 { rows: 当前页数据, total: 符合条件的总数 }。
 */
export function queryRows(
  username: string,
  tableName: string,
  filters: RowFilters,
  page: number,
  pageSize: number,
): { rows: Record<string, string | null>[]; total: number } {
  const { whereSql, params } = buildWhere(filters)
  const safePage = Math.max(1, page)
  const safeSize = Math.min(Math.max(1, pageSize), 5000)
  const offset = (safePage - 1) * safeSize

  const rows = getDb(username)
    .prepare(
      `SELECT rowid AS _rowid, * FROM ${quoteIdent(tableName)}${whereSql} ORDER BY rowid LIMIT ? OFFSET ?`,
    )
    .all(...params, safeSize, offset) as unknown as Record<string, string | null>[]
  const total = countRows(username, tableName, filters)
  return { rows, total }
}

/**
 * 取某列的全部去重值（过滤掉空值，查指定用户的库）。
 * 作用：生成「大模型判定 / 人工判定」过滤下拉框的选项。
 */
export function distinctValues(
  username: string,
  tableName: string,
  column: "judge_verdict" | "human_judge",
): string[] {
  const rows = getDb(username)
    .prepare(
      `SELECT DISTINCT ${quoteIdent(column)} AS v FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(column)} IS NOT NULL AND ${quoteIdent(column)} != '' ORDER BY ${quoteIdent(column)}`,
    )
    .all() as unknown as { v: string }[]
  return rows.map((r) => r.v)
}

/**
 * 列出用户数据库里的全部业务表名。
 * 作用：「同Skill结果对比全览」页需要先知道有哪些表，
 * 再按类型分组供用户勾选对比。排除 sqlite 内部表。
 */
export function listUserTables(username: string): string[] {
  const rows = getDb(username)
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as { name: string }[]
  return rows.map((r) => r.name)
}

/**
 * 按 Jira ID 查询单条详情（查指定用户的库）。
 * 作用：详情评审页打开时，根据网址里的 Jira ID 取出这一条完整数据。
 * 找不到时返回 null。
 */
export function getRowByJiraId(
  username: string,
  tableName: string,
  jiraId: string,
): Record<string, string | null> | null {
  const row = getDb(username)
    .prepare(
      `SELECT rowid AS _rowid, * FROM ${quoteIdent(tableName)} WHERE "jira_id" = ? LIMIT 1`,
    )
    .get(jiraId) as unknown as Record<string, string | null> | undefined
  return row ?? null
}

/**
 * 保存人工评审结果（写入指定用户的库）。
 * 作用：详情页点「保存」后，把人工判定和原因写回数据库，
 * 同时刷新 update_t（最后更新时间）。返回受影响的行数。
 */
export function updateReview(
  username: string,
  tableName: string,
  jiraId: string,
  humanJudge: string,
  humanJudgeReason: string,
): number {
  const result = getDb(username)
    .prepare(
      `UPDATE ${quoteIdent(tableName)} SET "human_judge" = ?, "human_judge_reason" = ?, "update_t" = ? WHERE "jira_id" = ?`,
    )
    .run(humanJudge, humanJudgeReason, nowString(), jiraId)
  return Number(result.changes)
}

/**
 * 查询某张表的全部行（不带过滤，查指定用户的库）。
 * 作用：统计页需要在服务端计算各项指标，所以要拿到全表数据。
 */
export function getAllRows(
  username: string,
  tableName: string,
): Record<string, string | null>[] {
  return getDb(username)
    .prepare(`SELECT * FROM ${quoteIdent(tableName)} ORDER BY rowid`)
    .all() as unknown as Record<string, string | null>[]
}

/**
 * 导出用：按过滤条件查询全部字段的全部行（不分页，查指定用户的库）。
 * 作用：「导出 xlsx」按钮会把当前过滤条件下的所有数据下载下来。
 */
export function queryAllFiltered(
  username: string,
  tableName: string,
  filters: RowFilters,
): Record<string, string | null>[] {
  const { whereSql, params } = buildWhere(filters)
  return getDb(username)
    .prepare(`SELECT * FROM ${quoteIdent(tableName)}${whereSql} ORDER BY rowid`)
    .all(...params) as unknown as Record<string, string | null>[]
}
