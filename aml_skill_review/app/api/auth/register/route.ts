// ============================================================
// API：POST /api/auth/register
// 作用：注册普通用户（第一个管理员由登录接口自动创建，
// 之后的新账号都通过这个接口注册，注册成功自动登录）。
// 请求体：{ username, password }
// 返回：{ ok, username, isAdmin:false }，并通过 Set-Cookie 写入会话。
// ============================================================

import { isValidUsername } from "@/lib/config"
import {
  createSession,
  createUser,
  getUserByName,
  sessionCookie,
  userCount,
} from "@/lib/auth"
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
    if (userCount() === 0) {
      return errorResponse("系统还没有账号，请先在「登录」页签创建管理员账号")
    }
    if (getUserByName(username)) return errorResponse("该登录名已被使用")

    // 3. 创建普通用户并自动登录
    createUser(username, password, false)
    const token = createSession(username)
    console.log(`[API 注册] 新用户「${username}」注册成功`)
    return Response.json(
      { ok: true, username, isAdmin: false },
      { headers: { "Set-Cookie": sessionCookie(token) } },
    )
  } catch (err) {
    console.error("[API 注册] 失败:", err)
    return errorResponse("注册失败，请查看服务端日志", 500)
  }
}
