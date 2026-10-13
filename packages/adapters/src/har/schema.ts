import { z } from 'zod';

/**
 * HAR 1.2 的容错 schema。
 *
 * HAR 是"事实标准"而非严格规范：Chrome、Firefox、Charles、各种抓包工具产出的字段
 * 集合并不一致（`_transferSize` / `_resourceType` / `_initiator` 都是 Chrome 扩展字段）。
 * 因此这里全部设为可选，由 runner 侧逐个兜底推断，缺字段不报错。
 */

const HeaderSchema = z
  .object({ name: z.string(), value: z.string() })
  .passthrough();

const TimingsSchema = z
  .object({
    blocked: z.number().optional(),
    dns: z.number().optional(),
    connect: z.number().optional(),
    send: z.number().optional(),
    wait: z.number().optional(),
    receive: z.number().optional(),
    ssl: z.number().optional(),
  })
  .passthrough();

const ContentSchema = z
  .object({
    size: z.number().optional(),
    mimeType: z.string().optional(),
    compression: z.number().optional(),
    /** ⚠️ 可能内嵌整个响应体（base64）。**必须在 runner 里丢掉** */
    text: z.string().optional(),
    encoding: z.string().optional(),
  })
  .passthrough();

const RequestSchema = z
  .object({
    method: z.string().optional(),
    url: z.string().optional(),
    headers: z.array(HeaderSchema).optional(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    status: z.number().optional(),
    statusText: z.string().optional(),
    headers: z.array(HeaderSchema).optional(),
    content: ContentSchema.optional(),
    bodySize: z.number().optional(),
    /** Chrome 扩展：网络传输字节 */
    _transferSize: z.number().optional(),
  })
  .passthrough();

const InitiatorSchema = z
  .object({ type: z.string().optional() })
  .passthrough();

export const HarEntrySchema = z
  .object({
    startedDateTime: z.string().optional(),
    time: z.number().optional(),
    /** 相对页面开始的偏移（Chrome 扩展） */
    _startedDateTime: z.string().optional(),
    request: RequestSchema.optional(),
    response: ResponseSchema.optional(),
    timings: TimingsSchema.optional(),
    cache: z.record(z.string(), z.unknown()).optional(),
    /** Chrome 扩展：资源类型 */
    _resourceType: z.string().optional(),
    /** Chrome 扩展：优先级 */
    _priority: z.string().optional(),
    /** Chrome 扩展：发起者 */
    _initiator: InitiatorSchema.optional(),
    serverIPAddress: z.string().optional(),
  })
  .passthrough();

export const HarSchema = z
  .object({
    log: z
      .object({
        version: z.string().optional(),
        creator: z.record(z.string(), z.unknown()).optional(),
        pages: z
          .array(
            z
              .object({
                id: z.string().optional(),
                title: z.string().optional(),
                startedDateTime: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
        entries: z.array(HarEntrySchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();

export type HarFile = z.infer<typeof HarSchema>;
export type HarRawEntry = z.infer<typeof HarEntrySchema>;
