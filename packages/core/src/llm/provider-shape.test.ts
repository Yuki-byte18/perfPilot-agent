import { describe, expect, it } from 'vitest';
import { pickModelFactory } from './index.js';

/**
 * provider 的"模型工厂"到底长什么样（回归护栏）。
 *
 * ## 为什么单开一个文件
 *
 * `llm.test.ts` 里的用例全部注入假的 `loadSdk`，因此**测不到真实 SDK 的形状** ——
 * 而这里恰好出过一个会静默花错钱的 bug：代码取 `client['openai']`，而
 * `@ai-sdk/openai` 建出来的 client 上**没有**这个属性（它本身可调用）。
 * 于是 `??` 回退到默认 provider：丢掉 apiKey 与 base_url ——
 * 轻则报 "OpenAI API key is missing"（把用户没配过的东西当成原因），
 * 重则请求真的发去 api.openai.com，账单来自 OpenAI。
 *
 * 这一组**不联网**：只检查"挑工厂"的判定，以及真实 SDK 是否仍符合这个形状。
 */

describe('pickModelFactory', () => {
  it('client 本身可调用时用它 —— 这才是 @ai-sdk/openai 的真实形状', () => {
    const client = (name: string): { modelId: string } => ({ modelId: name });
    expect(pickModelFactory(client)).toBe(client);
  });

  it('次选 .chat / .languageModel', () => {
    const chat = (name: string): { modelId: string } => ({ modelId: name });
    expect(pickModelFactory({ chat })).toBe(chat);

    const languageModel = (name: string): { modelId: string } => ({ modelId: name });
    expect(pickModelFactory({ languageModel })).toBe(languageModel);
  });

  it('**没有** `.openai` 属性不等于"没有模型工厂"（那个 bug 的回归点）', () => {
    const client = (name: string): { modelId: string } => ({ modelId: name });
    expect('openai' in client).toBe(false);
    expect(typeof pickModelFactory(client)).toBe('function');
  });

  it('认不出来返回 null，由调用方报"版本不兼容"（而不是静默换一个 provider）', () => {
    expect(pickModelFactory({})).toBeNull();
    expect(pickModelFactory(null)).toBeNull();
    expect(pickModelFactory(undefined)).toBeNull();
    expect(pickModelFactory('openai')).toBeNull();
  });

  it('真实 @ai-sdk/openai 仍符合上面这个形状（不联网）', async () => {
    const mod = (await import('@ai-sdk/openai')) as { createOpenAI?: (options: unknown) => unknown };
    expect(typeof mod.createOpenAI).toBe('function');

    const createOpenAI = mod.createOpenAI;
    // `expect` 不会让 TS 收窄类型，所以再显式判一次
    if (typeof createOpenAI !== 'function') return;

    const client = createOpenAI({ apiKey: 'test-key', baseURL: 'https://example.invalid' });
    const factory = pickModelFactory(client);

    expect(typeof factory).toBe('function');
    expect(factory?.('deepseek-chat')).toMatchObject({ modelId: 'deepseek-chat' });
  });
});
