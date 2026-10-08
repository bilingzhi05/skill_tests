// ============================================================
// 同Skill结果对比全览页路由（/type-stats）
// 作用：Next.js 页面入口。先检查登录状态（未登录跳转 /login），
// 再把管理员查看他人用的 user 参数传给页面组件渲染。
// ============================================================

import { redirect } from "next/navigation"
import { getPageUser } from "@/lib/auth"
import { TypeStatsPage } from "@/components/type-stats-page"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>
}) {
  // 1. 未登录 → 跳转登录页
  const user = await getPageUser()
  if (!user) redirect("/login")
  // 2. 管理员查看其他用户的对比时带上 user 参数
  const sp = await searchParams
  return <TypeStatsPage dataUser={sp.user || ""} />
}
