// ============================================================
// API：GET /api/row
// 作用：详情评审页取数接口。按表名 + Jira ID 查询单条完整数据。
// 参数：table（表名）、jiraId（Jira ID）
// 返回：{ ok, row }；找不到时返回 404。
// ============================================================

import { getRowByJiraId } from "@/lib/db"
import { getRequestUser } from "@/lib/auth"
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

    // 4. 校验 Jira ID 参数
    const jiraId = sp.get("jiraId") || ""
    if (!jiraId) return errorResponse("缺少参数 jiraId")
    console.log(`[API row] 请求者「${user.username}」查询用户「${owner}」的表 ${resolved.table} 的工单 ${jiraId}`)

    // 5. 查询单条数据
    const row = getRowByJiraId(owner, resolved.table, jiraId)
    if (!row) {
      console.warn(`[API row] 未找到工单 ${jiraId}`)
      return errorResponse(`未找到工单：${jiraId}`, 404)
    }
    return Response.json({ ok: true, row })
  } catch (err) {
    console.error("[API row] 查询失败:", err)
    return errorResponse("查询详情失败，请查看服务端日志", 500)
  }
}
