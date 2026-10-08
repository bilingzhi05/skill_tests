// ============================================================
// 详情评审页路由（/review/[id]）
// 作用：Next.js 动态路由入口。先检查登录状态（未登录跳转 /login），
// 再从网址里取出 Jira ID（[id]）和表名（?table=xxx），
// 传给详情评审页组件渲染。
// 例如访问 /review/ABC-123?table=test 会打开 test 表里的 ABC-123 工单。
// ============================================================

import { redirect } from "next/navigation"
import { getPageUser } from "@/lib/auth"
import { ReviewPage } from "@/components/review-page"

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ table?: string; v?: string; h?: string; user?: string }>
}) {
  // 1. 未登录 → 跳转登录页
  const user = await getPageUser()
  if (!user) redirect("/login")
  // 2. Next.js 16 中 params / searchParams 是异步对象，需要 await
  const { id } = await params
  const sp = await searchParams
  return (
    <ReviewPage
      jiraId={decodeURIComponent(id)}
      table={sp.table || ""}
      verdictFilter={sp.v || ""}
      humanFilter={sp.h || ""}
      // 管理员评审其他用户的工单时，数据读写都走该用户的库
      dataUser={sp.user || ""}
    />
  )
}
