// ============================================================
// API：GET /api/rows
// 作用：列表页取数接口。按表名 + 过滤条件分页查询数据，
// 同时返回两个过滤下拉框需要的去重选项。
// 参数：table（表名）、judgeVerdict、humanJudge、page、pageSize
// 返回：{ ok, rows, total, page, pageSize, judgeVerdictOptions, humanJudgeOptions }
// ============================================================

import { distinctValues, queryRows } from "@/lib/db"
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
    const table = resolved.table

    // 4. 读取过滤与分页参数（都带默认值，缺省也不会出错）
    const judgeVerdict = sp.get("judgeVerdict") || ""
    const humanJudge = sp.get("humanJudge") || ""
    const page = Number(sp.get("page") || "1") || 1
    const pageSize = Number(sp.get("pageSize") || "1000") || 1000
    console.log(
      `[API rows] 请求者「${user.username}」查询用户「${owner}」的表 ${table} 过滤: judgeVerdict=${judgeVerdict || "(全部)"}, humanJudge=${humanJudge || "(全部)"} 页=${page}`,
    )

    // 5. 查询数据 + 生成过滤选项
    const { rows, total } = queryRows(owner, table, { judgeVerdict, humanJudge }, page, pageSize)
    const judgeVerdictOptions = distinctValues(owner, table, "judge_verdict")
    const humanJudgeOptions = distinctValues(owner, table, "human_judge")
    console.log(`[API rows] 返回 ${rows.length} 行，共 ${total} 条`)

    return Response.json({
      ok: true,
      owner,
      rows,
      total,
      page,
      pageSize,
      judgeVerdictOptions,
      humanJudgeOptions,
    })
  } catch (err) {
    console.error("[API rows] 查询失败:", err)
    return errorResponse("查询数据失败，请查看服务端日志", 500)
  }
}
