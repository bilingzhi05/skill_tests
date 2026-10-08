// ============================================================
// API：POST /api/review
// 作用：保存人工评审结果。把人工判定（human_judge）和
// 人工判定原因（human_judge_reason）写回数据库，并刷新 update_t。
// 请求体：{ table, jiraId, humanJudge, humanJudgeReason }
// 返回：{ ok, changes }
// ============================================================

import { updateReview } from "@/lib/db"
import { sanitizeTableName, tableExists } from "@/lib/db"
import { getRequestUser } from "@/lib/auth"
import { errorResponse, resolveDataOwner } from "@/lib/api-utils"

export async function POST(request: Request) {
  try {
    // 1. 登录校验：未登录直接拒绝
    const user = getRequestUser(request)
    if (!user) return errorResponse("请先登录", 401)

    // 2. 解析请求体（JSON 损坏时返回友好错误）
    let body: {
      table?: string
      jiraId?: string
      humanJudge?: string
      humanJudgeReason?: string
      user?: string
    }
    try {
      body = await request.json()
    } catch {
      return errorResponse("请求体不是合法的 JSON")
    }

    // 管理员可通过 user 给其他用户的工单保存评审；普通用户只能保存自己的
    const ownerResolved = resolveDataOwner(user, body.user)
    if (!ownerResolved.ok) return errorResponse(ownerResolved.error, 403)
    const owner = ownerResolved.owner

    const table = sanitizeTableName(String(body.table || ""))
    const jiraId = String(body.jiraId || "").trim()
    const humanJudge = String(body.humanJudge || "").trim()
    const humanJudgeReason = String(body.humanJudgeReason || "").trim()
    console.log(
      `[API review] 请求者「${user.username}」为用户「${owner}」保存评审: 表=${table}, 工单=${jiraId}, 判定=${humanJudge || "(清空)"}`,
    )

    // 3. 参数与表存在性校验（查数据所属用户的库）
    // 注意：humanJudge 允许为空——评审页选择「未判定」时传空字符串，表示清空人工判定
    if (!table || !tableExists(owner, table)) return errorResponse(`数据表「${table}」不存在`, 404)
    if (!jiraId) return errorResponse("缺少 jiraId")

    // 4. 写入数据库
    const changes = updateReview(owner, table, jiraId, humanJudge, humanJudgeReason)
    if (changes === 0) {
      return errorResponse(`保存失败：未找到工单 ${jiraId}`, 404)
    }
    console.log(`[API review] 保存成功，影响 ${changes} 行`)
    return Response.json({ ok: true, changes })
  } catch (err) {
    console.error("[API review] 保存失败:", err)
    return errorResponse("保存评审失败，请查看服务端日志", 500)
  }
}
