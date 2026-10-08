// ============================================================
// API：POST /api/auth/logout
// 作用：退出登录。删除服务端会话，并清除浏览器 Cookie。
// 返回：{ ok }
// ============================================================

import { deleteSession, getTokenFromRequest, sessionCookie } from "@/lib/auth"

export async function POST(request: Request) {
  try {
    // 删除会话（没有 Cookie 也不会报错），并把 Cookie 设为过期
    const token = getTokenFromRequest(request)
    deleteSession(token)
    console.log("[API 登出] 已退出登录")
    return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } })
  } catch (err) {
    console.error("[API 登出] 失败:", err)
    return Response.json({ ok: false, error: "退出登录失败" }, { status: 500 })
  }
}
