import OpenAI from 'openai';

// ============================================================
// Embedding providers: OpenAI (cloud) or Ollama (local, free)
// ============================================================

export type EmbeddingProvider = 'openai' | 'ollama';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiKey?: string;           // OpenAI API key (not needed for Ollama)
  model?: string;            // Override model name
  ollamaUrl?: string;        // Ollama base URL (default: http://localhost:11434)
  dimensions?: number;       // Set after first embedding call
}

let _openaiClient: OpenAI | null = null;

function getOpenAIClient(apiKey: string): OpenAI {
  if (!_openaiClient) {
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

// ── Ollama embeddings ─────────────────────────────────────────

async function ollamaEmbed(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  const url = config.ollamaUrl || 'http://localhost:11434';
  const model = config.model || 'nomic-embed-text';

  const response = await fetch(`${url}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding error: ${response.status} ${await response.text()}`);
  }

  const data: any = await response.json();
  return data.embeddings;
}

// ── OpenAI embeddings ─────────────────────────────────────────

async function openaiEmbed(texts: string[], apiKey: string, model?: string): Promise<number[][]> {
  const client = getOpenAIClient(apiKey);
  const results: number[][] = [];

  // Batch up to 100 at a time
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const response = await client.embeddings.create({
      model: model || 'text-embedding-3-small',
      input: batch,
    });
    results.push(...response.data.map(d => d.embedding));
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Generate a single embedding. Falls back to Ollama if no OpenAI key.
 *
 * For backward compatibility, accepts (text, apiKey) signature.
 * New code should use generateEmbeddingWithConfig().
 */
export async function generateEmbedding(text: string, apiKeyOrConfig: string | EmbeddingConfig): Promise<number[]> {
  const input = text.slice(0, 8000);

  if (typeof apiKeyOrConfig === 'string') {
    // Legacy signature: (text, apiKey) — use OpenAI
    const apiKey = apiKeyOrConfig;
    if (!apiKey || apiKey === 'ollama' || apiKey === 'local') {
      // User passed a sentinel value meaning "use ollama"
      const result = await ollamaEmbed([input], { provider: 'ollama' });
      return result[0];
    }
    const result = await openaiEmbed([input], apiKey);
    return result[0];
  }

  // New config-based signature
  const config = apiKeyOrConfig;
  if (config.provider === 'ollama') {
    const result = await ollamaEmbed([input], config);
    return result[0];
  } else {
    if (!config.apiKey) throw new Error('OpenAI API key required for OpenAI embeddings');
    const result = await openaiEmbed([input], config.apiKey, config.model);
    return result[0];
  }
}

/**
 * Generate embeddings for multiple texts in batch.
 *
 * For backward compatibility, accepts (texts, apiKey) signature.
 */
export async function generateEmbeddings(texts: string[], apiKeyOrConfig: string | EmbeddingConfig): Promise<number[][]> {
  const inputs = texts.map(t => t.slice(0, 8000));

  if (typeof apiKeyOrConfig === 'string') {
    const apiKey = apiKeyOrConfig;
    if (!apiKey || apiKey === 'ollama' || apiKey === 'local') {
      return ollamaEmbed(inputs, { provider: 'ollama' });
    }
    return openaiEmbed(inputs, apiKey);
  }

  const config = apiKeyOrConfig;
  if (config.provider === 'ollama') {
    return ollamaEmbed(inputs, config);
  } else {
    if (!config.apiKey) throw new Error('OpenAI API key required for OpenAI embeddings');
    return openaiEmbed(inputs, config.apiKey, config.model);
  }
}

