/**
 * 构建产物扫描的 payload 类型现在定义在 `@yuki-byte18/shared`。
 *
 * 原因：诊断规则（core）要读这份 payload，而硬约束 4 禁止 core import 具体 adapter。
 * 类型放在 shared 才是唯一能让两侧都合法引用的位置。
 * 这里只做转出，避免出现第二份定义。
 */
export {
  BundleScanPayloadSchema,
  BundleFileSchema,
  BundleModuleSchema,
  PackageJsonSnapshotSchema,
} from '@yuki-byte18/shared';
export type { BundleScanPayload, BundleFile, BundleModule, PackageJsonSnapshot } from '@yuki-byte18/shared';
