// ============================================================
// 用户管理页路由（/users，仅管理员）
// 作用：Next.js 页面入口。先检查登录状态和管理员身份：
// 未登录 → 跳转 /login；不是管理员 → 跳回首页。
// ============================================================

import { redirect } from "next/navigation"
import { getPageUser } from "@/lib/auth"
import { UsersPage } from "@/components/users-page"

export default async function Page() {
  // 1. 未登录跳转登录页
  const user = await getPageUser()
  if (!user) redirect("/login")
  // 2. 普通用户不能访问用户管理页
  if (user.is_admin !== 1) redirect("/")
  return <UsersPage />
}
