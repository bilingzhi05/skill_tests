// ============================================================
// API：GET /api/stats
// 作用：统计页取数接口。取出整表数据，在服务端用
// computeStats 计算总数、四类分布、一致率、差异清单等指标。
// 参数：table（表名）
// 返回：{ ok, stats }
// ============================================================

import { getAllRows } from "@/lib/db"
import { getRequestUser } from "@/lib/auth"
import { computeStats } from "@/lib/stats"
import { errorResponse, resolveDataOwner, resolveTable } from "@/lib/api-utils"

export async function GET(request: Request) {
  try {
    // 1. 登录校验：未登录直接拒绝
    const user = getRequestUser(request)
    if (!user) return errorResponse("请先登录", 401)

    const sp = new URL(request.url).searchParams
    // 2. 解析数据所属用户（管理员可查任何人的库）
    const ownerResolved = resolveDataOwner(user, sp.get("user"))
    if (!ownerResolved.ok) return errorResponse(ownerResolved.error, 403)
    const owner = ownerResolved.owner

    // 3. 校验表名（查数据所属用户的库）
    const resolved = resolveTable(sp, owner)
    if (!resolved.ok) return errorResponse(resolved.error, 404)

    // 4. 取全表数据并计算统计
    const rows = getAllRows(owner, resolved.table)
    const stats = computeStats(
      rows.map((r) => ({
        jira_id: r.jira_id,
        summary: r.summary,
        judge_verdict: r.judge_verdict,
        human_judge: r.human_judge,
      })),
    )
    console.log(
      `[API stats] 表 ${resolved.table}：总数=${stats.total} 已评审=${stats.reviewed} 一致=${stats.agreed}`,
    )
    return Response.json({ ok: true, table: resolved.table, stats })
  } catch (err) {
    console.error("[API stats] 统计失败:", err)
    return errorResponse("统计计算失败，请查看服务端日志", 500)
  }
}
