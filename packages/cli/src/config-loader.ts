import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ConfigError,
  PerfPilotConfigSchema,
  parseExternal,
  type PerfPilotConfig,
} from '@yuki-byte18/shared';

export const DEFAULT_CONFIG_FILES = ['.perfpilot.yml', '.perfpilot.yaml'] as const;

export interface LoadedConfig {
  config: PerfPilotConfig;
  /** 配置文件的绝对路径 */
  path: string;
  /** 项目根目录（配置里 `project.root` 相对配置文件解析） */
  root: string;
}

export interface LoadConfigOptions {
  cwd: string;
  /** 显式指定的配置文件路径 */
  configPath?: string;
}

/**
 * 加载并校验 `.perfpilot.yml`（硬约束 11）。
 *
 * 两条刻意设计：
 * 1. **配置文件解析失败不猜默认值**。YAML 语法错误、字段拼错、路径不存在，
 *    一律以 `CONFIG_NOT_FOUND` / `CONFIG_INVALID` 退出（退出码 2）。
 *    性能门禁跑在一份「部分生效」的配置上，比直接失败危险得多。
 * 2. **`project.root` 相对配置文件解析**，不是相对 cwd。CI 里从仓库根调用
 *    和从子目录调用必须得到同一个 root，否则 dist / vitals 路径会飘。
 */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const path = await resolveConfigPath(options);
  const raw = await readConfigFile(path);
  const parsed = parseYamlSafe(raw, path);
  const config = parseExternal(PerfPilotConfigSchema, parsed, {
    what: `配置文件 ${path}`,
    code: 'CONFIG_INVALID',
  });

  const root = isAbsolute(config.project.root)
    ? config.project.root
    : resolve(dirname(path), config.project.root);

  return { config, path, root };
}

async function resolveConfigPath(options: LoadConfigOptions): Promise<string> {
  if (options.configPath !== undefined) {
    const explicit = isAbsolute(options.configPath)
      ? options.configPath
      : resolve(options.cwd, options.configPath);

    if (!(await fileExists(explicit))) {
      throw new ConfigError(`指定的配置文件不存在: ${explicit}`, { code: 'CONFIG_NOT_FOUND' });
    }
    return explicit;
  }

  for (const name of DEFAULT_CONFIG_FILES) {
    const candidate = join(options.cwd, name);
    if (await fileExists(candidate)) return candidate;
  }

  throw new ConfigError(
    `当前目录未找到配置文件（${DEFAULT_CONFIG_FILES.join(' 或 ')}）。可用 \`--config <path>\` 指定。`,
    { code: 'CONFIG_NOT_FOUND' },
  );
}

async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`配置文件不可读: ${path}`, {
      code: 'CONFIG_NOT_FOUND',
      cause: err,
    });
  }
}

function parseYamlSafe(raw: string, path: string): unknown {
  try {
    return dropNullValues(parseYaml(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`配置文件 YAML 语法错误 (${path}): ${message}`, {
      code: 'CONFIG_INVALID',
      cause: err,
    });
  }
}

/**
 * 把 YAML 里"只写了键、没写值"的字段从 `null` 还原成「没写」。
 *
 * YAML 的 `repo:` 解析结果是 `null`，而 zod 的 `.default()` **只对 `undefined` 生效**。
 * 于是 `.perfpilot.yml.example` 里那句「留空表示未接入 SCM」的承诺是假的：
 * 照做的人会拿到 `target.repo: Expected string, received null`，
 * 而报错信息完全没提示"你该写个空串"—— 这是最典型的一类"文档骗人"。
 *
 * 因此在校验之前把对象属性上的 `null` 摘掉，让默认值接管。
 * **只处理对象属性，不碰数组元素**：`routes: [/, null]` 里的 null 是写错了，
 * 该继续报错而不是被悄悄吃掉。
 */
function dropNullValues(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) continue;
    out[key] = dropNullValues(item);
  }
  return out;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
