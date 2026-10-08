// ============================================================
// 统计页路由（/stats）
// 作用：Next.js 页面入口。先检查登录状态（未登录跳转 /login），
// 再从网址参数 ?table=xxx 取出当前数据表名，传给统计页组件渲染。
// 例如 /stats?table=test-Nagracas-0731_220001。
// ============================================================

import { redirect } from "next/navigation"
import { getPageUser } from "@/lib/auth"
import { StatsPage } from "@/components/stats-page"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ table?: string; user?: string }>
}) {
  // 1. 未登录 → 跳转登录页
  const user = await getPageUser()
  if (!user) redirect("/login")
  // 2. Next.js 16 中 searchParams 是异步对象，需要 await
  const sp = await searchParams
  // 管理员查看其他用户的统计时带上 user 参数
  return <StatsPage table={sp.table || ""} dataUser={sp.user || ""} />
}
