// ============================================================
// xlsx 导入文件
// 作用：把用户目录下的 xlsx 文件解析成结构化数据，
// 并按「统一字段映射」写入数据库表。
// 包含完整的异常处理：文件损坏、表头不认识、单行数据异常，
// 都不会导致整个导入失败。
// ============================================================

import fs from "fs"
import * as XLSX from "xlsx"
import { matchHeaderToField, FIELD_NAMES } from "@/lib/columns"
import { createTable, insertRows, tableExists } from "@/lib/db"

/**
 * 解析 xlsx 文件为二维数组（第一行是表头，后面是数据）。
 * 作用：读取并解析 xlsx；文件不存在或损坏时抛出带中文说明的错误。
 */
function readSheetRows(filePath: string): unknown[][] {
  // 1. 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`)
  }
  // 2. 读取并解析 xlsx（异常时包装成更友好的错误信息）
  let workbook: XLSX.WorkBook
  try {
    const buffer = fs.readFileSync(filePath)
    workbook = XLSX.read(buffer, { type: "buffer" })
  } catch (err) {
    console.error("[xlsx导入] 解析文件失败:", filePath, err)
    throw new Error(`xlsx 文件解析失败（文件可能已损坏）：${filePath}`)
  }
  // 3. 取第一个工作表
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) {
    throw new Error(`xlsx 文件里没有工作表：${filePath}`)
  }
  const sheet = workbook.Sheets[sheetName]
  // header:1 表示按「数组的数组」输出；defval 保证空单元格变成空字符串
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
  })
  console.log(`[xlsx导入] 读取工作表「${sheetName}」共 ${rows.length} 行（含表头）`)
  return rows
}

/**
 * 单元格值统一转字符串。
 * 作用：xlsx 里的单元格可能是数字、日期对象等，统一转成文本存库，
 * 避免类型问题。
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ""
  return String(value).trim()
}

/**
 * 把 xlsx 数据导入数据库（核心函数）。
 * 作用：导入到「指定登录用户自己的数据库」中：
 *  1. 表已存在 → 直接返回命中缓存，不重复导入；
 *  2. 表不存在 → 解析 xlsx、模糊匹配表头、建表、逐行写入。
 * 返回 { table, rowCount, fromCache, skipped }：
 *  table=表名，rowCount=数据行数，fromCache=是否命中已有表，skipped=失败跳过的行数。
 */
export function importXlsx(
  filePath: string,
  tableName: string,
  username: string,
): { table: string; rowCount: number; fromCache: boolean; skipped: number } {
  // 1. 已有同名表：直接复用（命中缓存）
  if (tableExists(username, tableName)) {
    console.log(`[xlsx导入] 用户「${username}」命中已有表「${tableName}」，跳过重复导入`)
    return { table: tableName, rowCount: 0, fromCache: true, skipped: 0 }
  }

  // 2. 解析 xlsx 全部行
  const rows = readSheetRows(filePath)
  if (rows.length < 2) {
    throw new Error("xlsx 文件只有表头没有数据，无法导入")
  }

  // 3. 表头匹配：把每个 xlsx 表头映射到数据库英文字段
  const headerRow = rows[0].map(cellToString)
  // columnIndex → 英文字段名（匹配失败的列不在其中，数据会被丢弃并警告）
  const columnMap: Record<number, string> = {}
  headerRow.forEach((header, index) => {
    const field = matchHeaderToField(header)
    if (field) {
      columnMap[index] = field
    } else if (header) {
      console.warn(`[xlsx导入] 表头「${header}」无法匹配任何字段，该列数据将被忽略`)
    }
  })
  console.log(
    "[xlsx导入] 表头匹配结果:",
    Object.values(columnMap).join(", "),
  )

  // 4. 建表（建在该用户自己的数据库里）
  createTable(username, tableName)

  // 5. 逐行转换：把一行 xlsx 数据按 columnMap 转成「英文字段 → 值」对象
  const dataRows: Record<string, string>[] = []
  let skipped = 0
  for (let i = 1; i < rows.length; i++) {
    try {
      const raw = rows[i]
      // 跳过完全空白行
      if (!raw || raw.every((c) => cellToString(c) === "")) continue
      const item: Record<string, string> = {}
      for (const field of FIELD_NAMES) item[field] = ""
      for (const [indexStr, field] of Object.entries(columnMap)) {
        item[field] = cellToString(raw[Number(indexStr)])
      }
      dataRows.push(item)
    } catch (err) {
      // 单行出错不影响其它行
      skipped++
      console.warn(`[xlsx导入] 第 ${i + 1} 行解析失败，已跳过:`, err)
    }
  }

  // 6. 批量写入数据库
  const { inserted, skipped: dbSkipped } = insertRows(username, tableName, dataRows)
  console.log(
    `[xlsx导入] 用户「${username}」新建表「${tableName}」完成：成功 ${inserted} 行，失败 ${dbSkipped + skipped} 行`,
  )
  return { table: tableName, rowCount: inserted, fromCache: false, skipped: skipped + dbSkipped }
}
