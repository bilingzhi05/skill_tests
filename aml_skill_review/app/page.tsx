// ============================================================
// 首页路由（/）
// 作用：Next.js 页面入口。先检查登录状态：未登录跳转 /login；
// 已登录则展示欢迎页（欢迎提示词 + 功能展示 + 功能按键）。
// 各功能的具体入口见顶部导航栏。
// ============================================================

import { redirect } from "next/navigation"
import { getPageUser } from "@/lib/auth"
import { WelcomePage } from "@/components/welcome-page"

export default async function Page() {
  // 未登录 → 跳转登录页
  const user = await getPageUser()
  if (!user) redirect("/login")
  return <WelcomePage username={user.username} isAdmin={user.is_admin === 1} />
}