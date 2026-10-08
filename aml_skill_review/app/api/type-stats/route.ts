// ============================================================
// API：GET /api/type-stats
// 作用：「同Skill结果对比全览」页取数接口。
// 参数：
//   user    （可选，管理员查看他人）
//   tables  （可选，逗号分隔的表名；不传则返回类型分组清单）
// 返回：
//   不传 tables → { ok, typeGroups: [{ type, tables: string[] }] }
//   传 tables   → { ok, result: CompareResult }
// ============================================================

import { getAllRows, listUserTables, tableExists } from "@/lib/db"
import { getRequestUser } from "@/lib/auth"
import { computeCompareStats, extractTypeFromTable, type StatsRow } from "@/lib/stats"
import { errorResponse, resolveDataOwner } from "@/lib/api-utils"

export async function GET(request: Request) {
  try {
    // 1. 登录校验：未登录直接拒绝
    const user = getRequestUser(request)
    if (!user) return errorResponse("请先登录", 401)

    // 2. 解析数据所属用户（管理员可查任何人的库）
    const sp = new URL(request.url).searchParams
    const ownerResolved = resolveDataOwner(user, sp.get("user"))
    if (!ownerResolved.ok) return errorResponse(ownerResolved.error, 403)
    const owner = ownerResolved.owner

    // 3. 模式一：不传 tables → 返回所有表按类型分组
    const tablesParam = String(sp.get("tables") || "").trim()
    if (!tablesParam) {
      const allTables = listUserTables(owner)
      const groupMap = new Map<string, string[]>()
      for (const t of allTables) {
        const type = extractTypeFromTable(t)
        if (!groupMap.has(type)) groupMap.set(type, [])
        groupMap.get(type)!.push(t)
      }
      const typeGroups = Array.from(groupMap.entries())
        .map(([type, tables]) => ({ type, tables }))
        .sort((a, b) => a.type.localeCompare(b.type))
      return Response.json({ ok: true, typeGroups })
    }

    // 4. 模式二：传 tables → 逐表取数并计算对比统计
    const requested = Array.from(
      new Set(tablesParam.split(",").map((t) => t.trim()).filter(Boolean)),
    )
    if (requested.length === 0) return errorResponse("至少需要选择一张数据表")

    const tablesRows: { table: string; rows: StatsRow[] }[] = []
    for (const table of requested) {
      if (!tableExists(owner, table)) {
        return errorResponse(`数据表「${table}」不存在`, 404)
      }
      const rows = getAllRows(owner, table)
      tablesRows.push({
        table,
        rows: rows.map((r) => ({
          jira_id: r.jira_id,
          summary: r.summary,
          judge_verdict: r.judge_verdict,
          human_judge: r.human_judge,
        })),
      })
    }

    const result = computeCompareStats(tablesRows)
    console.log(
      `[API type-stats] 对比 ${result.tables.length} 张表：共 ${result.rows.length} 个 jira_id，不一致 ${result.inconsistentJiraIds.length} 条`,
    )
    return Response.json({ ok: true, result })
  } catch (err) {
    console.error("[API type-stats] 对比统计失败:", err)
    return errorResponse("对比统计失败，请查看服务端日志", 500)
  }
}
