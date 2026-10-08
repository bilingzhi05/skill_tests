// ============================================================
// API：POST /api/auth/login
// 作用：登录接口。特殊规则：系统第一次使用时还没有任何账号，
// 此时第一个登录的人会自动创建为管理员（admin）；
// 之后登录只做「登录名 + 密码」校验。
// 请求体：{ username, password }
// 返回：{ ok, username, isAdmin, firstUser? }，并通过 Set-Cookie 写入会话。
// ============================================================

import { isValidUsername } from "@/lib/config"
import { createSession, createUser, sessionCookie, userCount, verifyUser } from "@/lib/auth"
import { errorResponse } from "@/lib/api-utils"

export async function POST(request: Request) {
  try {
    // 1. 解析请求体
    let body: { username?: string; password?: string }
    try {
      body = await request.json()
    } catch {
      return errorResponse("请求体不是合法的 JSON")
    }
    const username = String(body.username || "").trim()
    const password = String(body.password || "")

    // 2. 基础校验
    if (!username || !password) return errorResponse("请输入登录名和密码")
    if (!isValidUsername(username)) {
      return errorResponse("登录名只能包含字母、数字、点、下划线、连字符，长度 2~50")
    }
    if (password.length < 6) return errorResponse("密码至少 6 位")

    // 3. 第一次使用：自动把第一个登录的人创建为管理员
    if (userCount() === 0) {
      createUser(username, password, true)
      const token = createSession(username)
      console.log(`[API 登录] 首次使用，已创建管理员「${username}」`)
      return Response.json(
        { ok: true, username, isAdmin: true, firstUser: true },
        { headers: { "Set-Cookie": sessionCookie(token) } },
      )
    }

    // 4. 正常登录：校验「登录名 + 密码」
    const user = verifyUser(username, password)
    if (!user) {
      console.warn(`[API 登录] 登录失败: ${username}`)
      return errorResponse("登录名或密码错误", 401)
    }
    const token = createSession(username)
    console.log(`[API 登录] 用户「${username}」登录成功，管理员=${user.is_admin === 1}`)
    return Response.json(
      { ok: true, username: user.username, isAdmin: user.is_admin === 1 },
      { headers: { "Set-Cookie": sessionCookie(token) } },
    )
  } catch (err) {
    console.error("[API 登录] 失败:", err)
    return errorResponse("登录失败，请查看服务端日志", 500)
  }
}
