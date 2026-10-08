// ============================================================
// 用户管理页组件（仅管理员可见）
// 作用：管理员在这里管理所有账号（包括其他管理员）：
//  1. 查看全部用户列表；
//  2. 新增用户（登录名 + 密码）；
//  3. 修改任意用户的登录名 和/或 密码（留空的项不修改）。
// ============================================================

"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ArrowLeft, Loader2, Save, UserPlus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/** 用户列表里的一个账号 */
type UserItem = {
  id: number
  username: string
  isAdmin: boolean
  create_t: string
}

export function UsersPage() {
  // ---------- 页面状态 ----------
  const [users, setUsers] = useState<UserItem[]>([]) // 全部账号
  const [loading, setLoading] = useState(true) // 正在加载
  const [loadError, setLoadError] = useState("") // 加载失败原因

  // ---------- 每个账号的修改输入（按 id 存放：新登录名、新密码） ----------
  const [editNames, setEditNames] = useState<Record<number, string>>({})
  const [editPasswords, setEditPasswords] = useState<Record<number, string>>({})

  // ---------- 新增账号表单 ----------
  const [newUsername, setNewUsername] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [adding, setAdding] = useState(false)

  /**
   * 加载用户列表。
   * 作用：调用 /api/users（仅管理员可访问）获取全部账号。
   */
  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users")
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取用户列表失败")
      setUsers(data.users || [])
      console.log("[用户管理] 加载用户列表成功:", data.users)
    } catch (err) {
      console.error("[用户管理] 加载失败:", err)
      setLoadError(String(err instanceof Error ? err.message : err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  /**
   * 保存某个账号的修改。
   * 作用：把「新登录名 / 新密码」提交给 /api/users（PUT），
   * 留空的项保持原值不变。
   */
  async function handleSave(user: UserItem) {
    const newName = (editNames[user.id] || "").trim()
    const newPassword = editPasswords[user.id] || ""
    if (!newName && !newPassword) {
      toast.error("请先填写要修改的新登录名或新密码")
      return
    }
    try {
      const res = await fetch("/api/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, username: newName, password: newPassword }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "修改失败")
      toast.success("已保存", { description: `账号 ${user.username} 已更新` })
      // 清空输入并刷新列表
      setEditNames((m) => ({ ...m, [user.id]: "" }))
      setEditPasswords((m) => ({ ...m, [user.id]: "" }))
      await loadUsers()
    } catch (err) {
      console.error("[用户管理] 修改失败:", err)
      toast.error("修改失败", { description: String(err instanceof Error ? err.message : err) })
    }
  }

  /**
   * 新增账号。
   * 作用：管理员创建新用户（普通用户），创建后出现在列表里。
   */
  async function handleAdd() {
    if (!newUsername.trim() || !newPassword) {
      toast.error("请输入新账号的登录名和密码")
      return
    }
    setAdding(true)
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "新增失败")
      toast.success("新增成功", { description: `账号 ${newUsername.trim()} 已创建` })
      setNewUsername("")
      setNewPassword("")
      await loadUsers()
    } catch (err) {
      console.error("[用户管理] 新增失败:", err)
      toast.error("新增失败", { description: String(err instanceof Error ? err.message : err) })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
      {/* 顶部导航 */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <Link href="/" className={buttonVariants({ variant: "ghost", size: "sm", className: "-ml-2" })}>
          <ArrowLeft className="size-4" />
          返回列表
        </Link>
        <span className="text-sm text-muted-foreground">仅管理员可见</span>
      </div>

      <header className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">账号管理</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">用户管理</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          管理员可以修改所有账号（包括管理员）的登录名和密码；新增的账号都是普通用户。
          登录名同时是每个用户的数据文件夹名，请谨慎修改。
        </p>
      </header>

      <div className="space-y-6">
        {/* 新增账号 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">新增用户</CardTitle>
            <CardDescription>创建一个新的普通用户账号</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3 md:flex-row md:items-end">
              <div className="w-full space-y-1.5 md:w-56">
                <Label htmlFor="new-username">登录名</Label>
                <Input
                  id="new-username"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="例如 zhang.san"
                />
              </div>
              <div className="w-full space-y-1.5 md:w-56">
                <Label htmlFor="new-password">密码（至少 6 位）</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <Button onClick={handleAdd} disabled={adding} className="md:mb-0.5">
                {adding ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                新增
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 用户列表 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">全部用户</CardTitle>
            <CardDescription>修改登录名或密码：填写要改的项，留空的项保持不变</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> 加载中…
              </p>
            ) : loadError ? (
              <p className="py-8 text-center text-sm text-destructive">{loadError}</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead className="w-[160px]">登录名</TableHead>
                      <TableHead className="w-[90px]">角色</TableHead>
                      <TableHead className="w-[170px]">创建时间</TableHead>
                      <TableHead className="min-w-[150px]">新登录名</TableHead>
                      <TableHead className="min-w-[150px]">新密码</TableHead>
                      <TableHead className="w-[90px] text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="font-mono text-sm font-medium">{u.username}</TableCell>
                        <TableCell>
                          <Badge variant={u.isAdmin ? "default" : "secondary"}>
                            {u.isAdmin ? "管理员" : "普通用户"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{u.create_t}</TableCell>
                        <TableCell>
                          <Input
                            value={editNames[u.id] || ""}
                            onChange={(e) => setEditNames((m) => ({ ...m, [u.id]: e.target.value }))}
                            placeholder={u.username}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="password"
                            value={editPasswords[u.id] || ""}
                            onChange={(e) =>
                              setEditPasswords((m) => ({ ...m, [u.id]: e.target.value }))
                            }
                            placeholder="不修改请留空"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" onClick={() => handleSave(u)}>
                            <Save className="size-3.5" />
                            保存
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
