import OpenAI from 'openai';

export interface LLMProvider {
  chat(messages: { role: string; content: string }[], options?: { temperature?: number; max_tokens?: number }): Promise<string>;
}

export function createProvider(config: { provider?: string; model?: string; apiKey?: string; baseUrl?: string }): LLMProvider {
  const provider = config.provider || 'openai';
  const apiKey = config.apiKey || '';

  if (provider === 'openai' || provider === 'deepseek' || provider === 'openrouter') {
    const baseUrl = config.baseUrl ||
      (provider === 'deepseek' ? 'https://api.deepseek.com' :
       provider === 'openrouter' ? 'https://openrouter.ai/api/v1' :
       undefined);

    const model = config.model ||
      (provider === 'deepseek' ? 'deepseek-chat' :
       provider === 'openrouter' ? 'deepseek/deepseek-v3.2' :
       'gpt-4o-mini');

    const client = new OpenAI({ apiKey, baseURL: baseUrl });

    return {
      async chat(messages, options = {}) {
        const response = await client.chat.completions.create({
          model,
          messages: messages as any,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.max_tokens ?? 2000,
        });
        return response.choices[0]?.message?.content || '';
      }
    };
  }

  if (provider === 'anthropic') {
    // Use OpenAI-compatible API via Anthropic's endpoint
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://api.anthropic.com/v1/',
      defaultHeaders: {
        'anthropic-version': '2023-06-01',
      },
    });

    const model = config.model || 'claude-haiku-4-5-20251001';

    return {
      async chat(messages, options = {}) {
        const response = await client.chat.completions.create({
          model,
          messages: messages as any,
          max_tokens: options.max_tokens ?? 2000,
        });
        return response.choices[0]?.message?.content || '';
      }
    };
  }

  throw new Error(`Unknown provider: ${provider}. Supported: openai, anthropic, deepseek, openrouter`);
}
