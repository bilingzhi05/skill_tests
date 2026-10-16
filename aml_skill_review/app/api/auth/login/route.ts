// ============================================================
// API：POST /api/auth/login
// 作用：登录接口。登录顺序：
//  1. LDAP 优先：后端（process_skills/server）若配置了 LDAP，
//     用「登录名 + 密码」做域账号 bind 校验（密码仅用于 bind，不落库）；
//     校验通过则自动为该登录名建档（首个账号自动成为管理员）并建立会话。
//  2. 本地密码兜底：LDAP 未配置 / 校验未通过时，回退本地密码校验；
//     此时系统第一次使用时，第一个登录的人自动成为管理员。
// 请求体：{ username, password }
// 返回：{ ok, username, isAdmin, firstUser? }，并通过 Set-Cookie 写入会话。
// ============================================================

import { isValidUsername } from "@/lib/config"
import {
  createSession,
  createUser,
  provisionLdapUser,
  sessionCookie,
  userCount,
  verifyUser,
} from "@/lib/auth"
import { errorResponse } from "@/lib/api-utils"
import { ldapVerify } from "@/lib/ldap"

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

    // 3. LDAP 优先（后端配置了 LDAP_SERVER 才生效；后端不可用时按未启用处理）
    const ldap = await ldapVerify(username, password)
    if (ldap.authenticated) {
      const user = provisionLdapUser(username)
      const token = createSession(user.username)
      console.log(`[API 登录] 用户「${username}」LDAP 登录成功，管理员=${user.is_admin === 1}`)
      return Response.json(
        { ok: true, username: user.username, isAdmin: user.is_admin === 1 },
        { headers: { "Set-Cookie": sessionCookie(token) } },
      )
    }

    // 4. 本地密码兜底（LDAP 账号无本地密码，会落到这里直接失败）
    if (password.length < 6) return errorResponse("密码至少 6 位")

    // 4.1 第一次使用：自动把第一个登录的人创建为管理员
    if (userCount() === 0) {
      createUser(username, password, true)
      const token = createSession(username)
      console.log(`[API 登录] 首次使用，已创建管理员「${username}」`)
      return Response.json(
        { ok: true, username, isAdmin: true, firstUser: true },
        { headers: { "Set-Cookie": sessionCookie(token) } },
      )
    }

    // 4.2 正常登录：校验「登录名 + 密码」
    const user = verifyUser(username, password)
    if (!user) {
      console.warn(`[API 登录] 登录失败: ${username}`)
      return errorResponse(ldap.enabled ? "LDAP 校验失败，且本地密码不正确" : "登录名或密码错误", 401)
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
