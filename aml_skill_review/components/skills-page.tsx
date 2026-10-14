// ============================================================
// Skill 管理页组件（主体）
// 作用：承载 Skill 资源的全生命周期管理：
//  1. 列表展示：主表格展示当前用户（owner）的 Skill，管理员可查看
//     全部；页面顶部「全部 Skill 缩略图」对所有用户可见全部（可搜索、可折叠），
//     每行含名称、类型、所有者、描述、文件数、操作按钮；
//  2. 上传新 Skill：弹出对话框，填写类型（已有下拉 + 自定义）、
//     名称、zip 文件，POST 到 /api/backend/skills；上传后进入
//     审核暂存，管理员通过后方可放入/覆盖正式 Skill；
//  3. 审核（管理员）：通过 /api/backend/skills/reviews/<id>/approve
//     或 reject 处理待审核上传；
//  4. 预览 Skill：弹出面板，左侧文件树右侧文件内容，
//     调用 /api/backend/skills/files?path= 与 /api/backend/skills/content?path=&file=；
//  5. 删除 Skill：确认后 DELETE /api/backend/skills/delete?path=；
//  6. 设置所有者（管理员）：PUT /api/backend/skills/owner（body 带 path）。
// 注：skill 相对路径含斜杠，统一通过 query 参数 path 传递，
//     不使用 catch-all 路由段。
// 权限：所有用户可查看顶部「全部 Skill 缩略图中的全部 Skill；
// 主表格仅展示自己（owner）的 Skill，管理员可见全部。
// ============================================================

"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FolderTree,
  Loader2,
  Eye,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { AppNavbar } from "@/components/app-navbar"
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

/** Skill 信息类型（与后端 SkillInfo 对应） */
type SkillInfo = {
  skillPath: string // 相对路径，如 "wifi_bt_skills/wifi-bug-analyzer"
  skillName: string
  skillType: string
  owner: string
  description: string
  hasSkillMd: boolean
  fileCount: number
  createdAt: string
  updatedAt: string
}

/** Skill 目录下的一个文件（与后端 listSkillFiles 返回结构对应） */
type SkillFile = {
  path: string
  name: string
  size: number
}

/** 上传审核记录（与后端 list_pending_uploads 返回结构对应） */
type ReviewItem = {
  id: string
  skillName: string
  exists: boolean // 是否与已有 Skill 同名（通过后将覆盖）
  owner: string
  uploadedAt: string
}

/** 文件树节点：把扁平的文件路径列表组织成树结构 */
type TreeNode = {
  name: string
  path: string
  isDir: boolean
  children: TreeNode[]
  size?: number
}

/**
 * 把扁平的文件路径列表转成树结构。
 * 作用：预览面板左侧需要按目录层级展示文件，方便用户浏览。
 */
function buildFileTree(files: SkillFile[]): TreeNode[] {
  const root: TreeNode[] = []
  for (const file of files) {
    const parts = file.path.split("/")
    let current = root
    let curPath = ""
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      curPath = curPath ? `${curPath}/${part}` : part
      const isLast = i === parts.length - 1
      let node = current.find((n) => n.name === part)
      if (!node) {
        node = {
          name: part,
          path: curPath,
          isDir: !isLast,
          children: [],
          size: isLast ? file.size : undefined,
        }
        current.push(node)
      }
      if (!isLast) current = node.children
    }
  }
  // 排序：目录在前、文件在后，各自按名称排序
  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const n of nodes) sortNodes(n.children)
  }
  sortNodes(root)
  return root
}

/** 递归渲染文件树节点 */
function renderTreeNodes(
  nodes: TreeNode[],
  level: number,
  selectedPath: string,
  onSelect: (path: string) => void,
): ReactNode {
  return nodes.map((node) => (
    <div key={node.path}>
      <button
        type="button"
        disabled={node.isDir}
        onClick={() => !node.isDir && onSelect(node.path)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-muted",
          node.isDir && "cursor-default font-medium text-muted-foreground",
          !node.isDir &&
            selectedPath === node.path &&
            "bg-muted font-medium text-foreground",
          !node.isDir && selectedPath !== node.path && "text-muted-foreground",
        )}
        style={{ paddingLeft: `${level * 12 + 6}px` }}
      >
        {node.isDir ? (
          <FolderTree className="size-3 shrink-0" />
        ) : (
          <FileSpreadsheet className="size-3 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {node.isDir && node.children.length > 0 && (
        <div>{renderTreeNodes(node.children, level + 1, selectedPath, onSelect)}</div>
      )}
    </div>
  ))
}

export function SkillsPage({ username, isAdmin }: { username: string; isAdmin: boolean }) {
  const router = useRouter()

  // ---------- 列表状态 ----------
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)

  // ---------- 全部 Skill 缩略图状态（所有用户可见，可搜索、可折叠） ----------
  const [thumbExpanded, setThumbExpanded] = useState(true)
  const [thumbKeyword, setThumbKeyword] = useState("")

  // ---------- 上传审核状态 ----------
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [reviewingId, setReviewingId] = useState("")

  // ---------- 审核预览（暂存内容）状态 ----------
  const [previewReview, setPreviewReview] = useState<ReviewItem | null>(null)
  const [reviewPreviewFiles, setReviewPreviewFiles] = useState<SkillFile[]>([])
  const [reviewSelectedFile, setReviewSelectedFile] = useState("")
  const [reviewFileContent, setReviewFileContent] = useState("")
  const [reviewLoadingFiles, setReviewLoadingFiles] = useState(false)
  const [reviewLoadingContent, setReviewLoadingContent] = useState(false)

  // ---------- 上传对话框状态 ----------
  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadMode, setUploadMode] = useState<"zip" | "folder">("zip") // 上传方式：zip 压缩包 / 文件夹
  const [zipFile, setZipFile] = useState<File | null>(null) // zip 文件
  const [folderFiles, setFolderFiles] = useState<File[]>([]) // 文件夹内的全部文件
  const [formOwner, setFormOwner] = useState("") // 所有者（管理员可指定）

  // ---------- 预览面板状态 ----------
  const [previewSkill, setPreviewSkill] = useState<SkillInfo | null>(null)
  const [previewFiles, setPreviewFiles] = useState<SkillFile[]>([])
  const [selectedFile, setSelectedFile] = useState("")
  const [fileContent, setFileContent] = useState("")
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingContent, setLoadingContent] = useState(false)

  // ---------- 设置所有者对话框状态 ----------
  const [ownerSkill, setOwnerSkill] = useState<SkillInfo | null>(null)
  const [showOwnerDialog, setShowOwnerDialog] = useState(false)
  const [newOwner, setNewOwner] = useState("")
  const [settingOwner, setSettingOwner] = useState(false)

  /**
   * 加载 Skill 列表。
   * 作用：调用 /api/backend/skills 获取全部 Skill，供主表格与顶部缩略图使用。
   */
  const loadSkills = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/backend/skills")
      // 会话失效 → 回到登录页
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取 Skill 列表失败")
      setSkills(data.data || [])
      console.log(`[Skill管理] 获取列表成功: ${data.data?.length || 0} 个`)
    } catch (err) {
      console.error("[Skill管理] 获取列表失败:", err)
      toast.error("获取 Skill 列表失败", { description: String(err) })
    } finally {
      setLoading(false)
    }
  }, [router])

  /**
   * 加载当前用户的 Skill 上传审核列表。
   * 作用：调用 /api/backend/skills/reviews；管理员看到全部待审核项，
   * 普通用户只看到自己提交的待审核项。
   */
  const loadReviews = useCallback(async () => {
    try {
      const res = await fetch("/api/backend/skills/reviews")
      if (res.status === 401) {
        router.push("/login")
        return
      }
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取待审核列表失败")
      setReviews(data.data || [])
    } catch (err) {
      console.error("[Skill管理] 获取待审核列表失败:", err)
    }
  }, [router])

  useEffect(() => {
    loadSkills()
    loadReviews()
  }, [loadSkills, loadReviews])

  /**
   * 上传新 Skill。
   * 作用：组装 FormData（zip 压缩包或文件夹 + 所有者），
   * POST 到 /api/backend/skills；若存在同名 Skill（409），
   * 二次确认后带 confirm_duplicate=1 重新提交；成功后关闭对话框、刷新列表。
   */
  async function handleUpload() {
    /** 组装并提交；confirmed=true 时追加 confirm_duplicate=1 */
    async function doSubmit(confirmed: boolean) {
      const formData = new FormData()
      // 管理员可指定 owner，普通用户不传（服务端自动用自己）
      if (isAdmin && formOwner.trim()) {
        formData.append("owner", formOwner.trim())
      }
      if (uploadMode === "zip") {
        if (!zipFile) {
          toast.error("请选择 zip 压缩包")
          return null
        }
        formData.append("files", zipFile)
      } else {
        if (folderFiles.length === 0) {
          toast.error("请选择要上传的文件夹")
          return null
        }
        // 用相对路径作为文件名，服务端据此还原目录结构
        for (const f of folderFiles) {
          formData.append("files", f, f.webkitRelativePath || f.name)
        }
      }
      if (confirmed) formData.append("confirm_duplicate", "1")

      const res = await fetch("/api/backend/skills", { method: "POST", body: formData })
      const body = await res.json()
      return { res, body }
    }

    setUploading(true)
    try {
      const first = await doSubmit(false)
      if (!first) return
      // 存在同名 Skill（409）→ 二次确认后再提交
      if (first.res.status === 409) {
        const msg =
          (first.body?.error as string) ||
          "已存在同名 Skill，确认之后将等待管理员审核，审核通过后覆盖原 Skill。"
        const ok = window.confirm(`${msg}\n\n确认上传吗？`)
        if (!ok) return
        const second = await doSubmit(true)
        if (!second || !second.body?.ok) {
          throw new Error(second?.body?.error || "上传失败")
        }
        // 二次确认后按是否存在同名提示
        const uploaded = second.body.data || {}
        toast.success(uploaded.exists ? "已提交审核（将覆盖同名 Skill）" : "已提交审核", {
          description: uploaded.exists
            ? `「${uploaded.skillPath || "未知"}」已提交，管理员审核通过后将覆盖原 Skill`
            : `「${uploaded.skillPath || "未知"}」已提交，管理员审核通过后即可使用`,
        })
      } else {
        if (!first.body?.ok) throw new Error(first.body?.error || "上传失败")
        const uploaded = first.body.data || {}
        if (uploaded.exists) {
          // 存在同名 Skill：审核通过后才会覆盖
          toast.success("已提交审核（存在同名 Skill）", {
            description: `「${uploaded.skillPath || "未知"}」已提交，管理员审核通过后将覆盖原 Skill`,
          })
        } else {
          toast.success("已提交审核", {
            description: `「${uploaded.skillPath || "未知"}」已提交，管理员审核通过后即可使用`,
          })
        }
      }
      // 重置表单 + 关闭对话框 + 刷新审核列表与 Skill 列表
      resetUploadForm()
      setShowUpload(false)
      await loadReviews()
      await loadSkills()
    } catch (err) {
      console.error("[Skill管理] 上传失败:", err)
      toast.error("上传失败", { description: String(err) })
    } finally {
      setUploading(false)
    }
  }

  /** 重置上传表单各字段 */
  function resetUploadForm() {
    setUploadMode("zip")
    setZipFile(null)
    setFolderFiles([])
    setFormOwner("")
  }

  /**
   * 处理上传审核（仅管理员）。
   * 作用：同意（approve）后暂存的 Skill 放入正式目录（同名先覆盖）；
   * 拒绝（reject）后丢弃暂存内容。成功后刷新审核列表与 Skill 列表。
   */
  async function handleReview(review: ReviewItem, action: "approve" | "reject") {
    if (action === "reject" && !window.confirm(`确定拒绝 Skill「${review.skillName}」的上传吗？暂存内容将被丢弃。`)) {
      return
    }
    setReviewingId(review.id)
    try {
      const res = await fetch(`/api/backend/skills/reviews/${review.id}/${action}`, {
        method: "POST",
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || `${action === "approve" ? "通过" : "拒绝"}失败`)
      if (action === "approve") {
        toast.success("已通过审核", {
          description: `「${review.skillName}」已放入正式目录${review.exists ? "（原 Skill 已被覆盖）" : ""}`,
        })
      } else {
        toast.success("已拒绝上传", { description: `「${review.skillName}」的暂存内容已丢弃` })
      }
      await loadReviews()
      await loadSkills()
    } catch (err) {
      console.error("[Skill管理] 处理审核失败:", err)
      toast.error(action === "approve" ? "通过失败" : "拒绝失败", { description: String(err) })
    } finally {
      setReviewingId("")
    }
  }

  /**
   * 撤销上传（审核通过前，仅该上传的 owner 可操作）。
   * 作用：调用 POST /api/backend/skills/reviews/<id>/withdraw，
   * 丢弃暂存内容并移除审核记录，成功后刷新审核列表。
   */
  async function handleWithdraw(review: ReviewItem) {
    if (!window.confirm(`确定撤销 Skill「${review.skillName}」的上传吗？暂存内容将被丢弃。`)) return
    setReviewingId(review.id)
    try {
      const res = await fetch(`/api/backend/skills/reviews/${review.id}/withdraw`, {
        method: "POST",
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "撤回失败")
      toast.success("已撤销上传", { description: `「${review.skillName}」的暂存内容已丢弃` })
      await loadReviews()
      await loadSkills()
    } catch (err) {
      console.error("[Skill管理] 撤销上传失败:", err)
      toast.error("撤销失败", { description: String(err) })
    } finally {
      setReviewingId("")
    }
  }

  /**
   * 打开审核预览面板（审核通过前，owner 与管理员可提前查看暂存内容）。
   * 作用：加载暂存文件树，自动选中 SKILL.md（若存在）或第一个文件。
   */
  async function handleReviewPreview(review: ReviewItem) {
    setPreviewReview(review)
    setReviewSelectedFile("")
    setReviewFileContent("")
    setReviewPreviewFiles([])
    setReviewLoadingFiles(true)
    try {
      const res = await fetch(`/api/backend/skills/reviews/${review.id}/files`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取文件列表失败")
      const files: SkillFile[] = data.data || []
      setReviewPreviewFiles(files)
      // 优先选中 SKILL.md，否则选第一个文件
      const skillMd = files.find((f) => f.path.toUpperCase() === "SKILL.MD")
      const target = skillMd || files[0]
      if (target) {
        setReviewSelectedFile(target.path)
        loadReviewFileContent(review.id, target.path)
      }
      console.log(`[Skill管理] 审核预览 ${review.skillName}，共 ${files.length} 个文件`)
    } catch (err) {
      console.error("[Skill管理] 获取审核文件列表失败:", err)
      toast.error("获取文件列表失败", { description: String(err) })
    } finally {
      setReviewLoadingFiles(false)
    }
  }

  /** 读取审核暂存文件内容（走 /reviews/<id>/content） */
  async function loadReviewFileContent(reviewId: string, filePath: string) {
    setReviewLoadingContent(true)
    setReviewFileContent("")
    try {
      const res = await fetch(
        `/api/backend/skills/reviews/${reviewId}/content?file=${encodeURIComponent(filePath)}`,
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "读取文件失败")
      setReviewFileContent(data.data || "")
    } catch (err) {
      console.error("[Skill管理] 读取审核文件失败:", err)
      toast.error("读取文件失败", { description: String(err) })
    } finally {
      setReviewLoadingContent(false)
    }
  }

  /** 关闭审核预览面板并清理状态 */
  function closeReviewPreview() {
    setPreviewReview(null)
    setReviewPreviewFiles([])
    setReviewSelectedFile("")
    setReviewFileContent("")
  }

  /**
   * 删除 Skill（带确认）。
   * 作用：用户确认后调用 DELETE /api/backend/skills/<path>，
   * 成功后刷新列表。
   */
  async function handleDelete(skill: SkillInfo) {
    if (!window.confirm(`确定删除 Skill「${skill.skillName}」吗？此操作不可撤销。`)) return
    try {
      const res = await fetch(
        `/api/backend/skills/delete?path=${encodeURIComponent(skill.skillPath)}`,
        {
          method: "DELETE",
        },
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "删除失败")
      toast.success("删除成功", { description: skill.skillPath })
      await loadSkills()
    } catch (err) {
      console.error("[Skill管理] 删除失败:", err)
      toast.error("删除失败", { description: String(err) })
    }
  }

  /**
   * 打开预览面板。
   * 作用：设置当前预览的 Skill，加载其文件列表，
   * 自动选中 SKILL.md（若存在）或第一个文件。
   */
  async function handlePreview(skill: SkillInfo) {
    setPreviewSkill(skill)
    setSelectedFile("")
    setFileContent("")
    setPreviewFiles([])
    setLoadingFiles(true)
    try {
      const res = await fetch(
        `/api/backend/skills/files?path=${encodeURIComponent(skill.skillPath)}`,
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "获取文件列表失败")
      const files: SkillFile[] = data.data || []
      setPreviewFiles(files)
      // 优先选中 SKILL.md，否则选第一个文件
      const skillMd = files.find((f) => f.path.toUpperCase() === "SKILL.MD")
      const target = skillMd || files[0]
      if (target) {
        setSelectedFile(target.path)
        loadFileContent(skill.skillPath, target.path)
      }
      console.log(`[Skill管理] 预览 ${skill.skillPath}，共 ${files.length} 个文件`)
    } catch (err) {
      console.error("[Skill管理] 获取文件列表失败:", err)
      toast.error("获取文件列表失败", { description: String(err) })
    } finally {
      setLoadingFiles(false)
    }
  }

  /**
   * 加载文件内容。
   * 作用：调用 /api/backend/skills/<path>/content?file=<filePath>
   * 读取指定文件的文本内容，显示在预览面板右侧。
   */
  async function loadFileContent(skillPath: string, filePath: string) {
    setLoadingContent(true)
    setFileContent("")
    try {
      const res = await fetch(
        `/api/backend/skills/content?path=${encodeURIComponent(skillPath)}&file=${encodeURIComponent(filePath)}`,
      )
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "读取文件失败")
      setFileContent(data.data || "")
      console.log(`[Skill管理] 读取文件 ${filePath} 成功`)
    } catch (err) {
      console.error("[Skill管理] 读取文件失败:", err)
      toast.error("读取文件失败", { description: String(err) })
    } finally {
      setLoadingContent(false)
    }
  }

  /** 关闭预览面板并清理状态 */
  function closePreview() {
    setPreviewSkill(null)
    setPreviewFiles([])
    setSelectedFile("")
    setFileContent("")
  }

  /** 打开设置所有者对话框，预填当前 owner */
  function openOwnerDialog(skill: SkillInfo) {
    setOwnerSkill(skill)
    setNewOwner(skill.owner || "")
    setShowOwnerDialog(true)
  }

  /**
   * 设置 Skill 所有者（仅管理员）。
   * 作用：调用 PUT /api/backend/skills/<path>/owner 修改 owner，
   * 成功后关闭对话框并刷新列表。
   */
  async function handleSetOwner() {
    if (!ownerSkill) return
    if (!newOwner.trim()) {
      toast.error("请输入新所有者用户名")
      return
    }
    setSettingOwner(true)
    try {
      const res = await fetch(`/api/backend/skills/owner`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: ownerSkill.skillPath, owner: newOwner.trim() }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "设置失败")
      toast.success("设置成功", {
        description: `${ownerSkill.skillName} 的所有者已改为 ${newOwner.trim()}`,
      })
      setShowOwnerDialog(false)
      setOwnerSkill(null)
      await loadSkills()
    } catch (err) {
      console.error("[Skill管理] 设置所有者失败:", err)
      toast.error("设置所有者失败", { description: String(err) })
    } finally {
      setSettingOwner(false)
    }
  }

  // ---------- 派生数据 ----------
  // 主表格：管理员看全部 Skill，普通用户只看自己（owner=username）的
  const tableSkills = isAdmin ? skills : skills.filter((s) => s.owner === username)
  // 全部 Skill 缩略图：所有用户可见全部，按关键字过滤（名称/类型/所有者/描述）
  const kw = thumbKeyword.trim().toLowerCase()
  const thumbSkills = kw
    ? skills.filter(
        (s) =>
          s.skillName.toLowerCase().includes(kw) ||
          s.skillType.toLowerCase().includes(kw) ||
          (s.owner || "").toLowerCase().includes(kw) ||
          (s.description || "").toLowerCase().includes(kw)
      )
    : skills

  return (
    <div>
      {/* 统一顶部导航栏 */}
      <AppNavbar username={username} isAdmin={isAdmin} />

      <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
        {/* ========== 页面标题（审核通知已统一收拢到顶部导航栏通知中心） ========== */}
        <header className="mb-6">
          <p className="text-sm font-medium text-muted-foreground">Skill 管理</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">Skill 管理</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            管理 Skill 资源：上传 zip 压缩包或文件夹（上传后需管理员审核通过方可使用）、预览文件内容、删除、设置所有者。主列表只显示您名下的 Skill（管理员可查看全部），页面顶部「全部 Skill」缩略图对所有用户可见。
          </p>
        </header>

      {/* ========== 使用说明 ========== */}
      <div className="mb-6 rounded-xl border border-border bg-muted/40 p-4 text-sm leading-relaxed text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">使用说明</p>
        <ul className="list-inside list-disc space-y-1">
          <li>上传：点击左侧「上传新 Skill」，选择 zip 压缩包或一个文件夹（文件夹需包含 SKILL.md）。系统会读取 SKILL.md 中的 name 字段作为 Skill 名称，上传后需管理员审核，审核通过后方可使用；若已存在同名 Skill，会弹出二次确认，确认后需等待管理员审核通过才会覆盖原 Skill。</li>
          <li>预览：在列表点击「预览」，左侧为文件树、右侧查看选中的文件内容。</li>
          <li>审核：审核通过前，上传者可在「上传审核」区域点击「撤销」撤回本次上传（暂存内容将被丢弃）；管理员审核通过/拒绝后，顶部导航栏「通知中心」铃铛会收到结果通知，可点击「取消通知」将其移除（之后不再发送）。</li>
          <li>删除：仅管理员可以删除 Skill，普通用户不提供删除功能（删除不可恢复）。</li>
          <li>设置所有者：仅管理员可以设置/修改 Skill 的所有者。</li>
          <li>Skill 列表：下方表格只显示所有者为您本人的 Skill（管理员显示全部）；上传新 Skill 前，请在顶部「全部 Skill」中搜索关键描述，确认已有 Skill 不包含您要上传的触发条件，再上传。</li>
        </ul>
      </div>

      {/* ========== 全部 Skill 缩略图（所有用户可见全部，可搜索、可折叠） ========== */}
      <div className="mb-6 rounded-xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setThumbExpanded((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left"
          aria-expanded={thumbExpanded}
        >
          {thumbExpanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">全部 Skill 缩略图</span>
          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs">
            {skills.length}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {thumbExpanded ? "点击折叠" : "点击展开"}
          </span>
        </button>
        {thumbExpanded && (
          <div className="border-t border-border p-4">
            <div className="relative mb-3">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="搜索 Skill 的名称 / 描述 / 类型 / 所有者…"
                value={thumbKeyword}
                onChange={(e) => setThumbKeyword(e.target.value)}
              />
            </div>
            {thumbSkills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {kw ? "未找到匹配的 Skill" : "暂无 Skill"}
              </p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-auto">
                {thumbSkills.map((s) => (
                  <div
                    key={s.skillPath}
                    className="rounded-lg border border-border bg-muted/30 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-sm font-medium">{s.skillName}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {s.skillType}
                      </span>
                      {s.owner && <span className="text-xs text-muted-foreground">@{s.owner}</span>}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {s.description || "-"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* ========== 左侧侧边栏：操作按钮 + 类型列表 + 用户信息 ========== */}
        <aside className="w-full shrink-0 lg:w-64">
          <div className="rounded-xl border border-border bg-card p-4">
            {/* 上传新 Skill */}
            <Button
              className="w-full"
              onClick={() => {
                resetUploadForm()
                setShowUpload(true)
              }}
            >
              <Upload className="size-4" />
              上传新 Skill
            </Button>
          </div>

          {/* 当前登录用户信息 */}
          <div className="mt-4 rounded-xl border border-border bg-card p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <User className="size-4 text-muted-foreground" />
              {username}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isAdmin ? "管理员 · 可管理全部 Skill" : "普通用户 · 可查看全部 Skill 缩略图"}
            </p>
          </div>
        </aside>

        {/* ========== 右侧主区域：Skill 列表表格 ========== */}
        <main className="min-w-0 flex-1">
          {/* 上传审核区 */}
          {reviews.length > 0 && (
            <div className="mb-4 rounded-xl border border-border bg-card p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4 text-muted-foreground" />
                上传审核
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs">
                  {reviews.length}
                </span>
              </p>
              <div className="space-y-2">
                {reviews.map((review) => (
                  <div
                    key={review.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
                  >
                    <span className="font-mono text-sm font-medium">{review.skillName}</span>
                    {review.exists && (
                      <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-xs text-yellow-700 dark:text-yellow-400">
                        同名将覆盖
                      </span>
                    )}
                    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-700 dark:text-sky-400">
                      待审核
                    </span>
                    <span className="text-xs text-muted-foreground">
                      上传者：{review.owner}
                      <span className="mx-1">·</span>
                      {review.uploadedAt}
                    </span>
                    <div className="ml-auto flex gap-1.5">
                      {/* 审核通过前，owner 与管理员可预览暂存内容 */}
                      {(isAdmin || review.owner === username) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={reviewingId === review.id}
                          onClick={() => handleReviewPreview(review)}
                        >
                          <Eye className="size-3.5" />
                          预览
                        </Button>
                      )}
                      {isAdmin ? (
                        <>
                          <Button
                            size="sm"
                            variant="default"
                            disabled={reviewingId === review.id}
                            onClick={() => handleReview(review, "approve")}
                          >
                            {reviewingId === review.id && (
                              <Loader2 className="size-3.5 animate-spin" />
                            )}
                            通过
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={reviewingId === review.id}
                            onClick={() => handleReview(review, "reject")}
                          >
                            拒绝
                          </Button>
                        </>
                      ) : (
                        review.owner === username && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={reviewingId === review.id}
                            onClick={() => handleWithdraw(review)}
                          >
                            {reviewingId === review.id && (
                              <Loader2 className="size-3.5 animate-spin" />
                            )}
                            撤销
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {!isAdmin && (
                <p className="mt-2 text-xs text-muted-foreground">
                  您的上传正在等待管理员审核，审核通过前可点击「撤销」撤回上传。
                </p>
              )}
            </div>
          )}

          {/* 工具条：总条数 + 刷新按钮 */}
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              共 <span className="font-mono font-medium text-foreground">{tableSkills.length}</span> 个 Skill
              {!isAdmin && <span className="ml-1">（我的）</span>}
            </p>
            <Button variant="outline" size="sm" onClick={loadSkills} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
              刷新
            </Button>
          </div>

          {/* Skill 列表（固定高度 + 滚动条） */}
          <div className="max-h-[600px] overflow-auto rounded-xl border border-border bg-card">
            <Table>
              <TableHeader className="sticky top-0 z-10">
                <TableRow className="bg-muted/90 hover:bg-muted/90 backdrop-blur">
                  <TableHead className="min-w-[180px]">Skill 名称</TableHead>
                  <TableHead className="w-[120px]">所有者</TableHead>
                  <TableHead className="min-w-[260px]">描述</TableHead>
                  <TableHead className="w-[80px] text-right">文件数</TableHead>
                  <TableHead className="w-[200px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableSkills.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-16 text-center text-muted-foreground">
                      {isAdmin ? "暂无 Skill，点击左侧「上传新 Skill」添加" : "您名下暂无 Skill，点击左侧「上传新 Skill」添加"}
                    </TableCell>
                  </TableRow>
                )}
                {tableSkills.map((skill) => (
                  <TableRow key={skill.skillPath} className="align-top">
                    <TableCell className="font-mono text-sm font-medium">
                      {skill.skillName}
                    </TableCell>
                    <TableCell className="text-sm">
                      {skill.owner || (
                        <span className="text-muted-foreground">未设置</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[360px] text-sm">
                      <span className="line-clamp-2">{skill.description || "-"}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      <span className="inline-flex items-center gap-1">
                        <FileSpreadsheet className="size-3 text-muted-foreground" />
                        {skill.fileCount}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handlePreview(skill)}
                        >
                          <Eye className="size-3.5" />
                          预览
                        </Button>
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openOwnerDialog(skill)}
                          >
                            <User className="size-3.5" />
                            设主
                          </Button>
                        )}
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDelete(skill)}
                            aria-label="删除"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {loading && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 加载中…
            </p>
          )}
        </main>
      </div>

      {/* ========== 上传对话框 ========== */}
      {showUpload && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            // 点击遮罩关闭对话框（不阻止冒泡的目标本身）
            if (e.target === e.currentTarget) setShowUpload(false)
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">上传新 Skill</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowUpload(false)}
                aria-label="关闭"
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="space-y-4">
              {/* 上传方式：zip 压缩包 / 文件夹 */}
              <div className="space-y-1.5">
                <Label>上传方式</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={uploadMode === "zip" ? "default" : "outline"}
                    onClick={() => setUploadMode("zip")}
                  >
                    Zip 压缩包
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={uploadMode === "folder" ? "default" : "outline"}
                    onClick={() => setUploadMode("folder")}
                  >
                    文件夹
                  </Button>
                </div>
              </div>

              {/* 文件选择：zip 或文件夹 */}
              {uploadMode === "zip" ? (
                <div className="space-y-1.5">
                  <Label>Zip 压缩包</Label>
                  <Input
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(e) => setZipFile(e.target.files?.[0] || null)}
                  />
                  {zipFile && (
                    <p className="text-xs text-muted-foreground">
                      已选择：{zipFile.name}（{(zipFile.size / 1024).toFixed(1)} KB）
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>文件夹（需包含 SKILL.md）</Label>
                  <Input
                    type="file"
                    multiple
                    {...({ webkitdirectory: "" } as Record<string, string>)}
                    onChange={(e) => setFolderFiles(Array.from(e.target.files ?? []))}
                  />
                  {folderFiles.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      已选择文件夹「{folderFiles[0].webkitRelativePath.split("/")[0] || folderFiles[0].name}」，共 {folderFiles.length} 个文件
                    </p>
                  )}
                </div>
              )}

              {/* 所有者（管理员可指定） */}
              {isAdmin && (
                <div className="space-y-1.5">
                  <Label>所有者（留空则为自己）</Label>
                  <Input
                    value={formOwner}
                    onChange={(e) => setFormOwner(e.target.value)}
                    placeholder={username}
                  />
                </div>
              )}

              <p className="text-xs leading-relaxed text-muted-foreground">
                系统会读取 SKILL.md 中的 name 字段作为 Skill 名称。如果已存在同名 Skill，会弹出确认框要求二次确认，确认后需等待管理员审核，审核通过后才会覆盖原 Skill；否则提交后等待管理员审核，审核通过后才会放入，方可使用。审核通过前，可在「上传审核」区域撤销本次上传。
              </p>

              {/* 操作按钮 */}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setShowUpload(false)}>
                  取消
                </Button>
                <Button onClick={handleUpload} disabled={uploading}>
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  上传
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== 预览面板 ========== */}
      {previewSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closePreview()
          }}
        >
          <div className="flex h-[80vh] w-full max-w-5xl flex-col rounded-xl border border-border bg-card shadow-lg">
            {/* 头部 */}
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{previewSkill.skillName}</h2>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {previewSkill.skillPath}
                </p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={closePreview} aria-label="关闭">
                <X className="size-4" />
              </Button>
            </div>

            {/* 主体：左侧文件树 + 右侧文件内容 */}
            <div className="flex min-h-0 flex-1">
              {/* 左侧：文件树 */}
              <div className="w-64 shrink-0 overflow-auto border-r border-border p-2">
                <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
                  <FolderTree className="size-3.5" />
                  文件列表
                </p>
                {loadingFiles ? (
                  <p className="flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> 加载中…
                  </p>
                ) : previewFiles.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">暂无文件</p>
                ) : (
                  renderTreeNodes(
                    buildFileTree(previewFiles),
                    0,
                    selectedFile,
                    (path) => {
                      setSelectedFile(path)
                      loadFileContent(previewSkill.skillPath, path)
                    },
                  )
                )}
              </div>

              {/* 右侧：文件内容 */}
              <div className="min-w-0 flex-1 overflow-auto p-4">
                {loadingContent ? (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> 加载中…
                  </p>
                ) : !selectedFile ? (
                  <p className="text-sm text-muted-foreground">请从左侧选择一个文件查看内容</p>
                ) : (
                  <div className="flex h-full flex-col">
                    <p className="mb-2 font-mono text-xs text-muted-foreground">
                      {selectedFile}
                    </p>
                    <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted p-3 text-xs leading-relaxed">
                      <code>{fileContent}</code>
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== 审核预览面板（审核通过前，owner 与管理员可查看暂存内容） ========== */}
      {previewReview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeReviewPreview()
          }}
        >
          <div className="flex h-[80vh] w-full max-w-5xl flex-col rounded-xl border border-border bg-card shadow-lg">
            {/* 头部 */}
            <div className="flex items-center justify-between border-b border-border p-4">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  {previewReview.skillName}
                  <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-700 dark:text-sky-400">
                    待审核预览
                  </span>
                  {previewReview.exists && (
                    <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-xs text-yellow-700 dark:text-yellow-400">
                      同名将覆盖
                    </span>
                  )}
                </h2>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  上传者：{previewReview.owner} · {previewReview.uploadedAt}
                </p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={closeReviewPreview} aria-label="关闭">
                <X className="size-4" />
              </Button>
            </div>

            {/* 主体：左侧文件树 + 右侧文件内容 */}
            <div className="flex min-h-0 flex-1">
              {/* 左侧：文件树 */}
              <div className="w-64 shrink-0 overflow-auto border-r border-border p-2">
                <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
                  <FolderTree className="size-3.5" />
                  暂存文件
                </p>
                {reviewLoadingFiles ? (
                  <p className="flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> 加载中…
                  </p>
                ) : reviewPreviewFiles.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">暂无文件</p>
                ) : (
                  renderTreeNodes(
                    buildFileTree(reviewPreviewFiles),
                    0,
                    reviewSelectedFile,
                    (path) => {
                      setReviewSelectedFile(path)
                      loadReviewFileContent(previewReview.id, path)
                    },
                  )
                )}
              </div>

              {/* 右侧：文件内容 */}
              <div className="min-w-0 flex-1 overflow-auto p-4">
                {reviewLoadingContent ? (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> 加载中…
                  </p>
                ) : !reviewSelectedFile ? (
                  <p className="text-sm text-muted-foreground">请从左侧选择一个文件查看内容</p>
                ) : (
                  <div className="flex h-full flex-col">
                    <p className="mb-2 font-mono text-xs text-muted-foreground">
                      {reviewSelectedFile}
                    </p>
                    <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted p-3 text-xs leading-relaxed">
                      <code>{reviewFileContent}</code>
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== 设置所有者对话框（管理员） ========== */}
      {showOwnerDialog && ownerSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowOwnerDialog(false)
          }}
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">设置所有者</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowOwnerDialog(false)}
                aria-label="关闭"
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">{ownerSkill.skillName}</p>
                <p className="font-mono text-xs text-muted-foreground">{ownerSkill.skillPath}</p>
              </div>
              <div className="space-y-1.5">
                <Label>新所有者用户名</Label>
                <Input
                  value={newOwner}
                  onChange={(e) => setNewOwner(e.target.value)}
                  placeholder="输入用户名"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSetOwner()
                  }}
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setShowOwnerDialog(false)}>
                  取消
                </Button>
                <Button onClick={handleSetOwner} disabled={settingOwner}>
                  {settingOwner ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <User className="size-4" />
                  )}
                  设置
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
