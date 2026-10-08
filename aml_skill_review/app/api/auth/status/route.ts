// ============================================================
// API：GET /api/auth/status
// 作用：登录页打开时调用，判断两件事：
//  1. 系统里是否还没有任何账号（决定要不要提示「创建管理员」）；
//  2. 当前浏览器是否已经登录过（已登录就直接跳回首页）。
// 返回：{ ok, userCount, loggedIn, username?, isAdmin? }
// ============================================================

import { getRequestUser, userCount } from "@/lib/auth"

export async function GET(request: Request) {
  const user = getRequestUser(request)
  return Response.json({
    ok: true,
    userCount: userCount(),
    loggedIn: !!user,
    username: user?.username || "",
    isAdmin: user ? user.is_admin === 1 : false,
  })
}
