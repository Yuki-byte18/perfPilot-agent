import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 搭一个**可复现的本地演示项目**（`.demo/`）。
 *
 * ## 为什么需要它
 *
 * 这个项目的主要采集来源是 Lighthouse，而它需要真实 Chrome。
 * 没有 Chrome 的机器上，五个来源里只有一个不可用 —— 但很多人就此以为
 * "跑不起来"。实际上其余四个来源（web-vitals / HAR / trace / bundle-analyzer）
 * 读的都是**文件**，喂一份真实形状的输入就能跑通整条链路，
 * 包括执行 → 验证 → 保留/回滚。
 *
 * 这个脚本生成的就是那份输入。它同时是一个**活的规格**：
 * 四个 adapter 到底吃什么形状的数据，看这一个文件比翻四个 parse 快得多。
 *
 *   node scripts/demo-setup.mjs        # 重建 .demo/
 *   cd .demo && node ../packages/cli/dist/index.js run
 *
 * ## 两条刻意让演示能跑通的约定（都是真实限制的体现）
 *
 * 1. **HAR 里的 URL 带 `dist/` 前缀**（`/dist/assets/hero.jpg`）。
 *    HAR 记的是部署后的 URL，而资产执行器按**项目根**解析路径 ——
 *    两者对齐，"压缩图片"这条候选才找得到文件。
 *    真实项目里部署路径与仓库路径常常不一致（`public/assets` → `/assets`），
 *    那是一个真实的限制，不该靠这个脚本掩盖。
 * 2. **`dist/` 不进 `.gitignore`**。被忽略的文件既提交不了、也回滚不了
 *    （`git reset --hard` 不动被忽略的文件）—— 演示要能看到"保留"这一步，
 *    目标文件就必须是 tracked 的。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const demo = join(root, '.demo');

const sizes = { js: 512_000, css: 84_000, imageWidth: 1920, imageHeight: 1280 };

/** 可压缩的文本内容：重复的代码行，压缩率真实且稳定 */
function jsSource(bytes) {
  const line = 'export function helper(i){return {id:i,label:`row-${i}`,value:i*2};}\n';
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

function cssSource(bytes) {
  const rule = '.row{display:flex;align-items:center;padding:8px;border-bottom:1px solid #eee}\n';
  return rule.repeat(Math.ceil(bytes / rule.length)).slice(0, bytes);
}

const CONFIG = `# PerfPilot 演示项目配置
project:
  name: demo-shop
  root: .

target:
  url: https://shop.example.com
  routes:
    - /

baseline:
  ref: last-run
  metrics:
    LCP: { warning: 2500, error: 4000 }
    CLS: { warning: 0.1, error: 0.25 }
    INP: { warning: 200, error: 500 }

optimization:
  auto_fix:
    - OVERSIZED_IMAGE
    - UNCOMPRESSED_IMAGE
    - NO_COMPRESSION
    - CACHE_MISS
  manual_confirm:
    - LARGE_JS_BUNDLE
  suggest_only:
    - LONG_MAIN_THREAD_TASK

decision:
  jev: true
  thresholds:
    min_gain: 5
    max_regression: 2
    max_new_errors: 0
    apply_score: 30
    confirm_score: 10

report:
  format: [markdown, json, html]
  comment_mr: false
  auto_pr: false

collect:
  timeoutMs: 120000
  runs: 1

llm:
  provider: none

memory:
  driver: sqlite
  url: .perfpilot/memory.db
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'demo-shop',
    private: true,
    version: '0.1.0',
    scripts: {
      // 真实存在的检查脚本，让 verifier 的四项检查真的能跑
      test: 'node -e "process.exit(0)"',
      typecheck: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
    },
    dependencies: { react: '^18.3.1', lodash: '^4.17.21' },
    devDependencies: { vite: '^5.4.11' },
  },
  null,
  2,
)}\n`;

/** web-vitals 上报（真实页面里由前端 SDK 写出） */
const VITALS = {
  url: 'https://shop.example.com/',
  metrics: { LCP: { value: 3100 }, CLS: { value: 0.18 }, INP: { value: 260 } },
};

/**
 * HAR：一个未压缩的大脚本 + 一张 1.2MB 的图 + 一个没有 font-display 的字体。
 *
 * 三种瓶颈各有来源：没有 `content-encoding` → NO_COMPRESSION；
 * 图片 1.2MB 且没有缓存头 → UNCOMPRESSED_IMAGE + CACHE_MISS；
 * 字体没有 `font-display` → WEBFONT_BLOCKING。
 */
const HAR = {
  log: {
    version: '1.2',
    creator: { name: 'perfpilot-demo', version: '1.0.0' },
    entries: [
      {
        startedDateTime: '2026-01-17T14:25:30.000Z',
        time: 180,
        request: { method: 'GET', url: 'https://shop.example.com/' },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'text/html' }],
          content: { size: 4_200, mimeType: 'text/html' },
          _transferSize: 4_600,
        },
        _resourceType: 'document',
      },
      {
        startedDateTime: '2026-01-17T14:25:30.200Z',
        time: 420,
        request: { method: 'GET', url: 'https://shop.example.com/dist/assets/index.js' },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'application/javascript' }],
          content: { size: sizes.js, mimeType: 'application/javascript' },
          _transferSize: sizes.js,
        },
        _resourceType: 'script',
        _initiator: { type: 'parser' },
      },
      {
        startedDateTime: '2026-01-17T14:25:30.300Z',
        time: 140,
        request: { method: 'GET', url: 'https://shop.example.com/dist/assets/index.css' },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'text/css' }],
          content: { size: sizes.css, mimeType: 'text/css' },
          _transferSize: sizes.css,
        },
        _resourceType: 'stylesheet',
        _initiator: { type: 'parser' },
      },
      {
        startedDateTime: '2026-01-17T14:25:30.450Z',
        time: 980,
        request: { method: 'GET', url: 'https://shop.example.com/dist/assets/hero.jpg' },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'image/jpeg' }],
          content: { size: 1_180_000, mimeType: 'image/jpeg' },
          _transferSize: 1_184_000,
        },
        _resourceType: 'image',
        _initiator: { type: 'parser' },
      },
      {
        startedDateTime: '2026-01-17T14:25:30.600Z',
        time: 260,
        request: { method: 'GET', url: 'https://shop.example.com/dist/assets/inter.woff2' },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'font/woff2' }],
          content: { size: 180_000, mimeType: 'font/woff2' },
          _transferSize: 180_000,
        },
        _resourceType: 'font',
      },
    ],
  },
};

/** 一个 480ms 的长任务，罪魁帧落在 index.js 第 142 行的 renderList */
const TRACE = {
  traceEvents: [
    { name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: 1_000_000, dur: 480_000, pid: 1, tid: 1, args: {} },
    {
      name: 'FunctionCall',
      cat: 'devtools.timeline',
      ph: 'X',
      ts: 1_010_000,
      dur: 450_000,
      pid: 1,
      tid: 1,
      args: {
        data: {
          functionName: 'renderList',
          url: 'https://shop.example.com/dist/assets/index.js',
          lineNumber: 141,
          columnNumber: 10,
        },
      },
    },
  ],
};

async function writeImage(target) {
  /**
   * 用 sharp 生成一张**有真实压缩空间**的大图：噪声 + 高质量 JPEG。
   *
   * sharp 是 `@yuki-byte18/adapters` 的依赖，不在本脚本的解析范围里，
   * 因此以那个包的 package.json 为基准 require 它 —— 比自己拼
   * `node_modules/.pnpm/sharp@<版本>_<hash>/...` 稳（版本一变路径就废）。
   */
  const require = createRequire(join(root, 'packages/adapters/package.json'));
  const sharp = require('sharp');

  const { imageWidth: w, imageHeight: h } = sizes;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) % 256;

  const buffer = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();

  writeFileSync(target, buffer);
  return buffer.byteLength;
}

async function main() {
  rmSync(demo, { recursive: true, force: true });
  mkdirSync(join(demo, 'dist/assets'), { recursive: true });
  mkdirSync(join(demo, '.perfpilot'), { recursive: true });
  mkdirSync(join(demo, 'src'), { recursive: true });

  writeFileSync(join(demo, '.perfpilot.yml'), CONFIG, 'utf8');
  writeFileSync(join(demo, 'package.json'), PACKAGE_JSON, 'utf8');
  writeFileSync(
    join(demo, '.gitignore'),
    // `.perfpilot/` 必须被忽略：否则第一次运行就把工作区弄脏，
    // 而"工作区不干净"的保护会永久拦住所有自动改动。
    //
    // `dist/` **刻意不忽略**：被忽略的文件提交不了也回滚不了，
    // 而这个演示要看的就是"保留"那一步。
    ['node_modules/', '.perfpilot/', '*.log'].join('\n') + '\n',
    'utf8',
  );
  writeFileSync(join(demo, 'src/App.tsx'), 'export const App = () => null;\n', 'utf8');

  writeFileSync(join(demo, 'dist/assets/index.js'), jsSource(sizes.js), 'utf8');
  writeFileSync(join(demo, 'dist/assets/index.css'), cssSource(sizes.css), 'utf8');
  const imageBytes = await writeImage(join(demo, 'dist/assets/hero.jpg'));

  writeFileSync(join(demo, '.perfpilot/vitals.json'), `${JSON.stringify(VITALS, null, 2)}\n`, 'utf8');
  writeFileSync(join(demo, '.perfpilot/network.har'), `${JSON.stringify(HAR, null, 2)}\n`, 'utf8');
  writeFileSync(join(demo, '.perfpilot/trace.json'), `${JSON.stringify(TRACE, null, 2)}\n`, 'utf8');

  const git = (args) => execFileSync('git', args, { cwd: demo, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'demo@local']);
  git(['config', 'user.name', 'Demo']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'demo: 初始状态（1.2MB 的图 + 未压缩的 512KB JS）']);

  const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
  process.stdout.write(
    `演示项目已建好：${demo}\n\n` +
      `   dist/assets/index.js   ${kb(sizes.js)}（未压缩）\n` +
      `   dist/assets/index.css  ${kb(sizes.css)}（未压缩）\n` +
      `   dist/assets/hero.jpg   ${kb(imageBytes)}（可压缩）\n` +
      '   .perfpilot/vitals.json   LCP 3100 / CLS 0.18 / INP 260\n' +
      '   .perfpilot/network.har   5 个请求，无压缩、无缓存头、字体缺 font-display\n' +
      '   .perfpilot/trace.json    一个 480ms 长任务（renderList）\n' +
      '   已 git init 并提交\n\n' +
      `   试：cd .demo && node ${join(root, 'packages/cli/dist/index.js')} diagnose\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`演示项目创建失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
