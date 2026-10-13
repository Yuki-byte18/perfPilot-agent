import type { ReporterPort, ReportFormat } from '@yuki-byte18/shared';
import { createHtmlReporter } from './html.js';
import { createJsonReporter } from './json.js';
import { createMarkdownReporter } from './markdown.js';

/** 每种格式的落盘文件名，pipeline 打印日志时复用，避免两处各写一遍 */
export const REPORT_FORMAT_FILENAME: Record<ReportFormat, string> = {
  markdown: 'report.md',
  json: 'report.json',
  html: 'report.html',
};

/**
 * 按配置装配报告器。
 *
 * 三种格式全部实现（HTML 在 M8 补上）。未知格式仍然**静默跳过而不是报错**：
 * 用户配置里写了 `format: [markdown, html, json]` 是合理的预期，
 * 让整轮诊断因为一份报告格式而失败，是把内部进度泄漏成用户故障。
 */
export function createReporters(formats: readonly ReportFormat[]): ReporterPort[] {
  const reporters: ReporterPort[] = [];

  for (const format of formats) {
    switch (format) {
      case 'markdown':
        reporters.push(createMarkdownReporter());
        break;
      case 'json':
        reporters.push(createJsonReporter());
        break;
      case 'html':
        reporters.push(createHtmlReporter());
        break;
      default:
        break;
    }
  }

  return reporters;
}

export { createJsonReporter } from './json.js';
export { createMarkdownReporter, renderMarkdown } from './markdown.js';
export { createHtmlReporter, renderHtml } from './html.js';
export { createMrCommentReporter, renderMrComment, MR_COMMENT_MARKER } from './mr-comment.js';
