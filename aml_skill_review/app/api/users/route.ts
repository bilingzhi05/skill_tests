// ============================================================
// API：/api/users（仅管理员可用）
// 作用：管理员管理所有账号（包括其他管理员）：
//   GET  列出全部用户；
//   POST 新增用户（登录名 + 密码）；
//   PUT  修改任意用户的登录名 和/或 密码。
// 非管理员访问一律返回 403。
// ============================================================

import { isValidUsername } from "@/lib/config"
import {
  createUser,
  getUserById,
  getUserByName,
  listUsers,
  updateUser,
} from "@/lib/auth"
import type { AuthUser } from "@/lib/auth"
import { getRequestUser } from "@/lib/auth"
import { errorResponse } from "@/lib/api-utils"

/** 校验当前请求者必须是管理员，否则返回错误响应 */
function requireAdmin(request: Request): { user: AuthUser } | { error: Response } {
  const user = getRequestUser(request)
  if (!user) return { error: errorResponse("请先登录", 401) }
  if (user.is_admin !== 1) return { error: errorResponse("只有管理员可以访问用户管理", 403) }
  return { user }
}

/** GET：列出全部用户 */
export async function GET(request: Request) {
  const checked = requireAdmin(request)
  if ("error" in checked) return checked.error
  const users = listUsers().map((u) => ({
    id: u.id,
    username: u.username,
    isAdmin: u.is_admin === 1,
    create_t: u.create_t,
  }))
  return Response.json({ ok: true, users })
}

/** POST：新增用户 { username, password } */
export async function POST(request: Request) {
  const checked = requireAdmin(request)
  if ("error" in checked) return checked.error
  try {
    let body: { username?: string; password?: string }
    try {
      body = await request.json()
    } catch {
      return errorResponse("请求体不是合法的 JSON")
    }
    const username = String(body.username || "").trim()
    const password = String(body.password || "")
    if (!username || !password) return errorResponse("请输入登录名和密码")
    if (!isValidUsername(username)) {
      return errorResponse("登录名只能包含字母、数字、点、下划线、连字符，长度 2~50")
    }
    if (password.length < 6) return errorResponse("密码至少 6 位")
    if (getUserByName(username)) return errorResponse("该登录名已被使用")
    const created = createUser(username, password, false)
    console.log(`[API 用户管理] 管理员新增用户「${username}」`)
    return Response.json({
      ok: true,
      user: { id: created.id, username: created.username, isAdmin: false, create_t: created.create_t },
    })
  } catch (err) {
    console.error("[API 用户管理] 新增用户失败:", err)
    return errorResponse("新增用户失败，请查看服务端日志", 500)
  }
}

/** PUT：修改用户 { id, username?, password? }（登录名和密码可以只改其中一个） */
export async function PUT(request: Request) {
  const checked = requireAdmin(request)
  if ("error" in checked) return checked.error
  try {
    let body: { id?: number; username?: string; password?: string }
    try {
      body = await request.json()
    } catch {
      return errorResponse("请求体不是合法的 JSON")
    }
    const id = Number(body.id)
    const newUsername = String(body.username || "").trim()
    const newPassword = String(body.password || "")
    if (!id) return errorResponse("缺少用户编号 id")

    const target = getUserById(id)
    if (!target) return errorResponse("用户不存在", 404)

    // 校验新登录名（有传才校验）
    if (newUsername) {
      if (!isValidUsername(newUsername)) {
        return errorResponse("登录名只能包含字母、数字、点、下划线、连字符，长度 2~50")
      }
      const existed = getUserByName(newUsername)
      if (existed && existed.id !== id) return errorResponse("该登录名已被使用")
    }
    // 校验新密码（有传才校验）
    if (newPassword && newPassword.length < 6) return errorResponse("密码至少 6 位")
    if (!newUsername && !newPassword) return errorResponse("没有要修改的内容")

    const ok = updateUser(id, {
      username: newUsername || undefined,
      password: newPassword || undefined,
    })
    if (!ok) return errorResponse("修改失败：用户不存在", 404)
    console.log(`[API 用户管理] 管理员修改用户 ${id}（新登录名=${newUsername || "(不变)"}）`)
    return Response.json({ ok: true })
  } catch (err) {
    console.error("[API 用户管理] 修改用户失败:", err)
    return errorResponse("修改用户失败，请查看服务端日志", 500)
  }
}
