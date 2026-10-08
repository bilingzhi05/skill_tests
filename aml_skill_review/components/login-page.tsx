// ============================================================
// 登录页组件
// 作用：整个系统的入口页面，包含三个页签：
//  1. 登录：输入登录名 + 密码；系统第一次使用时，
//     第一个登录的人会自动成为管理员（admin）；
//  2. 注册：创建普通用户账号（注册成功自动登录）；
//  3. 修改密码：普通用户不用登录也能改自己的密码（需输原密码）。
// 登录 / 注册成功后自动跳转到列表页（/）。
// ============================================================

"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, LogIn, ShieldCheck, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** 三个页签：登录 / 注册 / 修改密码 */
type Mode = "login" | "register" | "change"

export function LoginPage() {
  const router = useRouter()

  // ---------- 页面状态 ----------
  const [mode, setMode] = useState<Mode>("login") // 当前页签
  const [checking, setChecking] = useState(true) // 正在检查登录状态
  const [firstUse, setFirstUse] = useState(false) // 系统还没有任何账号
  const [submitting, setSubmitting] = useState(false) // 正在提交

  // ---------- 表单内容 ----------
  const [username, setUsername] = useState("") // 登录名
  const [password, setPassword] = useState("") // 密码（登录/注册）
  const [oldPassword, setOldPassword] = useState("") // 修改密码：原密码
  const [newPassword, setNewPassword] = useState("") // 修改密码：新密码

  /**
   * 页面打开时先检查状态。
   * 作用：已经登录过就直接回首页；系统没有任何账号时
   * 提示「将创建管理员账号」。
   */
  useEffect(() => {
    async function check() {
      try {
        const res = await fetch("/api/auth/status")
        const data = await res.json()
        if (data.loggedIn) {
          router.replace("/")
          return
        }
        setFirstUse((data.userCount || 0) === 0)
        console.log("[登录页] 状态检查完成, userCount =", data.userCount)
      } catch (err) {
        console.error("[登录页] 状态检查失败:", err)
      } finally {
        setChecking(false)
      }
    }
    check()
  }, [router])

  /**
   * 提交表单（按当前页签调用不同接口）。
   * 作用：登录/注册成功后服务器会写入 Cookie，前端直接跳首页。
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      if (mode === "login") {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "登录失败")
        toast.success(
          data.firstUser ? "已创建管理员账号并登录" : "登录成功",
          { description: `欢迎，${data.username}` },
        )
        router.replace("/")
      } else if (mode === "register") {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "注册失败")
        toast.success("注册成功", { description: `欢迎，${data.username}` })
        router.replace("/")
      } else {
        const res = await fetch("/api/auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, oldPassword, newPassword }),
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "修改密码失败")
        toast.success("密码修改成功", { description: "请使用新密码登录" })
        setOldPassword("")
        setNewPassword("")
        setMode("login")
      }
    } catch (err) {
      console.error("[登录页] 提交失败:", err)
      toast.error("操作失败", { description: String(err instanceof Error ? err.message : err) })
    } finally {
      setSubmitting(false)
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> 正在检查登录状态…
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <header className="mb-6 text-center">
          <p className="text-sm font-medium text-muted-foreground">质量分析</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Jira Skill 评审系统</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            登录后只能查看、加载自己文件夹里的数据
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {mode === "login" ? "登录" : mode === "register" ? "注册新账号" : "修改密码"}
            </CardTitle>
            <CardDescription>
              {mode === "login"
                ? firstUse
                  ? "系统还没有账号，第一个登录的人将成为管理员"
                  : "请输入登录名和密码"
                : mode === "register"
                  ? "注册普通用户，登录名就是你的数据文件夹名"
                  : "输入登录名、原密码和新密码"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* 页签切换 */}
            <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {(
                [
                  { key: "login", label: "登录" },
                  { key: "register", label: "注册" },
                  { key: "change", label: "修改密码" },
                ] as { key: Mode; label: string }[]
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setMode(t.key)}
                  className={`rounded-md px-2 py-1.5 text-sm transition-colors ${
                    mode === t.key
                      ? "bg-background font-medium shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">登录名</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="例如 lingzhi.bi"
                  autoComplete="username"
                />
                <p className="text-xs text-muted-foreground">
                  只能包含字母、数字、点、下划线、连字符；登录名同时是你的数据文件夹名
                </p>
              </div>

              {mode === "change" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="oldPassword">原密码</Label>
                    <Input
                      id="oldPassword"
                      type="password"
                      value={oldPassword}
                      onChange={(e) => setOldPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">新密码（至少 6 位）</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="password">密码{mode === "login" ? "" : "（至少 6 位）"}</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                  />
                </div>
              )}

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : mode === "login" ? (
                  <LogIn className="size-4" />
                ) : mode === "register" ? (
                  <UserPlus className="size-4" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                {mode === "login" ? (firstUse ? "创建管理员并登录" : "登录") : mode === "register" ? "注册并登录" : "修改密码"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
