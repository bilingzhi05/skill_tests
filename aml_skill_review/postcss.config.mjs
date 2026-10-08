// ============================================================
// PostCSS 配置文件
// 作用：让 Tailwind CSS 4 通过 @tailwindcss/postcss 插件参与样式编译。
// 不懂代码可忽略本文件，保持不动即可。
// ============================================================

/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
