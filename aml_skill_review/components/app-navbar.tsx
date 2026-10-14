// ============================================================
// 统一顶部导航栏（全站所有页面固定在最顶部）
// 作用：把各页面分散的功能选择按键集中到这里，固定在页面顶部，
// 风格统一、可滑动不跟随内容滚走。用 usePathname 高亮当前所在页。
// 右侧显示当前登录用户和角色，退出登录按钮也统一放在这里。
// ============================================================

"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Activity,
  BarChart3,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { NotificationCenter } from "@/components/notification-center"
import { cn } from "@/lib/utils"

/** 导航项：href 目标、显示名称、图标、是否仅管理员可见 */
const NAV_ITEMS: {
  href: string
  label: string
  icon: typeof LayoutDashboard
  adminOnly?: boolean
}[] = [
  { href: "/analysis", label: "质量分析", icon: LayoutDashboard },
  { href: "/skills", label: "Skill 管理", icon: Wrench },
  { href: "/tasks", label: "Skill 分析任务", icon: Activity },
  { href: "/type-stats", label: "结果对比全览", icon: BarChart3 },
  { href: "/users", label: "用户管理", icon: Users, adminOnly: true },
]

export function AppNavbar({ username, isAdmin }: { username: string; isAdmin: boolean }) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" })
      console.log("[导航栏] 已退出登录")
    } catch (err) {
      console.error("[导航栏] 退出登录失败:", err)
    }
    router.push("/login")
  }

  /** 判断当前页是否属于某个导航项（统计/详情属于质量分析） */
  function isActive(href: string): boolean {
    if (href === "/analysis") {
      return pathname === "/analysis" || pathname.startsWith("/review") || pathname.startsWith("/stats")
    }
    return pathname === href || pathname.startsWith(`${href}/`)
  }

  return (
    <header className="sticky top-0 z-50 w-full animate-in fade-in slide-in-from-top-2 border-b border-border bg-background/85 shadow-sm backdrop-blur duration-300 supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex min-h-14 w-full max-w-7xl flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-2 md:px-8">
        {/* 品牌 + 欢迎提示词：小屏只显示图标，给功能按键留足空间 */}
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-transform duration-300 group-hover:rotate-12">
            <Sparkles className="size-4" />
          </span>
          <span className="hidden lg:inline">Jira Skill 评审系统</span>
        </Link>

        {/* 统一的功能选择按键：各页面的导航入口全部集中在这里 */}
        {/* flex-wrap + 始终显示文字标签，保证所有功能按键完整展示、无横向滚动 */}
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => {
            const active = isActive(item.href)
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-200",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                <span className="inline">{item.label}</span>
                {/* 未激活时底部的小指示点动画 */}
                <span
                  className={cn(
                    "absolute inset-x-2 -bottom-[13px] h-0.5 rounded-full bg-primary transition-all duration-300",
                    active ? "opacity-100" : "opacity-0",
                  )}
                />
              </Link>
            )
          })}
        </nav>

        {/* 通知中心（统一铃铛：待审批 + 审批结果）+ 当前用户 + 角色 + 退出登录 */}
        <div className="flex shrink-0 items-center gap-2">
          <NotificationCenter username={username} isAdmin={isAdmin} />
          <div className="hidden items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs sm:flex">
            <span className="max-w-28 truncate font-medium text-foreground">{username}</span>
            <span
              className={cn(
                "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                isAdmin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              <ShieldCheck className="size-3" />
              {isAdmin ? "管理员" : "普通用户"}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout} aria-label="退出登录">
            <LogOut className="size-4" />
            <span className="hidden md:inline">退出</span>
          </Button>
        </div>
      </div>
    </header>
  )
}