/**
 * 文本处理小工具。
 */

const BOM = 0xfeff;

/**
 * 去掉 UTF-8 BOM。
 *
 * Windows 上这不是边缘情况：PowerShell 的 `Set-Content -Encoding utf8`、
 * 记事本、以及不少 CI 脚本都会写出带 BOM 的文件。而 `JSON.parse('\uFEFF{...}')`
 * **会直接抛错**（BOM 不是合法的 JSON 空白）。
 *
 * 不处理它的后果特别隐蔽：web-vitals 上报或 stats.json 明明存在，
 * 适配器却探活失败、被标为「不可用」，用户看到的是「INP 未采集」，
 * 完全想不到问题出在文件开头那三个字节上。
 *
 * 因此所有读取外部文本文件后做 JSON.parse 的地方都要先过这里。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === BOM ? text.slice(1) : text;
}

/** 读取来的文本 → JSON。失败时抛出原始错误，由调用侧决定如何归类 */
export function parseJsonText(text: string): unknown {
  return JSON.parse(stripBom(text)) as unknown;
}
