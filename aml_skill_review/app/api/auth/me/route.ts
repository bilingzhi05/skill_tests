// ============================================================
// API：GET /api/auth/me
// 作用：查询「当前浏览器登录的是谁」。
// 页面打开时用它显示当前用户名、判断是否管理员。
// 返回：已登录 { ok, username, isAdmin }；未登录返回 401。
// ============================================================

import { getRequestUser } from "@/lib/auth"
import { errorResponse } from "@/lib/api-utils"

export async function GET(request: Request) {
  const user = getRequestUser(request)
  if (!user) return errorResponse("未登录", 401)
  return Response.json({ ok: true, username: user.username, isAdmin: user.is_admin === 1 })
}
