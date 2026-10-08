// ============================================================
// 列表页组件（首页主体）
// 作用：承载「第一部分：过滤条件」和「第二部分：列表展示」。
// 左侧侧边栏选择 xlsx 文件（自动导入或命中已有表），
// 右侧是过滤下拉 + 数据表格 + 导出按钮。
// 按用户隔离：只显示当前登录用户自己文件夹里的 xlsx 和数据表。
// 记忆功能：当前查看的文件/表会存到浏览器 localStorage
// （每个登录名用不同的 key），从其他页面返回本页时自动恢复。
// ============================================================

"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import * as XLSX from "xlsx"
import { toast } from "sonner"
import { ArrowRight, BarChart3, Download, FileSpreadsheet, Loader2, LogOut, UserRound, Users } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { VerdictBadge } from "@/components/verdict-badge"
import { FIELD_COLUMNS } from "@/lib/columns"

/** 列表行数据类型（数据库字段都是文本，可能为空） */
type Row = Record<string, string | null>

/**
 * localStorage 键名：记住上次选中的文件和数据表，返回本页时自动恢复。
 * 每个登录名 + 数据所属用户用不同的 key，不同用户/不同查看对象不会互相覆盖记忆。
 */
function lastTableKey(username: string, viewUser: string): string {
  return `skill-review:last-table:${username}:${viewUser}`
}

/** 生成导出文件名里的时间戳，例如 20260803_213005 */
function exportTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function ListPage({ username, isAdmin }: { username: string; isAdmin: boolean }) {
  const router = useRouter()

  // ---------- 页面状态 ----------
  const [viewUser, setViewUser] = useState(username) // 数据所属用户（管理员可切换成任何人）
  const [allUsers, setAllUsers] = useState<string[]>([]) // 全部用户名（管理员切换下拉用）
  const [files, setFiles] = useState<string[]>([]) // 可选的 xlsx 文件列表
  const [dirWarning, setDirWarning] = useState("") // 数据目录缺失提示
  const [selectedFile, setSelectedFile] = useState<string>("") // 当前选中的文件
  const [table, setTable] = useState<string>("") // 当前加载的数据表名
  const [importing, setImporting] = useState(false) // 正在导入
  const [loading, setLoading] = useState(false) // 正在查询列表
  const [exporting, setExporting] = useState(false) // 正在导出

  /** 数据所属用户不是自己时，链接和请求需要带上的 user 参数 */
  const userParam = viewUser !== username ? viewUser : ""

  // ---------- 过滤条件（第一部分） ----------
  const [filterVerdict, setFilterVerdict] = useState("") // 大模型判定过滤
  const [filterHuman, setFilterHuman] = useState("") // 人工判定过滤
  const [verdictOptions, setVerdictOptions] = useState<string[]>([]) // 大模型判定选项
  const [humanOptions, setHumanOptions] = useState<string[]>([]) // 人工判定选项

  // ---------- 列表数据（第二部分） ----------
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)

  /**
   * 加载 xlsx 文件列表。
   * 作用：页面打开（或切换数据所属用户）时调用 /api/files，
   * 拿到该用户目录下所有可选文件；管理员还会拿到全部用户名列表。
   */
  const loadFiles = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (viewUser !== username) params.set("user", viewUser)
      const res = await fetch(`/api/files${params.toString() ? `?${params.toString()}` : ""}`)
      // 会话失效 → 回到登录页
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取文件列表失败")
      setFiles(data.files || [])
      setDirWarning(data.warning || "")
      if (Array.isArray(data.users)) setAllUsers(data.users)
      console.log(`[列表页] 获取用户「${viewUser}」的文件列表成功:`, data.files)
    } catch (err) {
      console.error("[列表页] 获取文件列表失败:", err)
      toast.error("获取文件列表失败", { description: String(err) })
    }
  }, [router, username, viewUser])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  /**
   * 页面挂载时恢复记忆。
   * 作用：从评审页/统计页返回列表页时，自动恢复上次正在查看的
   * 文件和数据表，不需要重新选择数据文件。
   */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(lastTableKey(username, viewUser))
      if (!saved) {
        // 该用户没有记忆（常见于管理员刚切换查看对象）→ 清空当前选择
        setSelectedFile("")
        setTable("")
        setFilterVerdict("")
        setFilterHuman("")
        return
      }
      const parsed = JSON.parse(saved) as {
        file?: string
        table?: string
        verdict?: string
        human?: string
      }
      if (parsed.table) {
        console.log(`[列表页] 恢复用户「${viewUser}」上次查看的表和过滤条件:`, parsed)
        setSelectedFile(parsed.file || "")
        // 恢复过滤条件，重新拉取过滤后的列表（过滤条件保持不变）
        setFilterVerdict(parsed.verdict || "")
        setFilterHuman(parsed.human || "")
        setTable(parsed.table)
      } else {
        setSelectedFile("")
        setTable("")
        setFilterVerdict("")
        setFilterHuman("")
      }
    } catch (err) {
      // 记忆内容损坏时忽略，回到未选择状态即可
      console.error("[列表页] 恢复上次查看的表失败:", err)
    }
  }, [username, viewUser])

  /**
   * 记忆管理员当前查看的数据所属用户。
   * 作用：从评审页/统计页返回本页时，仍然停留在同一个用户的数据上。
   */
  useEffect(() => {
    if (!isAdmin) return
    try {
      const saved = localStorage.getItem(`skill-review:view-user:${username}`)
      if (saved && saved !== viewUser) {
        console.log("[列表页] 恢复上次查看的数据所属用户:", saved)
        setViewUser(saved)
      }
    } catch {
      // localStorage 不可用时忽略
    }
    // 只在挂载时读取一次，后续由写入 effect 负责保存
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, isAdmin])

  useEffect(() => {
    if (!isAdmin) return
    try {
      localStorage.setItem(`skill-review:view-user:${username}`, viewUser)
    } catch {
      // localStorage 写入失败不影响正常使用
    }
  }, [username, isAdmin, viewUser])

  /**
   * 记忆过滤条件。
   * 作用：把当前文件/表/过滤条件写入 localStorage，
   * 从评审页返回本页时按原过滤条件重新拉取列表。
   */
  useEffect(() => {
    if (!table) return
    try {
      localStorage.setItem(
        lastTableKey(username, viewUser),
        JSON.stringify({ file: selectedFile, table, verdict: filterVerdict, human: filterHuman }),
      )
    } catch {
      // localStorage 写入失败（如隐私模式）不影响正常使用
    }
  }, [username, viewUser, selectedFile, table, filterVerdict, filterHuman])

  /**
   * 查询列表数据。
   * 作用：按当前表名 + 两个过滤条件请求 /api/rows，
   * 同时更新表格数据和过滤下拉选项。
   */
  const loadRows = useCallback(async (tableName: string, fv: string, fh: string, owner: string) => {
    if (!tableName) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ table: tableName, page: "1", pageSize: "5000" })
      if (fv) params.set("judgeVerdict", fv)
      if (fh) params.set("humanJudge", fh)
      if (owner !== username) params.set("user", owner)
      const res = await fetch(`/api/rows?${params.toString()}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "查询数据失败")
      setRows(data.rows || [])
      setTotal(data.total || 0)
      setVerdictOptions(data.judgeVerdictOptions || [])
      setHumanOptions(data.humanJudgeOptions || [])
      console.log(`[列表页] 查询成功: ${data.rows.length} 行 / 共 ${data.total} 条`)
    } catch (err) {
      console.error("[列表页] 查询失败:", err)
      // 查询失败（一般是记住的表已不存在），清除记忆并回到未选择状态
      try {
        localStorage.removeItem(lastTableKey(username, owner))
      } catch {
        // localStorage 不可用时忽略
      }
      setSelectedFile("")
      setTable("")
      toast.error("查询数据失败", { description: String(err) })
    } finally {
      setLoading(false)
    }
  }, [username])

  // 表名、过滤条件或数据所属用户变化时，自动重新查询
  useEffect(() => {
    if (table) loadRows(table, filterVerdict, filterHuman, viewUser)
  }, [table, filterVerdict, filterHuman, viewUser, loadRows])

  /**
   * 选择 xlsx 文件后的处理。
   * 作用：调用 /api/import 执行「查表 → 缺则导入」，成功后切换当前表。
   */
  async function handleSelectFile(fileName: unknown) {
    const name = String(fileName || "")
    if (!name) return
    setSelectedFile(name)
    setImporting(true)
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 管理员查看其他用户时，把表导入到该用户自己的库里
        body: JSON.stringify({ fileName: name, user: viewUser }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "导入失败")
      // 记住当前选中的文件和数据表，下次返回本页自动恢复
      try {
        localStorage.setItem(
          lastTableKey(username, viewUser),
          JSON.stringify({ file: name, table: data.table }),
        )
      } catch {
        // localStorage 写入失败（如隐私模式）不影响正常导入
      }
      if (data.fromCache) {
        toast.success(`命中已有数据表「${data.table}」，直接加载`)
      } else {
        toast.success(`导入完成`, { description: `新建表「${data.table}」，共 ${data.rowCount} 行` })
      }
      // 切换表时清空过滤条件，避免旧条件在新表上无意义
      setFilterVerdict("")
      setFilterHuman("")
      setTable(data.table)
    } catch (err) {
      console.error("[列表页] 导入失败:", err)
      toast.error("导入失败", { description: String(err) })
    } finally {
      setImporting(false)
    }
  }

  /**
   * 导出 xlsx。
   * 作用：按当前过滤条件取全部字段数据，
   * 在浏览器里直接生成 .xlsx 文件并下载，表头使用统一中文显示名。
   */
  async function handleExport() {
    if (!table) return
    setExporting(true)
    try {
      const params = new URLSearchParams({ table })
      if (filterVerdict) params.set("judgeVerdict", filterVerdict)
      if (filterHuman) params.set("humanJudge", filterHuman)
      if (userParam) params.set("user", userParam)
      const res = await fetch(`/api/export?${params.toString()}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "导出失败")

      // 把英文字段转换成「统一中文显示名」表头
      const exportRows = (data.rows || []).map((row: Row) => {
        const item: Record<string, string> = {}
        for (const col of FIELD_COLUMNS) {
          item[col.label] = row[col.field] ?? ""
        }
        return item
      })
      const sheet = XLSX.utils.json_to_sheet(exportRows)
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, "数据")
      const fileName = `${table}_${exportTimestamp()}.xlsx`
      XLSX.writeFile(book, fileName)
      console.log(`[列表页] 导出成功: ${fileName}, ${exportRows.length} 行`)
      toast.success("导出成功", { description: fileName })
    } catch (err) {
      console.error("[列表页] 导出失败:", err)
      toast.error("导出失败", { description: String(err) })
    } finally {
      setExporting(false)
    }
  }

  /**
   * 退出登录。
   * 作用：调用 /api/auth/logout 清除服务端会话和 Cookie，回到登录页。
   */
  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" })
      console.log("[列表页] 已退出登录")
    } catch (err) {
      console.error("[列表页] 退出登录失败:", err)
    }
    router.push("/login")
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
      {/* 页面标题 */}
      <header className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">质量分析</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">
          Jira Skill 评审系统
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          在左侧选择 xlsx 文件自动导入，按条件过滤查看，点击「详情」进入评审页保存人工判定。
        </p>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* ========== 左侧侧边栏：文件选择 ========== */}
        <aside className="w-full shrink-0 lg:w-64">
          <div className="rounded-xl border border-border bg-card p-4">
            {/* 管理员专用：切换查看哪个用户的数据（xlsx 和数据库都跟着切换） */}
            {isAdmin && allUsers.length > 0 && (
              <div className="mb-4">
                <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Users className="size-4 text-muted-foreground" />
                  数据所属用户
                </p>
                <Select value={viewUser} onValueChange={(v) => setViewUser(String(v || username))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allUsers.map((u) => (
                      <SelectItem key={u} value={u}>
                        {u === username ? `${u}（我）` : u}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <p className="mb-3 flex items-center gap-2 text-sm font-medium">
              <FileSpreadsheet className="size-4 text-muted-foreground" />
              选择数据文件
            </p>
            {/* value 始终是字符串保持受控，空字符串时显示 placeholder */}
            <Select value={selectedFile} onValueChange={handleSelectFile}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="请选择 xlsx 文件" />
              </SelectTrigger>
              <SelectContent>
                {files.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* 导入状态与当前表信息 */}
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              {importing && (
                <p className="flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" /> 正在导入…
                </p>
              )}
              {table && !importing && <p>当前数据表：{table}</p>}
              {table && !importing && <p>共 {total} 条记录</p>}
              {files.length === 0 && !dirWarning && <p>目录下暂无 xlsx 文件</p>}
              {dirWarning && <p className="text-destructive">{dirWarning}</p>}
            </div>
          </div>

          {/* 同Skill结果对比全览（无需先选表） */}
          <Link
            href={`/type-stats${userParam ? `?user=${encodeURIComponent(userParam)}` : ""}`}
            className={buttonVariants({ variant: "outline", className: "mt-4 w-full" })}
          >
            <BarChart3 className="size-4" />
            同Skill结果对比全览
          </Link>

          {/* 跳转统计页（选中表后才可用） */}
          {table && (
            <Link
              href={`/stats?table=${encodeURIComponent(table)}${userParam ? `&user=${encodeURIComponent(userParam)}` : ""}`}
              className={buttonVariants({ variant: "outline", className: "mt-4 w-full" })}
            >
              <BarChart3 className="size-4" />
              评审统计
            </Link>
          )}

          {/* 当前登录用户信息 + 用户管理（管理员）+ 退出登录 */}
          <div className="mt-4 rounded-xl border border-border bg-card p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <UserRound className="size-4 text-muted-foreground" />
              {username}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isAdmin ? "管理员" : "普通用户"} · 只能看到自己文件夹的数据
            </p>
            {isAdmin && (
              <Link
                href="/users"
                className={buttonVariants({ variant: "outline", className: "mt-3 w-full" })}
              >
                <Users className="size-4" />
                用户管理
              </Link>
            )}
            <Button variant="ghost" className="mt-2 w-full" onClick={handleLogout}>
              <LogOut className="size-4" />
              退出登录
            </Button>
          </div>
        </aside>

        {/* ========== 右侧主区域：过滤 + 列表 ========== */}
        <main className="min-w-0 flex-1">
          {/* 第一部分：过滤条件 */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">大模型判定</span>
              <Select
                value={filterVerdict}
                onValueChange={(v) => setFilterVerdict(String(v ?? ""))}
              >
                <SelectTrigger className="w-40">
                  {/* 用渲染函数强制显示中文文案，避免选中「未判定」时显示内部值 __NULL__ */}
                  <SelectValue placeholder="全部">
                    {(v) => (v === "__NULL__" ? "未判定" : v ? String(v) : "全部")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">全部</SelectItem>
                  <SelectItem value="__NULL__">未判定</SelectItem>
                  {verdictOptions.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">人工判定</span>
              <Select
                value={filterHuman}
                onValueChange={(v) => setFilterHuman(String(v ?? ""))}
              >
                <SelectTrigger className="w-40">
                  {/* 用渲染函数强制显示中文文案，避免选中「未判定」时显示内部值 __NULL__ */}
                  <SelectValue placeholder="全部">
                    {(v) => (v === "__NULL__" ? "未判定" : v ? String(v) : "全部")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">全部</SelectItem>
                  <SelectItem value="__NULL__">未判定</SelectItem>
                  {humanOptions.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(filterVerdict || filterHuman) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilterVerdict("")
                  setFilterHuman("")
                }}
              >
                清空过滤
              </Button>
            )}
          </div>

          {/* 表格右上角工具条：总条数 + 导出按钮 */}
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              共 <span className="font-mono font-medium text-foreground">{total}</span> 条
            </p>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={!table || exporting}>
              {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              导出 xlsx
            </Button>
          </div>

          {/* 第二部分：列表（固定高度 + 滚动条） */}
          <div className="max-h-[600px] overflow-auto rounded-xl border border-border bg-card">
            <Table>
              <TableHeader className="sticky top-0 z-10">
                <TableRow className="bg-muted/90 hover:bg-muted/90 backdrop-blur">
                  <TableHead className="w-[64px]">序号</TableHead>
                  <TableHead className="w-[130px]">Jira ID</TableHead>
                  <TableHead className="min-w-[260px]">Summary</TableHead>
                  <TableHead className="w-[120px]">大模型判定</TableHead>
                  <TableHead className="w-[120px]">人工判定</TableHead>
                  <TableHead className="w-[90px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-16 text-center text-muted-foreground">
                      {table ? "没有符合条件的数据" : "请先在左侧选择一个 xlsx 文件"}
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row, index) => (
                  <TableRow key={row._rowid ?? index} className="align-top">
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {index + 1}
                    </TableCell>
                    <TableCell className="font-mono text-sm font-medium">
                      {row.jira_id || "-"}
                    </TableCell>
                    <TableCell className="max-w-[420px] text-sm">
                      <span className="line-clamp-1">{row.summary || "-"}</span>
                    </TableCell>
                    <TableCell>
                      <VerdictBadge value={row.judge_verdict} />
                    </TableCell>
                    <TableCell>
                      <VerdictBadge value={row.human_judge} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/review/${encodeURIComponent(String(row.jira_id || ""))}?table=${encodeURIComponent(table)}${
                          userParam ? `&user=${encodeURIComponent(userParam)}` : ""
                        }${
                          filterVerdict ? `&v=${encodeURIComponent(filterVerdict)}` : ""
                        }${filterHuman ? `&h=${encodeURIComponent(filterHuman)}` : ""}`}
                        className={buttonVariants({ size: "sm", variant: "outline" })}
                      >
                        详情
                        <ArrowRight className="size-3.5" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {loading && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 数据加载中…
            </p>
          )}
        </main>
      </div>
    </div>
  )
}
