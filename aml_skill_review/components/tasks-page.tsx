// ============================================================
// 任务管理页组件（/tasks 主体）
// 作用：管理 skill 分析任务的完整生命周期：
//  1. 顶部统计栏：运行中 / 最大并发、排队中、我的排队位置；
//  2. 管理员配置：修改最大并发任务数；
//  3. 新建任务表单：任务名、skill、JQL、最大条数、邮箱；
//  4. 任务列表：状态徽章、进度条、队列位置、操作按钮
//     （查看日志、下载日志、下载结果、停止任务）；
//  5. 日志查看弹窗：实时刷新运行中任务的日志输出。
// 自动刷新：存在 queued / running 任务时每 5 秒轮询列表与统计。
// ============================================================

"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Activity,
  Bookmark,
  Clock,
  Download,
  FileText,
  Loader2,
  LogOut,
  Play,
  Settings,
  Square,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { Textarea } from "@/components/ui/textarea"

// ---------- 类型定义 ----------

/** 任务状态 */
type TaskStatus = "queued" | "running" | "completed" | "failed" | "stopped"

/** 任务信息（与后端 TaskInfo 对应） */
type TaskInfo = {
  id: string
  name: string
  owner: string
  skill: string
  skillPath: string
  jql: string
  maxIssues: number
  email: string
  status: TaskStatus
  progress: number
  progressTotal: number
  progressMessage: string
  logPath: string
  outputPath: string
  pid: number | null
  queuePosition: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

/** Skill 信息（与后端 SkillInfo 对应，新建任务时用） */
type SkillItem = {
  skillPath: string
  skillName: string
  skillType: string
  owner: string
  description: string
}

/** 任务统计信息 */
type TaskStats = {
  running: number
  queued: number
  maxConcurrent: number
  myRunning: number
  myQueued: number
  myQueuePosition: number
}

/** 任务配置模板（preset），用于保存/加载表单配置 */
type TaskPreset = {
  id: string
  name: string
  owner: string
  skill: string
  skillPath: string
  jql: string
  maxIssues: number
  email: string
  mode: "immediate" | "once"
  runAt: string | null
  createdAt: string
}

/** 计划任务（指定时间执行一次），尚未执行的 once 任务定义 */
type ScheduledTask = {
  id: string
  name: string
  owner: string
  skill: string
  jql: string
  email: string
  maxIssues: number
  runAt: string
  createdAt: string
}

// ---------- 状态徽章配色 ----------

/** 状态 → 中文文案 + 背景色 */
const STATUS_META: Record<TaskStatus, { label: string; className: string }> = {
  queued: { label: "排队中", className: "bg-yellow-500 text-white" },
  running: { label: "运行中", className: "bg-blue-500 text-white" },
  completed: { label: "已完成", className: "bg-green-500 text-white" },
  failed: { label: "失败", className: "bg-red-500 text-white" },
  stopped: { label: "已停止", className: "bg-gray-500 text-white" },
}

// ============================================================
// 主组件
// ============================================================

export function TasksPage({ username, isAdmin }: { username: string; isAdmin: boolean }) {
  const router = useRouter()

  // ---------- 任务列表与统计 ----------
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [stats, setStats] = useState<TaskStats | null>(null)
  const [loadingTasks, setLoadingTasks] = useState(true)

  // ---------- 管理员配置 ----------
  const [adminMax, setAdminMax] = useState<number>(0)
  const [savingConfig, setSavingConfig] = useState(false)

  // ---------- 新建任务表单 ----------
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [formName, setFormName] = useState("")
  const [formSkillPath, setFormSkillPath] = useState("")
  const [formJql, setFormJql] = useState("")
  const [formMaxIssues, setFormMaxIssues] = useState("50")
  const [formEmail, setFormEmail] = useState("")
  // 触发方式：immediate=立即执行，once=指定时间执行一次
  const [formMode, setFormMode] = useState<"immediate" | "once">("immediate")
  const [formRunAt, setFormRunAt] = useState("") // datetime-local 控件值
  const [creating, setCreating] = useState(false)

  // ---------- 任务配置模板（preset） ----------
  const [presets, setPresets] = useState<TaskPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState("")
  const [savingPreset, setSavingPreset] = useState(false)

  // ---------- 计划任务（指定时间执行一次） ----------
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])
  const [loadingScheduled, setLoadingScheduled] = useState(true)
  const [deletingScheduledId, setDeletingScheduledId] = useState("")

  // ---------- 日志查看弹窗 ----------
  const [logTask, setLogTask] = useState<TaskInfo | null>(null)
  const [logContent, setLogContent] = useState("")
  const [logLoading, setLogLoading] = useState(false)

  // ---------- 停止任务确认 ----------
  const [stopTarget, setStopTarget] = useState<TaskInfo | null>(null)

  /**
   * 加载任务统计。
   * 作用：调用 /api/backend/tasks/stats 获取运行中、排队中、我的排队位置。
   */
  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/backend/tasks/stats")
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取统计失败")
      setStats(data)
    } catch (err) {
      console.error("[任务页] 获取统计失败:", err)
    }
  }, [router])

  /**
   * 加载任务列表。
   * 作用：调用 /api/backend/tasks 获取当前用户可见的全部任务。
   */
  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/backend/tasks")
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取任务列表失败")
      setTasks(data.tasks || [])
      console.log(`[任务页] 获取任务列表成功: ${data.tasks?.length || 0} 条`)
    } catch (err) {
      console.error("[任务页] 获取任务列表失败:", err)
      toast.error("获取任务列表失败", { description: String(err) })
    } finally {
      setLoadingTasks(false)
    }
  }, [router])

  /**
   * 加载 skill 列表。
   * 作用：调用 /api/backend/skills 获取当前用户可选的 skill，用于新建任务下拉。
   */
  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch("/api/backend/skills")
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取 skill 列表失败")
      setSkills(data.data || [])
      console.log(`[任务页] 获取 skill 列表成功: ${data.data?.length || 0} 个`)
    } catch (err) {
      console.error("[任务页] 获取 skill 列表失败:", err)
      toast.error("获取 skill 列表失败", { description: String(err) })
    }
  }, [router])

  /**
   * 加载任务配置模板（preset）。
   * 作用：调用 /api/backend/presets 获取当前用户保存过的配置。
   */
  const loadPresets = useCallback(async () => {
    try {
      const res = await fetch("/api/backend/presets")
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取配置列表失败")
      setPresets(data.data || [])
      console.log(`[任务页] 获取配置列表成功: ${data.data?.length || 0} 条`)
    } catch (err) {
      console.error("[任务页] 获取配置列表失败:", err)
      toast.error("获取配置列表失败", { description: String(err) })
    }
  }, [router])

  /**
   * 加载计划任务（指定时间执行一次的 once 任务）。
   * 作用：调用 /api/backend/scheduled-tasks 获取当前用户尚未执行的计划任务。
   */
  const loadScheduled = useCallback(async () => {
    try {
      const res = await fetch("/api/backend/scheduled-tasks")
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取计划任务失败")
      setScheduledTasks(data.data || [])
      console.log(`[任务页] 获取计划任务成功: ${data.data?.length || 0} 条`)
    } catch (err) {
      console.error("[任务页] 获取计划任务失败:", err)
      toast.error("获取计划任务失败", { description: String(err) })
    } finally {
      setLoadingScheduled(false)
    }
  }, [router])

  /**
   * 管理员加载最大并发配置。
   * 作用：调用 /api/backend/admin/task-config 获取当前最大并发任务数。
   */
  const loadAdminConfig = useCallback(async () => {
    if (!isAdmin) return
    try {
      const res = await fetch("/api/backend/admin/task-config")
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取配置失败")
      setAdminMax(data.max)
    } catch (err) {
      console.error("[任务页] 获取管理员配置失败:", err)
    }
  }, [isAdmin])

  // ---------- 页面挂载时初始化加载 ----------
  useEffect(() => {
    loadTasks()
    loadStats()
    loadSkills()
    loadAdminConfig()
    loadPresets()
    loadScheduled()
  }, [loadTasks, loadStats, loadSkills, loadAdminConfig, loadPresets, loadScheduled])

  // ---------- 自动刷新：存在 queued / running 任务时每 5 秒轮询 ----------
  const hasActive = tasks.some((t) => t.status === "queued" || t.status === "running")
  useEffect(() => {
    if (!hasActive) return
    const timer = setInterval(() => {
      loadTasks()
      loadStats()
    }, 5000)
    return () => clearInterval(timer)
  }, [hasActive, loadTasks, loadStats])

  // ---------- 日志弹窗：运行中任务每 3 秒自动刷新 ----------
  const logIsRunning = logTask?.status === "running"
  const loadLog = useCallback(async (taskId: string) => {
    setLogLoading(true)
    try {
      const res = await fetch(`/api/backend/tasks/${encodeURIComponent(taskId)}/log`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取日志失败")
      setLogContent(data.log || "")
    } catch (err) {
      console.error("[任务页] 获取日志失败:", err)
      toast.error("获取日志失败", { description: String(err) })
    } finally {
      setLogLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!logTask) {
      setLogContent("")
      return
    }
    loadLog(logTask.id)
    if (!logIsRunning) return
    const timer = setInterval(() => loadLog(logTask.id), 3000)
    return () => clearInterval(timer)
  }, [logTask, logIsRunning, loadLog])

  // ---------- 操作处理 ----------

  /**
   * 创建新任务。
   * 作用：校验表单后调用 /api/backend/tasks（POST），成功后刷新列表与统计。
   */
  async function handleCreate() {
    const name = formName.trim()
    const jql = formJql.trim()
    const maxIssues = parseInt(formMaxIssues, 10)
    const email = formEmail.trim()
    if (!name) {
      toast.error("请输入任务名称")
      return
    }
    if (!formSkillPath) {
      toast.error("请选择 skill")
      return
    }
    if (!jql) {
      toast.error("请输入 JQL 查询语句")
      return
    }
    // 定时参数校验
    // datetime-local 的值形如 "2026-10-08T18:30"，后端要求 "YYYY-MM-DD HH:MM"
    let runAt: string | null = null
    if (formMode === "once") {
      if (!formRunAt) {
        toast.error("请选择执行时间")
        return
      }
      runAt = formRunAt.replace("T", " ")
    }
    // 从选中的 skillPath 找到对应的 skillName
    const selected = skills.find((s) => s.skillPath === formSkillPath)
    if (!selected) {
      toast.error("所选 skill 无效")
      return
    }
    setCreating(true)
    try {
      const res = await fetch("/api/backend/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          skill: selected.skillName,
          skillPath: selected.skillPath,
          jql,
          maxIssues: Number.isFinite(maxIssues) ? maxIssues : 0,
          email,
          mode: formMode,
          runAt,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "创建任务失败")
      if (formMode === "immediate") {
        toast.success("任务已创建", {
          description: `${name} → ${data.task.status === "running" ? "已开始运行" : "已加入队列"}`,
        })
      } else {
        toast.success("定时任务已创建", { description: `${name} → ${runAt} 执行` })
      }
      // 清空表单并刷新
      setFormName("")
      setFormSkillPath("")
      setFormJql("")
      setFormMaxIssues("50")
      setFormEmail("")
      setFormMode("immediate")
      setFormRunAt("")
      await Promise.all([loadTasks(), loadStats(), loadScheduled()])
    } catch (err) {
      console.error("[任务页] 创建任务失败:", err)
      toast.error("创建任务失败", { description: String(err) })
    } finally {
      setCreating(false)
    }
  }

  /**
   * 保存当前表单为配置模板（preset）。
   * 作用：校验后调用 /api/backend/presets（POST）保存，成功后刷新配置列表。
   */
  async function handleSavePreset() {
    const name = formName.trim()
    const jql = formJql.trim()
    if (!name) {
      toast.error("请先填写任务名称（将作为配置名）")
      return
    }
    if (!formSkillPath) {
      toast.error("请选择 skill")
      return
    }
    if (!jql) {
      toast.error("请输入 JQL 查询语句")
      return
    }
    let runAt: string | null = null
    if (formMode === "once") {
      if (!formRunAt) {
        toast.error("请选择执行时间")
        return
      }
      runAt = formRunAt.replace("T", " ")
    }
    const selected = skills.find((s) => s.skillPath === formSkillPath)
    if (!selected) {
      toast.error("所选 skill 无效")
      return
    }
    const maxIssues = parseInt(formMaxIssues, 10)
    setSavingPreset(true)
    try {
      const res = await fetch("/api/backend/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          skill: selected.skillName,
          skillPath: selected.skillPath,
          jql,
          maxIssues: Number.isFinite(maxIssues) ? maxIssues : 0,
          email: formEmail.trim(),
          mode: formMode,
          runAt,
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "保存配置失败")
      toast.success("配置已保存", { description: data.data?.name })
      await loadPresets()
      setSelectedPresetId(data.data?.id || "")
    } catch (err) {
      console.error("[任务页] 保存配置失败:", err)
      toast.error("保存配置失败", { description: String(err) })
    } finally {
      setSavingPreset(false)
    }
  }

  /**
   * 加载选中的配置到表单。
   * 作用：根据 selectedPresetId 回填全部表单字段。
   */
  function handleLoadPreset() {
    if (!selectedPresetId) {
      toast.error("请先选择要加载的配置")
      return
    }
    const p = presets.find((x) => x.id === selectedPresetId)
    if (!p) {
      toast.error("配置不存在")
      return
    }
    setFormName(p.name || "")
    setFormJql(p.jql || "")
    setFormMaxIssues(String(p.maxIssues ?? 50))
    setFormEmail(p.email || "")
    setFormMode(p.mode || "immediate")
    setFormRunAt(p.mode === "once" && p.runAt ? p.runAt.replace(" ", "T") : "")
    // 恢复 skill：仅当该 skill 当前仍存在时才回填
    if (p.skillPath && skills.some((s) => s.skillPath === p.skillPath)) {
      setFormSkillPath(p.skillPath)
    } else {
      setFormSkillPath("")
      toast.warning("该配置中的 skill 已不存在，请重新选择", { description: p.skillPath || p.skill })
    }
    toast.success("已加载配置", { description: p.name })
  }

  /**
   * 删除选中的配置模板。
   * 作用：调用 /api/backend/presets/[id]（DELETE）后刷新配置列表。
   */
  async function handleDeletePreset() {
    if (!selectedPresetId) {
      toast.error("请先选择要删除的配置")
      return
    }
    try {
      const res = await fetch(`/api/backend/presets/${encodeURIComponent(selectedPresetId)}`, {
        method: "DELETE",
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "删除配置失败")
      toast.success("配置已删除")
      setSelectedPresetId("")
      await loadPresets()
    } catch (err) {
      console.error("[任务页] 删除配置失败:", err)
      toast.error("删除配置失败", { description: String(err) })
    }
  }

  /**
   * 删除计划任务（指定时间执行一次、尚未执行的 once 任务）。
   * 作用：调用 /api/backend/scheduled-tasks/[id]（DELETE）移除计划任务。
   */
  async function handleDeleteScheduled(task: ScheduledTask) {
    setDeletingScheduledId(task.id)
    try {
      const res = await fetch(`/api/backend/scheduled-tasks/${encodeURIComponent(task.id)}`, {
        method: "DELETE",
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "删除计划任务失败")
      toast.success("计划任务已删除", { description: task.name })
      await loadScheduled()
    } catch (err) {
      console.error("[任务页] 删除计划任务失败:", err)
      toast.error("删除计划任务失败", { description: String(err) })
    } finally {
      setDeletingScheduledId("")
    }
  }

  /**
   * 保存管理员最大并发配置。
   * 作用：调用 /api/backend/admin/task-config（PUT）修改最大并发任务数。
   */
  async function handleSaveConfig() {
    if (!Number.isInteger(adminMax) || adminMax < 1) {
      toast.error("最大并发数必须是大于 0 的整数")
      return
    }
    setSavingConfig(true)
    try {
      const res = await fetch("/api/backend/admin/task-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max: adminMax }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "保存配置失败")
      toast.success("配置已保存", { description: `最大并发任务数 = ${data.max}` })
      await loadStats()
    } catch (err) {
      console.error("[任务页] 保存配置失败:", err)
      toast.error("保存配置失败", { description: String(err) })
    } finally {
      setSavingConfig(false)
    }
  }

  /**
   * 停止任务。
   * 作用：调用 /api/backend/tasks/[taskId]（DELETE）停止运行中或排队中的任务。
   */
  async function handleStop(task: TaskInfo) {
    try {
      const res = await fetch(`/api/backend/tasks/${encodeURIComponent(task.id)}`, {
        method: "DELETE",
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "停止任务失败")
      toast.success("任务已停止", { description: task.name })
      await Promise.all([loadTasks(), loadStats()])
    } catch (err) {
      console.error("[任务页] 停止任务失败:", err)
      toast.error("停止任务失败", { description: String(err) })
    } finally {
      setStopTarget(null)
    }
  }

  /**
   * 退出登录。
   * 作用：调用 /api/auth/logout 清除会话，回到登录页。
   */
  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" })
      console.log("[任务页] 已退出登录")
    } catch (err) {
      console.error("[任务页] 退出登录失败:", err)
    }
    router.push("/login")
  }

  // ---------- 渲染辅助 ----------

  /** 渲染状态徽章 */
  function renderStatus(status: TaskStatus) {
    const meta = STATUS_META[status] || { label: status, className: "bg-gray-500 text-white" }
    return <Badge className={meta.className}>{meta.label}</Badge>
  }

  /** 渲染进度条 */
  function renderProgress(task: TaskInfo) {
    const pct = Math.max(0, Math.min(100, task.progress))
    return (
      <div className="flex items-center gap-2">
        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono text-xs text-muted-foreground">{pct}%</span>
      </div>
    )
  }

  /** 是否可停止（排队中或运行中） */
  const canStop = (t: TaskInfo) => t.status === "queued" || t.status === "running"

  // ============================================================
  // 页面渲染
  // ============================================================
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
      {/* 顶部导航 */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <nav className="flex items-center gap-1">
          <Link href="/" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            首页
          </Link>
          <Link href="/skills" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Skill 管理
          </Link>
          <Link href="/tasks" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            任务管理
          </Link>
        </nav>
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="size-4" />
          退出登录
        </Button>
      </div>

      {/* 页面标题 */}
      <header className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">质量分析</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">Skill 分析任务</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          创建 skill 分析任务，选择 JQL 查询范围，系统将自动排队执行并生成 xlsx 结果。
          {isAdmin ? "管理员可查看全部用户的任务并调整并发上限。" : "你只能看到自己的任务。"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          当前登录：<span className="font-mono font-medium text-foreground">{username}</span>
          （{isAdmin ? "管理员" : "普通用户"}）
        </p>
      </header>

      {/* ========== 使用说明 ========== */}
      <div className="mb-6 rounded-xl border border-border bg-muted/40 p-4">
        <p className="text-sm font-medium">使用说明</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li><span className="font-medium text-foreground">顶部统计栏：</span>查看运行中/最大并发、排队总数、你的排队位置。</li>
          <li><span className="font-medium text-foreground">管理员配置（仅管理员可见）：</span>修改最大并发任务数（1~16），保存后立即尝试调度排队任务。</li>
          <li>
            <span className="font-medium text-foreground">新建任务：</span>填写任务名称、选择 Skill（名称取自各 skill.md 的 name 字段）、
            输入 JQL、最大处理条数与通知邮箱；触发方式支持「立即执行」和「指定时间」。
          </li>
          <li><span className="font-medium text-foreground">配置模板：</span>「保存当前配置」把当前表单存为模板，「加载」回填到表单，「删除」移除模板。</li>
          <li><span className="font-medium text-foreground">计划任务（指定时间）：</span>展示尚未执行的定时任务明细（任务名称、Skill、执行时间、创建时间），可点击「删除」取消该计划。</li>
          <li><span className="font-medium text-foreground">任务列表：</span>查看状态/进度/队列位置，可用「日志」查看、「下载日志/结果」下载、「停止」终止排队或运行中的任务。</li>
        </ul>
      </div>

      {/* ========== 顶部统计栏 ========== */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity className="size-4" />
            运行中 / 最大并发
          </div>
          <p className="mt-1 text-2xl font-semibold">
            <span className="text-blue-500">{stats?.running ?? "-"}</span>
            <span className="text-muted-foreground"> / {stats?.maxConcurrent ?? "-"}</span>
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4" />
            排队中
          </div>
          <p className="mt-1 text-2xl font-semibold text-yellow-500">{stats?.queued ?? "-"}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4" />
            我的排队位置
          </div>
          <p className="mt-1 text-2xl font-semibold">
            {stats?.myQueuePosition ? `#${stats.myQueuePosition}` : "-"}
          </p>
        </div>
      </div>

      {/* ========== 管理员配置 ========== */}
      {isAdmin && (
        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Settings className="size-4 text-muted-foreground" />
            管理员配置
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-full space-y-1.5 sm:w-48">
              <Label htmlFor="admin-max">最大并发任务数</Label>
              <Input
                id="admin-max"
                type="number"
                min={1}
                max={16}
                value={adminMax || ""}
                onChange={(e) => setAdminMax(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <Button onClick={handleSaveConfig} disabled={savingConfig} className="mb-0.5">
              {savingConfig ? <Loader2 className="size-4 animate-spin" /> : <Settings className="size-4" />}
              保存配置
            </Button>
            <p className="mb-1 text-xs text-muted-foreground">
              范围 1~16。调大后系统会立即尝试调度排队中的任务。
            </p>
          </div>
        </div>
      )}

      {/* ========== 新建任务表单 ========== */}
      <div className="mb-6 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Play className="size-4 text-muted-foreground" />
          新建任务
        </div>
        {/* 配置模板：保存当前配置 / 选择已保存配置加载或删除 */}
        <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-border p-3">
          <div className="min-w-[200px] flex-1 space-y-1.5">
            <Label>已保存配置</Label>
            <Select
              value={selectedPresetId}
              onValueChange={(v) => setSelectedPresetId(String(v || ""))}
              items={presets.map((p) => ({ value: p.id, label: p.name }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择配置加载到表单" />
              </SelectTrigger>
              <SelectContent>
                {presets.length === 0 && (
                  <SelectItem value="__none__" disabled>
                    暂无已保存配置
                  </SelectItem>
                )}
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={handleLoadPreset} disabled={!selectedPresetId}>
            加载
          </Button>
          <Button variant="outline" onClick={handleDeletePreset} disabled={!selectedPresetId}>
            <Trash2 className="size-4" />
            删除
          </Button>
          <Button onClick={handleSavePreset} disabled={savingPreset}>
            {savingPreset ? <Loader2 className="size-4 animate-spin" /> : <Bookmark className="size-4" />}
            保存当前配置
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 任务名称 */}
          <div className="space-y-1.5">
            <Label htmlFor="form-name">任务名称</Label>
            <Input
              id="form-name"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="例如：wifi 日志分析 - 10月"
            />
          </div>
          {/* Skill 选择 */}
          <div className="space-y-1.5">
            <Label>Skill</Label>
            <Select value={formSkillPath} onValueChange={(v) => setFormSkillPath(String(v || ""))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="请选择 skill" />
              </SelectTrigger>
              <SelectContent>
                {skills.length === 0 && (
                  <SelectItem value="__none__" disabled>
                    暂无可选 skill
                  </SelectItem>
                )}
                {skills.map((s) => (
                  <SelectItem key={s.skillPath} value={s.skillPath}>
                    {s.skillName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* JQL 查询 */}
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="form-jql">JQL 查询语句</Label>
            <Textarea
              id="form-jql"
              value={formJql}
              onChange={(e) => setFormJql(e.target.value)}
              placeholder='例如：project = OTT AND issuetype = Bug AND created >= "-7d"'
              className="min-h-20 font-mono text-xs"
            />
          </div>
          {/* 最大条数 */}
          <div className="space-y-1.5">
            <Label htmlFor="form-max">最大处理条数</Label>
            <Input
              id="form-max"
              type="number"
              min={1}
              value={formMaxIssues}
              onChange={(e) => setFormMaxIssues(e.target.value)}
            />
          </div>
          {/* 邮箱（可选） */}
          <div className="space-y-1.5">
            <Label htmlFor="form-email">结果通知邮箱（可选）</Label>
            <Input
              id="form-email"
              type="email"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
              placeholder="someone@example.com"
            />
          </div>

          {/* 触发方式：立即 / 指定时间 */}
          <div className="mt-4">
            <Label>触发方式</Label>
            <div className="mt-1.5 flex gap-2">
              {([
                { v: "immediate", label: "立即执行" },
                { v: "once", label: "指定时间" },
              ] as const).map((opt) => (
                <Button
                  key={opt.v}
                  type="button"
                  variant={formMode === opt.v ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setFormMode(opt.v)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          {/* 指定时间执行一次 */}
          {formMode === "once" && (
            <div className="mt-4">
              <Label htmlFor="task-run-at">执行时间（本机时间）</Label>
              <Input
                id="task-run-at"
                type="datetime-local"
                className="mt-1.5"
                value={formRunAt}
                onChange={(e) => setFormRunAt(e.target.value)}
              />
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {formMode === "immediate" ? "创建并执行" : "创建计划"}
          </Button>
        </div>
      </div>

      {/* ========== 计划任务（指定时间） ========== */}
      <div className="mb-6 rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">计划任务（指定时间）</p>
          </div>
          <p className="text-xs text-muted-foreground">
            共 <span className="font-mono font-medium text-foreground">{scheduledTasks.length}</span> 条
          </p>
        </div>
        {scheduledTasks.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {loadingScheduled ? "加载中…" : "暂无待执行的计划任务"}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/90 hover:bg-muted/90">
                <TableHead className="min-w-[140px]">任务名称</TableHead>
                <TableHead className="w-[120px]">Skill</TableHead>
                <TableHead className="w-[180px]">执行时间</TableHead>
                <TableHead className="w-[160px]">创建时间</TableHead>
                <TableHead className="w-[100px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scheduledTasks.map((st) => (
                <TableRow key={st.id} className="align-middle">
                  <TableCell>
                    <p className="line-clamp-1 text-sm font-medium">{st.name || "-"}</p>
                    {isAdmin && st.owner && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">创建者：{st.owner}</p>
                    )}
                    {st.email && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{st.email}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{st.skill || "-"}</TableCell>
                  <TableCell className="font-mono text-xs text-foreground">{st.runAt || "-"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{st.createdAt || "-"}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleDeleteScheduled(st)}
                      disabled={deletingScheduledId === st.id}
                    >
                      {deletingScheduledId === st.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ========== 任务列表 ========== */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-medium">任务列表</p>
          <p className="text-xs text-muted-foreground">
            共 <span className="font-mono font-medium text-foreground">{tasks.length}</span> 条
            {hasActive && (
              <span className="ml-2 flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" /> 自动刷新中
              </span>
            )}
          </p>
        </div>
        <Table>
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="bg-muted/90 hover:bg-muted/90 backdrop-blur">
              <TableHead className="min-w-[140px]">任务名称</TableHead>
              <TableHead className="w-[120px]">Skill</TableHead>
              <TableHead className="w-[90px]">状态</TableHead>
              <TableHead className="w-[160px]">进度</TableHead>
              <TableHead className="w-[80px]">队列位置</TableHead>
              <TableHead className="w-[160px]">创建时间</TableHead>
              <TableHead className="w-[260px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 && !loadingTasks && (
              <TableRow>
                <TableCell colSpan={7} className="py-16 text-center text-muted-foreground">
                  暂无任务，请在上方创建新任务
                </TableCell>
              </TableRow>
            )}
            {loadingTasks && tasks.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-16 text-center text-muted-foreground">
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="size-4 animate-spin" /> 加载中…
                  </span>
                </TableCell>
              </TableRow>
            )}
            {tasks.map((task) => (
              <TableRow key={task.id} className="align-middle">
                <TableCell>
                  <p className="line-clamp-1 text-sm font-medium">{task.name || "-"}</p>
                  {task.progressMessage && (
                    <p className="line-clamp-1 text-xs text-muted-foreground">{task.progressMessage}</p>
                  )}
                </TableCell>
                <TableCell className="text-sm">{task.skill || "-"}</TableCell>
                <TableCell>{renderStatus(task.status)}</TableCell>
                <TableCell>{renderProgress(task)}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {task.status === "queued" ? `#${task.queuePosition}` : "-"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{task.createdAt}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {/* 查看日志 */}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setLogTask(task)}
                    >
                      <FileText className="size-3.5" />
                      日志
                    </Button>
                    {/* 下载日志 */}
                    <a
                      href={`/api/backend/tasks/${encodeURIComponent(task.id)}/download-log`}
                      download
                      className={buttonVariants({ size: "sm", variant: "outline" })}
                    >
                      <Download className="size-3.5" />
                      日志
                    </a>
                    {/* 下载结果（仅完成且有结果时可用） */}
                    <a
                      href={`/api/backend/tasks/${encodeURIComponent(task.id)}/download-output`}
                      download
                      className={buttonVariants({
                        size: "sm",
                        variant: "outline",
                        className: task.status !== "completed" ? "pointer-events-none opacity-50" : "",
                      })}
                    >
                      <Download className="size-3.5" />
                      结果
                    </a>
                    {/* 停止任务（排队中 / 运行中） */}
                    {canStop(task) && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setStopTarget(task)}
                      >
                        <Square className="size-3.5" />
                        停止
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ========== 日志查看弹窗 ========== */}
      {logTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setLogTask(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 弹窗标题 */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">任务日志：{logTask.name}</span>
                {logIsRunning && (
                  <span className="flex items-center gap-1 text-xs text-blue-500">
                    <Loader2 className="size-3 animate-spin" /> 实时刷新中
                  </span>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setLogTask(null)}>
                关闭
              </Button>
            </div>
            {/* 日志内容 */}
            <div className="flex-1 overflow-auto p-4">
              {logLoading && !logContent ? (
                <p className="flex items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> 加载日志中…
                </p>
              ) : logContent ? (
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
                  {logContent}
                </pre>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">暂无日志内容</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== 停止任务确认弹窗 ========== */}
      {stopTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setStopTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Square className="size-5 text-destructive" />
              <h2 className="text-base font-semibold">确认停止任务</h2>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              确定要停止任务「<span className="font-medium text-foreground">{stopTarget.name}</span>」吗？
              停止后无法恢复，已生成的部分结果将保留。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStopTarget(null)}>
                取消
              </Button>
              <Button variant="destructive" onClick={() => handleStop(stopTarget)}>
                <Square className="size-4" />
                确认停止
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
