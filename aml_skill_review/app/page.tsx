// ============================================================
// 列表页路由（首页 /）
// 作用：Next.js 页面入口。先检查登录状态：未登录跳转 /login；
// 已登录则把「当前登录名、是否管理员」传给列表页组件，
// 列表页只显示该用户自己文件夹里的数据。
// ============================================================

import { redirect } from "next/navigation"
import { getPageUser } from "@/lib/auth"
import { ListPage } from "@/components/list-page"

export default async function Page() {
  // 未登录 → 跳转登录页
  const user = await getPageUser()
  if (!user) redirect("/login")
  return <ListPage username={user.username} isAdmin={user.is_admin === 1} />
}
