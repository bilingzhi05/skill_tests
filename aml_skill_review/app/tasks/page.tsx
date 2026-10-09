// ============================================================
// 任务管理页路由（/tasks）
// 作用：Next.js 页面入口。先检查登录状态：未登录跳转 /login；
// 已登录则把「当前登录名、是否管理员」传给任务页组件，
// 组件只显示该用户自己的任务（管理员看全部）。
// ============================================================

import { redirect } from "next/navigation"
import { getPageUser } from "@/lib/auth"
import { TasksPage } from "@/components/tasks-page"

export default async function Page() {
  // 未登录 → 跳转登录页
  const user = await getPageUser()
  if (!user) redirect("/login")
  return <TasksPage username={user.username} isAdmin={user.is_admin === 1} />
}
