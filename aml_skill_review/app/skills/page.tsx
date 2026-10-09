// ============================================================
// Skill 管理页路由（/skills）
// 作用：Next.js 页面入口。先检查登录状态：未登录跳转 /login；
// 已登录则把「当前登录名、是否管理员」传给 Skill 管理页组件，
// 由组件渲染上传/预览/删除/设置所有者等功能。
// ============================================================

import { redirect } from "next/navigation"
import { getPageUser } from "@/lib/auth"
import { SkillsPage } from "@/components/skills-page"

export default async function Page() {
  // 未登录 → 跳转登录页
  const user = await getPageUser()
  if (!user) redirect("/login")
  return <SkillsPage username={user.username} isAdmin={user.is_admin === 1} />
}
