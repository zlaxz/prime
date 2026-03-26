import { getDefaultProvider, type LLMProvider } from './providers.js';

// Cache business context to avoid reading DB every call
let _cachedBusinessContext: string | null = null;
let _contextLoadedAt = 0;

// Cache the provider instance
let _cachedProvider: LLMProvider | null = null;

export function setBusinessContext(ctx: string) {
  _cachedBusinessContext = ctx;
  _contextLoadedAt = Date.now();
}

export async function loadBusinessContext(): Promise<string> {
  // Cache for 5 minutes
  if (_cachedBusinessContext && Date.now() - _contextLoadedAt < 300000) {
    return _cachedBusinessContext;
  }

  try {
    // Dynamic import to avoid circular dependency
    const { getDb, getConfig } = await import('../db.js');
    const db = await getDb();
    const ctx = getConfig(db, 'business_context');
    if (ctx) {
      _cachedBusinessContext = typeof ctx === 'string' ? ctx : JSON.stringify(ctx);
      _contextLoadedAt = Date.now();
      return _cachedBusinessContext;
    }
  } catch {}

  return '';
}

export interface ExtractionResult {
  title: string;
  summary: string;
  contacts: string[];
  organizations: string[];
  decisions: string[];
  commitments: string[];
  action_items: string[];
  tags: string[];
  project: string | null;
  importance: 'low' | 'normal' | 'high' | 'critical';
}

const EXTRACTION_PROMPT = `Analyze this content and extract structured intelligence. Return JSON only.

{
  "title": "Brief descriptive title (max 80 chars)",
  "summary": "2-3 sentence summary of what this is about",
  "contacts": ["Full Name of each person mentioned"],
  "organizations": ["Company/org names mentioned"],
  "decisions": ["Any decisions that were made"],
  "commitments": ["Any promises or commitments made by the user"],
  "action_items": ["Specific things that need to be done"],
  "tags": ["relevant", "topic", "tags"],
  "project": "Project name if identifiable, or null",
  "importance": "low|normal|high|critical based on business impact"
}

Rules:
- contacts: Full names only, not email addresses
- organizations: Company names, not domains
- commitments: Only things the USER committed to doing, not others
- action_items: Specific, actionable tasks
- importance: critical = revenue/legal impact, high = relationship/deadline, normal = routine, low = FYI
- project: Only set if clearly related to a known initiative
- Be concise. Summaries under 3 sentences. Title under 80 chars.`;

async function getProvider(apiKey?: string): Promise<LLMProvider> {
  if (_cachedProvider) return _cachedProvider;
  _cachedProvider = await getDefaultProvider(apiKey);
  return _cachedProvider;
}

export async function extractIntelligence(
  content: string,
  apiKey?: string,
  _model?: string,
  businessContext?: string
): Promise<ExtractionResult> {
  const provider = await getProvider(apiKey);

  // Auto-load business context if not passed
  const ctx = businessContext || await loadBusinessContext();
  let systemPrompt = EXTRACTION_PROMPT;
  if (ctx) {
    systemPrompt += `\n\nBUSINESS CONTEXT (use this to correctly assign projects and importance):\n${ctx}`;
  }

  const response = await provider.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: content.slice(0, 6000) },
    ],
    { temperature: 0.1, max_tokens: 1000, json: true }
  );

  try {
    return JSON.parse(response) as ExtractionResult;
  } catch {
    return {
      title: content.slice(0, 80),
      summary: content.slice(0, 200),
      contacts: [],
      organizations: [],
      decisions: [],
      commitments: [],
      action_items: [],
      tags: [],
      project: null,
      importance: 'normal',
    };
  }
}

export async function extractBatch(
  items: { id: string; content: string }[],
  apiKey?: string,
  _model?: string
): Promise<Map<string, ExtractionResult>> {
  const results = new Map<string, ExtractionResult>();

  // Process in parallel, 3 at a time (claude CLI has its own concurrency limits)
  const concurrency = 3;
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const extractions = await Promise.all(
      batch.map(async (item) => {
        try {
          const result = await extractIntelligence(item.content, apiKey);
          return { id: item.id, result };
        } catch {
          return {
            id: item.id,
            result: {
              title: item.content.slice(0, 80),
              summary: item.content.slice(0, 200),
              contacts: [],
              organizations: [],
              decisions: [],
              commitments: [],
              action_items: [],
              tags: [],
              project: null,
              importance: 'normal' as const,
            },
          };
        }
      })
    );

    for (const { id, result } of extractions) {
      results.set(id, result);
    }
  }

  return results;
}
