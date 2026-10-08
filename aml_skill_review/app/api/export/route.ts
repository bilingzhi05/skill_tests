// ============================================================
// API：GET /api/export
// 作用：导出接口。按当前过滤条件查询全部字段的全部行，
// 返回给前端；前端再用 xlsx 库在浏览器里生成 .xlsx 文件下载。
// 参数：table（表名）、judgeVerdict、humanJudge（可选过滤）
// 返回：{ ok, table, rows }
// ============================================================

import { queryAllFiltered } from "@/lib/db"
import { getRequestUser } from "@/lib/auth"
import { errorResponse, resolveDataOwner, resolveTable } from "@/lib/api-utils"

export async function GET(request: Request) {
  try {
    // 1. 登录校验：未登录直接拒绝
    const user = getRequestUser(request)
    if (!user) return errorResponse("请先登录", 401)

    const sp = new URL(request.url).searchParams
    // 2. 解析数据所属用户（管理员可导出任何人的库）
    const ownerResolved = resolveDataOwner(user, sp.get("user"))
    if (!ownerResolved.ok) return errorResponse(ownerResolved.error, 403)
    const owner = ownerResolved.owner

    // 3. 校验表名（查数据所属用户的库）
    const resolved = resolveTable(sp, owner)
    if (!resolved.ok) return errorResponse(resolved.error, 404)

    // 4. 读取过滤条件（与列表页保持一致，导出当前看到的数据）
    const judgeVerdict = sp.get("judgeVerdict") || ""
    const humanJudge = sp.get("humanJudge") || ""

    // 5. 查询全部数据（不分页）
    const rows = queryAllFiltered(owner, resolved.table, { judgeVerdict, humanJudge })
    console.log(`[API export] 表 ${resolved.table} 导出 ${rows.length} 行`)
    return Response.json({ ok: true, table: resolved.table, rows })
  } catch (err) {
    console.error("[API export] 导出查询失败:", err)
    return errorResponse("导出失败，请查看服务端日志", 500)
  }
}
