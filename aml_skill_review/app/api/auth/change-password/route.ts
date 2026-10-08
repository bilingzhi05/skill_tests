// ============================================================
// API：POST /api/auth/change-password
// 作用：修改自己的密码（登录页「修改密码」页签使用，
// 普通用户不需要先登录也能改自己的密码，但必须输对原密码）。
// 请求体：{ username, oldPassword, newPassword }
// 返回：{ ok }
// ============================================================

import { getPasswordHash, getUserByName, updateUser, verifyPassword } from "@/lib/auth"
import { errorResponse } from "@/lib/api-utils"

export async function POST(request: Request) {
  try {
    // 1. 解析请求体
    let body: { username?: string; oldPassword?: string; newPassword?: string }
    try {
      body = await request.json()
    } catch {
      return errorResponse("请求体不是合法的 JSON")
    }
    const username = String(body.username || "").trim()
    const oldPassword = String(body.oldPassword || "")
    const newPassword = String(body.newPassword || "")

    // 2. 基础校验
    if (!username || !oldPassword || !newPassword) {
      return errorResponse("请输入登录名、原密码和新密码")
    }
    if (newPassword.length < 6) return errorResponse("新密码至少 6 位")

    // 3. 校验原密码
    const user = getUserByName(username)
    const stored = user ? getPasswordHash(username) : null
    if (!user || !stored || !verifyPassword(oldPassword, stored)) {
      console.warn(`[API 改密] 用户「${username}」原密码校验失败`)
      return errorResponse("登录名或原密码不正确", 401)
    }

    // 4. 更新密码
    updateUser(user.id, { password: newPassword })
    console.log(`[API 改密] 用户「${username}」密码修改成功`)
    return Response.json({ ok: true })
  } catch (err) {
    console.error("[API 改密] 失败:", err)
    return errorResponse("修改密码失败，请查看服务端日志", 500)
  }
}
