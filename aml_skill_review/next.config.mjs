// ============================================================
// Next.js 构建配置
// 作用：告诉 Next.js 如何构建和运行本项目。
// ============================================================

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  allowedDevOrigins: ['10.18.11.98'], // 允许其他 IP 访问
}

export default nextConfig
