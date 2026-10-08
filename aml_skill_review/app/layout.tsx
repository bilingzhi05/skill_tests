// ============================================================
// 根布局文件（整个网站的外壳）
// 作用：所有页面共用的 HTML 骨架。这里负责：
// 1. 设置网页标题和描述；
// 2. 引入全局样式 globals.css；
// 3. 挂载全局提示框组件 Toaster（保存成功时的「已保存」提示就靠它）。
// ============================================================

import type { Metadata } from "next"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

// 网页标题与描述（显示在浏览器标签页上）
export const metadata: Metadata = {
  title: "Jira Skill 评审系统",
  description: "Jira Skill 分析结果查看与人工评审",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" className="bg-background">
      <body className="antialiased">
        {/* children 就是当前访问的页面内容 */}
        {children}
        {/* 全局轻提示（toast）挂载点 */}
        <Toaster />
      </body>
    </html>
  )
}
