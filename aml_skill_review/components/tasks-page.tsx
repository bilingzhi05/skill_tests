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
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Activity,
  Bookmark,
  Check,
  Clock,
  Download,
  FileText,
  Loader2,
  Play,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  X,
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
import { AppNavbar } from "@/components/app-navbar"

// ---------- 类型定义 ----------

/** 任务状态 */
type TaskStatus = "pending" | "queued" | "running" | "completed" | "failed" | "stopped" | "rejected"

/** 任务信息（与后端 TaskInfo 对应） */
type TaskInfo = {
  id: string
  name: string
  owner: string
  skill: string
  skillOwner: string
  skillPath: string
  jql: string
  maxIssues: number
  email: string
  mode: string
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
  review: string
}

/** 管理员待审核的立即执行任务（status="pending" 的 run） */
type ApprovalRun = {
  id: string
  name: string
  owner: string
  skill: string
  skillOwner: string
  jql: string
  email: string
  maxIssues: number
  createdAt: string
}

/** 管理员待审核的指定时间任务（review=="pending" 的 once 定义） */
type ApprovalDef = {
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

/** 配置预览弹窗展示的字段项 */
type PreviewField = { label: string; value: string }

// ---------- 状态徽章配色 ----------

/** 状态 → 中文文案 + 背景色 */
const STATUS_META: Record<TaskStatus, { label: string; className: string }> = {
  pending: { label: "待审核", className: "bg-amber-500 text-white" },
  queued: { label: "排队中", className: "bg-yellow-500 text-white" },
  running: { label: "运行中", className: "bg-blue-500 text-white" },
  completed: { label: "已完成", className: "bg-green-500 text-white" },
  failed: { label: "失败", className: "bg-red-500 text-white" },
  stopped: { label: "已停止", className: "bg-gray-500 text-white" },
  rejected: { label: "已拒绝", className: "bg-rose-600 text-white" },
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
  // ---------- 任务列表：分页 + 过滤 ----------
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [filterSkill, setFilterSkill] = useState("all")
  const [filterOwner, setFilterOwner] = useState("all")
  const [filterFrom, setFilterFrom] = useState("")
  const [filterTo, setFilterTo] = useState("")
  const [skillOptions, setSkillOptions] = useState<string[]>([])
  const [ownerOptions, setOwnerOptions] = useState<string[]>([])

  // ---------- 管理员配置 ----------
  const [adminMax, setAdminMax] = useState<number>(0)
  const [savingConfig, setSavingConfig] = useState(false)

  // ---------- 新建任务表单 ----------
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [formName, setFormName] = useState("")
  const [formSkillPath, setFormSkillPath] = useState("")
  const [formJql, setFormJql] = useState("")
  const [formMaxIssues, setFormMaxIssues] = useState("0")
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

  // ---------- 管理员：待审核任务 ----------
  const [pendingRuns, setPendingRuns] = useState<ApprovalRun[]>([])
  const [pendingDefs, setPendingDefs] = useState<ApprovalDef[]>([])
  const [loadingApprovals, setLoadingApprovals] = useState(true)
  // 当前正在审核的标识（kind:run|def + id）
  const [reviewingKey, setReviewingKey] = useState("")

  // ---------- 配置预览 / 审核弹窗 ----------
  const [previewItem, setPreviewItem] = useState<{ title: string; status: string; fields: PreviewField[] } | null>(null)
  // 管理员审核弹窗：kind + 通过/拒绝意图 + 对应条目
  const [reviewTarget, setReviewTarget] = useState<{
    kind: "run" | "def"
    accept: boolean
    item: ApprovalRun | ApprovalDef
  } | null>(null)
  const [reviewRemark, setReviewRemark] = useState("")
  const [reviewSubmitting, setReviewSubmitting] = useState(false)

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
   * 加载任务列表（分页 + 过滤）。
   * 作用：调用 /api/backend/tasks 获取当前可见的一页任务，并同步总数与筛选下拉选项。
   */
  const loadTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set("page", String(page))
      params.set("page_size", String(pageSize))
      if (filterSkill && filterSkill !== "all") params.set("skill", filterSkill)
      if (filterOwner && filterOwner !== "all") params.set("owner", filterOwner)
      if (filterFrom) params.set("date_from", filterFrom)
      if (filterTo) params.set("date_to", filterTo)
      const res = await fetch(`/api/backend/tasks?${params.toString()}`)
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取任务列表失败")
      setTasks(data.tasks || [])
      setTotal(data.total ?? data.tasks?.length ?? 0)
      setSkillOptions(data.skill_options || [])
      setOwnerOptions(data.owner_options || [])
      console.log(`[任务页] 获取任务列表成功: ${data.tasks?.length || 0} 条 / 共 ${data.total || 0} 条`)
    } catch (err) {
      console.error("[任务页] 获取任务列表失败:", err)
      toast.error("获取任务列表失败", { description: String(err) })
    } finally {
      setLoadingTasks(false)
    }
  }, [page, pageSize, filterSkill, filterOwner, filterFrom, filterTo, router])

  /**
   * 加载 skill 列表。
   * 作用：调用 /api/backend/skills?mine=1 获取当前用户可选的 skill（普通用户只能选自己负责的），用于新建任务下拉。
   */
  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch("/api/backend/skills?mine=1")
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
   * 管理员加载待审核任务。
   * 作用：调用 /api/backend/approvals 获取普通用户提交、等待审批的立即执行任务与指定时间任务。
   */
  const loadApprovals = useCallback(async () => {
    if (!isAdmin) return
    try {
      const res = await fetch("/api/backend/approvals")
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取待审核任务失败")
      setPendingRuns(data.runs || [])
      setPendingDefs(data.defs || [])
    } catch (err) {
      console.error("[任务页] 获取待审核任务失败:", err)
    } finally {
      setLoadingApprovals(false)
    }
  }, [isAdmin])

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
    loadApprovals()
  }, [loadTasks, loadStats, loadSkills, loadAdminConfig, loadPresets, loadScheduled, loadApprovals])

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
        if (isAdmin) {
          toast.success("任务已创建", {
            description: `${name} → ${data.task.status === "running" ? "已开始运行" : "已加入队列"}`,
          })
        } else {
          toast.success("任务已提交审核", {
            description: `${name} → 已提交，等待管理员审批后执行`,
          })
        }
      } else {
        if (isAdmin) {
          toast.success("定时任务已创建", { description: `${name} → ${runAt} 执行` })
        } else {
          toast.success("已提交审核", {
            description: `${name} → ${runAt} 执行，等待管理员批准`,
          })
        }
      }
      // 清空表单并刷新
      setFormName("")
      setFormSkillPath("")
      setFormJql("")
      setFormMaxIssues("0")
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
    setFormMaxIssues(String(p.maxIssues ?? 0))
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
   * 回撤计划任务（指定时间执行一次、尚未执行的 once 任务定义）。
   * 与通知中心回撤逻辑一致：确认后调用 /api/backend/scheduled-tasks/[id]（DELETE）移除定义，
   * 待审核的将不再等待管理员审核，其余直接取消。
   */
  async function handleWithdrawScheduled(task: ScheduledTask) {
    if (!window.confirm(`确定回撤计划任务「${task.name}」吗？回撤后将不再等待审核。`)) return
    setDeletingScheduledId(task.id)
    try {
      const res = await fetch(`/api/backend/scheduled-tasks/${encodeURIComponent(task.id)}`, {
        method: "DELETE",
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "回撤计划任务失败")
      toast.success("已回撤计划任务", { description: `「${task.name}」已撤销，不再等待审核` })
      await loadScheduled()
    } catch (err) {
      console.error("[任务页] 回撤计划任务失败:", err)
      toast.error("回撤计划任务失败", { description: String(err) })
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
   * 把任务条目组装为「完整配置」字段列表，供预览弹窗 / 审核弹窗展示。
   */
  function taskConfigFields(item: {
    name?: string
    owner?: string
    skill?: string
    skillOwner?: string
    skillPath?: string
    jql?: string
    maxIssues?: number | null
    email?: string
    runAt?: string
    createdAt?: string
    mode?: string
    review?: string
  }): PreviewField[] {
    const maxIssues = item.maxIssues ?? 0
    return [
      { label: "任务名称", value: item.name || "-" },
      { label: "提交人", value: item.owner || "-" },
      { label: "Skill", value: item.skill || "-" },
      { label: "Skill Owner", value: item.skillOwner || "-" },
      { label: "Skill 路径", value: item.skillPath || "-" },
      { label: "JQL 查询语句", value: item.jql || "-" },
      { label: "最大处理条数", value: String(maxIssues) + (maxIssues === 0 ? "（全量）" : "") },
      { label: "通知邮箱", value: item.email || "-" },
      {
        label: "触发方式",
        value:
          item.mode === "once"
            ? `指定时间（${item.runAt || "-"}）`
            : item.mode === "cron"
            ? "周期执行"
            : item.mode === "immediate"
            ? "立即执行"
            : item.runAt
            ? `指定时间（${item.runAt}）`
            : "立即执行",
      },
      { label: "创建时间", value: item.createdAt || "-" },
    ]
  }

  /**
   * 打开管理员审核弹窗（配置预览 + 备注输入 + 通过/拒绝确认）。
   */
  function openReviewModal(kind: "run" | "def", item: ApprovalRun | ApprovalDef, accept: boolean) {
    setReviewRemark("")
    setReviewTarget({ kind, accept, item })
  }

  /**
   * 管理员提交审核（通过 / 拒绝），可附备注，备注随结果通知发给申请人。
   * 作用：调用 /api/backend/approvals 对应端点（body 携带 remark），成功后刷新待审核列表、任务列表与计划任务。
   */
  async function submitReview() {
    if (!reviewTarget) return
    const { kind, accept: isAccept, item } = reviewTarget
    const key = `${kind}:${item.id}`
    setReviewingKey(key)
    setReviewSubmitting(true)
    try {
      const res = await fetch(
        `/api/backend/approvals/${kind}/${encodeURIComponent(item.id)}/${isAccept ? "accept" : "reject"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ remark: reviewRemark.trim() }),
        }
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "审核失败")
      toast.success(isAccept ? "已通过审核" : "已拒绝执行", {
        description: reviewRemark.trim() ? `已通知申请人并附带备注` : undefined,
      })
      setReviewTarget(null)
      setReviewRemark("")
      await Promise.all([loadApprovals(), loadTasks(), loadStats(), loadScheduled()])
    } catch (err) {
      console.error("[任务页] 审核任务失败:", err)
      toast.error("审核失败", { description: String(err) })
    } finally {
      setReviewSubmitting(false)
      setReviewingKey("")
    }
  }

  /**
   * 退出登录已统一放在顶部导航栏（AppNavbar）中。
   */

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
    <div>
      <AppNavbar username={username} isAdmin={isAdmin} />
      <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
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
          <li><span className="font-medium text-foreground">顶部统计栏：</span>查看运行中/最大并发、排队总数、你的排队位置。其他部分的使用说明见对应功能块。</li>
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
        <p className="mt-1 text-xs text-muted-foreground">
          填写任务名称、选择 Skill（名称取自各 skill.md 的 name 字段）、输入 JQL、最大处理条数与通知邮箱；触发方式支持「立即执行」和「指定时间」。
          {!isAdmin && " 普通用户提交的任务需管理员审核通过后才会执行。"}
        </p>
        {/* 配置模板：保存当前配置 / 选择已保存配置加载或删除 */}
        <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-border p-3">
          <p className="w-full text-xs text-muted-foreground">
            配置模板：「保存当前配置」把当前表单存为模板，「加载」回填到表单，「删除」移除模板。
          </p>
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
              min={0}
              value={formMaxIssues}
              onChange={(e) => setFormMaxIssues(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              0 表示全量分析，填 3 表示只分析 3 条
            </p>
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
            {isAdmin ? (formMode === "immediate" ? "创建并执行" : "创建计划") : "提交审核"}
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
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          展示尚未执行的定时任务明细（任务名称、Skill、执行时间、创建时间、状态），可点击「回撤」取消该计划。普通用户创建的计划需管理员审核通过后才会执行。
        </p>
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
                <TableHead className="w-[90px]">状态</TableHead>
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
                  <TableCell>
                    {st.review === "pending" ? (
                      <Badge className="bg-amber-500 text-white">待审核</Badge>
                    ) : (
                      <Badge className="bg-green-600 text-white">已通过</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setPreviewItem({
                            title: st.name || "未命名任务",
                            status: st.review === "pending" ? "待审核" : "已通过",
                            fields: taskConfigFields({ ...st, mode: "once" }),
                          })
                        }
                      >
                        <FileText className="size-3.5" />
                        配置
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleWithdrawScheduled(st)}
                        disabled={deletingScheduledId === st.id}
                      >
                        {deletingScheduledId === st.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <X className="size-3.5" />
                        )}
                        回撤
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* ========== 待审核任务（仅管理员） ========== */}
      {isAdmin && (
        <div className="mb-6 rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <ShieldCheck className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">待审核任务</p>
            <span className="text-xs text-muted-foreground">
              普通用户提交的任务需审核通过后才执行
            </span>
          </div>
          {loadingApprovals ? (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 加载中…
            </p>
          ) : pendingRuns.length === 0 && pendingDefs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无待审核任务</p>
          ) : (
            <>
              {pendingRuns.length > 0 && (
                <div className="border-b border-border">
                  <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
                    立即执行任务（{pendingRuns.length}）
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/90 hover:bg-muted/90">
                        <TableHead className="min-w-[140px]">任务名称</TableHead>
                        <TableHead className="w-[120px]">Skill</TableHead>
                        <TableHead className="w-[100px]">Skill Owner</TableHead>
                        <TableHead className="min-w-[160px]">JQL</TableHead>
                        <TableHead className="w-[90px]">提交人</TableHead>
                        <TableHead className="w-[150px]">提交时间</TableHead>
                        <TableHead className="w-[190px] text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pendingRuns.map((r) => (
                        <TableRow key={r.id} className="align-middle">
                          <TableCell>
                            <p className="line-clamp-1 text-sm font-medium">{r.name || "-"}</p>
                            {r.email && (
                              <p className="line-clamp-1 text-xs text-muted-foreground">{r.email}</p>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{r.skill || "-"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {r.skillOwner || "-"}
                          </TableCell>
                          <TableCell className="max-w-[260px]">
                            <p className="line-clamp-1 font-mono text-xs text-muted-foreground">{r.jql}</p>
                          </TableCell>
                          <TableCell className="text-sm">{r.owner || "-"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.createdAt || "-"}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setPreviewItem({
                                    title: r.name || "未命名任务",
                                    status: "待审核",
                                    fields: taskConfigFields(r),
                                  })
                                }
                              >
                                <FileText className="size-3.5" />
                                配置
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-green-600 text-green-600 hover:bg-green-600 hover:text-white"
                                disabled={reviewingKey !== ""}
                                onClick={() => openReviewModal("run", r, true)}
                              >
                                {reviewingKey === `run:${r.id}` ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <Check className="size-3.5" />
                                )}
                                通过
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-destructive text-destructive hover:bg-destructive hover:text-white"
                                disabled={reviewingKey !== ""}
                                onClick={() => openReviewModal("run", r, false)}
                              >
                                {reviewingKey === `run:${r.id}` ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <X className="size-3.5" />
                                )}
                                拒绝
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {pendingDefs.length > 0 && (
                <div>
                  <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
                    指定时间任务（{pendingDefs.length}）
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/90 hover:bg-muted/90">
                        <TableHead className="min-w-[140px]">任务名称</TableHead>
                        <TableHead className="w-[120px]">Skill</TableHead>
                        <TableHead className="w-[160px]">执行时间</TableHead>
                        <TableHead className="w-[90px]">提交人</TableHead>
                        <TableHead className="w-[150px]">提交时间</TableHead>
                        <TableHead className="w-[190px] text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pendingDefs.map((d) => (
                        <TableRow key={d.id} className="align-middle">
                          <TableCell>
                            <p className="line-clamp-1 text-sm font-medium">{d.name || "-"}</p>
                            {d.email && (
                              <p className="line-clamp-1 text-xs text-muted-foreground">{d.email}</p>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{d.skill || "-"}</TableCell>
                          <TableCell className="font-mono text-xs text-foreground">{d.runAt || "-"}</TableCell>
                          <TableCell className="text-sm">{d.owner || "-"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{d.createdAt || "-"}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setPreviewItem({
                                    title: d.name || "未命名任务",
                                    status: "待审核",
                                    fields: taskConfigFields({ ...d, mode: "once" }),
                                  })
                                }
                              >
                                <FileText className="size-3.5" />
                                配置
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-green-600 text-green-600 hover:bg-green-600 hover:text-white"
                                disabled={reviewingKey !== ""}
                                onClick={() => openReviewModal("def", d, true)}
                              >
                                {reviewingKey === `def:${d.id}` ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <Check className="size-3.5" />
                                )}
                                通过
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-destructive text-destructive hover:bg-destructive hover:text-white"
                                disabled={reviewingKey !== ""}
                                onClick={() => openReviewModal("def", d, false)}
                              >
                                {reviewingKey === `def:${d.id}` ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <X className="size-3.5" />
                                )}
                                拒绝
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ========== 任务列表 ========== */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-medium">任务列表</p>
          <p className="text-xs text-muted-foreground">
            共 <span className="font-mono font-medium text-foreground">{total}</span> 条
            {hasActive && (
              <span className="ml-2 flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" /> 自动刷新中
              </span>
            )}
          </p>
        </div>
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          查看状态/进度/队列位置，可用「日志」查看、「下载日志/结果」下载、「停止」终止排队或运行中的任务。
        </p>
        {/* 筛选栏：Skill / 上传者(管理员) / 日期范围 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <Select value={filterSkill} onValueChange={(v) => { setFilterSkill(String(v ?? "")); setPage(1) }}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="全部 Skill" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部 Skill</SelectItem>
              {skillOptions.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Select value={filterOwner} onValueChange={(v) => { setFilterOwner(String(v ?? "")); setPage(1) }}>
              <SelectTrigger className="w-[160px]"><SelectValue placeholder="全部上传者" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部上传者</SelectItem>
                {ownerOptions.map((o) => (
                  <SelectItem key={o} value={o}>{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              className="w-[150px]"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); setPage(1) }}
            />
            <span className="text-xs text-muted-foreground">至</span>
            <Input
              type="date"
              className="w-[150px]"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); setPage(1) }}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilterSkill("all")
              setFilterOwner("all")
              setFilterFrom("")
              setFilterTo("")
              setPage(1)
            }}
          >
            重置
          </Button>
        </div>
        <Table>
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="bg-muted/90 hover:bg-muted/90 backdrop-blur">
              <TableHead className="min-w-[140px]">任务名称</TableHead>
              <TableHead className="w-[120px]">Skill</TableHead>
              <TableHead className="w-[120px]">Skill Owner</TableHead>
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
                <TableCell colSpan={8} className="py-16 text-center text-muted-foreground">
                  暂无任务，请在上方创建新任务
                </TableCell>
              </TableRow>
            )}
            {loadingTasks && tasks.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-16 text-center text-muted-foreground">
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
                <TableCell className="text-sm text-muted-foreground">
                  {task.skillOwner || "-"}
                </TableCell>
                <TableCell>{renderStatus(task.status)}</TableCell>
                <TableCell>{renderProgress(task)}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {task.status === "queued" ? `#${task.queuePosition}` : "-"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{task.createdAt}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {/* 查看完整配置 */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setPreviewItem({
                          title: task.name || "未命名任务",
                          status: task.status,
                          fields: [
                            ...taskConfigFields(task),
                            { label: "状态", value: (STATUS_META[task.status] || { label: task.status }).label },
                          ],
                        })
                      }
                    >
                      <FileText className="size-3.5" />
                      配置
                    </Button>
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
        {/* 分页栏 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">
            第 {page} / {Math.max(1, Math.ceil(total / Math.max(1, pageSize)))} 页
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={String(pageSize)}
              onValueChange={(v) => { setPageSize(Number(v)); setPage(1) }}
            >
              <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 / 页</SelectItem>
                <SelectItem value="20">20 / 页</SelectItem>
                <SelectItem value="50">50 / 页</SelectItem>
                <SelectItem value="100">100 / 页</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || loadingTasks}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= Math.max(1, Math.ceil(total / Math.max(1, pageSize))) || loadingTasks}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
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

      {/* ========== 任务配置预览弹窗 ========== */}
      {previewItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setPreviewItem(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">任务配置：{previewItem.title}</span>
                {previewItem.status && (
                  <span className="text-xs text-muted-foreground">（{previewItem.status}）</span>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setPreviewItem(null)}>
                关闭
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
                {previewItem.fields.map((f) => (
                  <div key={f.label} className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">{f.label}</p>
                    <p className="break-all text-sm">{f.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== 管理员审核弹窗（配置预览 + 备注 + 通过/拒绝） ========== */}
      {reviewTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setReviewTarget(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                {reviewTarget.accept ? (
                  <Check className="size-4 text-green-600" />
                ) : (
                  <X className="size-4 text-destructive" />
                )}
                <span className="text-sm font-medium">
                  {reviewTarget.accept ? "通过审核" : "拒绝执行"}：{reviewTarget.item.name || "未命名任务"}
                </span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setReviewTarget(null)} disabled={reviewSubmitting}>
                关闭
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">任务完整配置</p>
              <div className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-border bg-muted/30 p-3 md:grid-cols-2">
                {taskConfigFields({
                  ...reviewTarget.item,
                  mode: reviewTarget.kind === "def" ? "once" : "immediate",
                }).map((f) => (
                  <div key={f.label} className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">{f.label}</p>
                    <p className="break-all text-sm">{f.value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 space-y-1.5">
                <Label htmlFor="review-remark">审核备注（可选，随结果通知发送给申请人）</Label>
                <Textarea
                  id="review-remark"
                  value={reviewRemark}
                  onChange={(e) => setReviewRemark(e.target.value)}
                  placeholder="例如：JQL 范围过大请确认后重新提交；或：已通过，稍后调度执行"
                  className="min-h-20 text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button variant="outline" onClick={() => setReviewTarget(null)} disabled={reviewSubmitting}>
                取消
              </Button>
              <Button
                variant={reviewTarget.accept ? "default" : "destructive"}
                onClick={submitReview}
                disabled={reviewSubmitting}
              >
                {reviewSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : reviewTarget.accept ? (
                  <Check className="size-4" />
                ) : (
                  <X className="size-4" />
                )}
                确认{reviewTarget.accept ? "通过" : "拒绝"}
              </Button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
