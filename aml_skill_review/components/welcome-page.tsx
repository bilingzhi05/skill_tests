// ============================================================
// 首页（欢迎页）组件
// 作用：登录后首先看到的页面。展示欢迎提示词、系统包含的
// 全部功能和对应的功能按键（卡片），点击卡片进入对应功能页。
// 各功能的导航入口同时也统一在顶部导航栏里。
// ============================================================

"use client"

import Link from "next/link"
import {
  Activity,
  ArrowRight,
  BarChart3,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AppNavbar } from "@/components/app-navbar"

/** 功能卡片：图标、标题、说明、入口地址、是否仅管理员 */
const FEATURES: {
  href: string
  title: string
  desc: string
  icon: typeof LayoutDashboard
  adminOnly?: boolean
}[] = [
  {
    href: "/analysis",
    title: "质量分析",
    desc: "选择 xlsx 数据文件自动导入，按大模型/人工判定过滤查看，进入详情逐条评审。",
    icon: LayoutDashboard,
  },
  {
    href: "/skills",
    title: "Skill 管理",
    desc: "管理 Skill 资源：上传 zip 压缩包或文件夹（上传后需审核）、预览文件内容、删除、设置所有者。",
    icon: Wrench,
  },
  {
    href: "/tasks",
    title: "Skill 分析任务",
    desc: "创建 skill 分析任务，选择 JQL 查询范围，自动排队执行并生成 xlsx 结果。",
    icon: Activity,
  },
  {
    href: "/type-stats",
    title: "同Skill结果对比全览",
    desc: "勾选多张数据表按 Jira ID 对齐，逐行对比各表判定是否一致，只看差异一键切换。",
    icon: BarChart3,
  },
  {
    href: "/users",
    title: "用户管理",
    desc: "管理员可修改所有账号的登录名和密码、新增普通用户。",
    icon: Users,
    adminOnly: true,
  },
]

export function WelcomePage({ username, isAdmin }: { username: string; isAdmin: boolean }) {
  const visible = FEATURES.filter((f) => !f.adminOnly || isAdmin)

  return (
    <div className="min-h-screen">
      <AppNavbar username={username} isAdmin={isAdmin} />

      <main className="mx-auto w-full max-w-5xl px-4 py-12 md:px-8 md:py-16">
        {/* ========== 欢迎提示词 ========== */}
        <section className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="size-4" />
            欢迎使用 Jira Skill 评审系统
          </div>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            {isAdmin ? "你好，管理员 " : "你好，"}<span className="text-primary">{username}</span>
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
            这是一个面向 Jira 工单的 Skill 质量评审平台。你可以在这里导入数据、逐条评审，
            也可以管理 Skill 资源、创建分析任务、对比不同表的结果。
            选择下方功能卡片开始使用，所有功能也可随时通过顶部导航栏切换。
          </p>
        </section>

        {/* ========== 功能展示与按键 ========== */}
        <section className="mt-10">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ShieldCheck className="size-4" />
            功能总览
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((f, i) => {
              const Icon = f.icon
              return (
                <Link
                  key={f.href}
                  href={f.href}
                  className={cn(
                    "group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border bg-card p-5",
                    "transition-all duration-300 hover:-translate-y-1 hover:border-ring hover:shadow-lg",
                    "animate-in fade-in slide-in-from-bottom-2 duration-500",
                  )}
                  style={{ animationDelay: `${80 * i}ms` }}
                >
                  {/* 顶部渐变装饰 */}
                  <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                  <div>
                    <div className="mb-4 inline-flex rounded-xl bg-primary/5 p-2.5 text-primary transition-transform duration-300 group-hover:scale-110">
                      <Icon className="size-5" />
                    </div>
                    <h2 className="text-base font-semibold">{f.title}</h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
                  </div>
                  <span
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                      "mt-5 self-start gap-1 opacity-90 transition-all duration-300 group-hover:gap-2 group-hover:border-primary group-hover:text-primary",
                    )}
                  >
                    进入
                    <ArrowRight className="size-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
                  </span>
                </Link>
              )
            })}
          </div>
        </section>

        {/* ========== 底部角色提示 ========== */}
        <footer className="mt-12 border-t border-border pt-6 text-xs leading-relaxed text-muted-foreground">
          <p>
            当前登录：<span className="font-mono font-medium text-foreground">{username}</span>
            （{isAdmin ? "管理员" : "普通用户"}）
            {isAdmin && " · 可查看/评审所有用户的数据并管理账号"}
            仅管理员可见的功能：用户管理。
          </p>
        </footer>
      </main>
    </div>
  )
}