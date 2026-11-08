import { MockProvider } from './mock.js';
import { OpenAICompatProvider } from './openai-compat.js';

export function createProvider(cfg) {
  if (cfg.kind === 'mock') return new MockProvider();
  if (cfg.kind === 'openai-compatible') {
    return new OpenAICompatProvider({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      models: cfg.models,
      label: cfg.label
    });
  }
  throw new Error(`Невідомий тип провайдера: ${cfg.kind}`);
}
