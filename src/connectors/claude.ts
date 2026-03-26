import { readdirSync, readFileSync } from 'fs';
import { join, extname, basename } from 'path';
import { v4 as uuid } from 'uuid';
import type { Database as SqlJsDatabase } from 'sql.js';
import { insertKnowledge, getConfig, saveDb, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

/**
 * Import Claude.ai conversation exports.
 *
 * Accepts:
 * 1. A directory of markdown files (each is a conversation)
 * 2. A JSON export from Claude.ai (conversations.json from data export)
 */
export async function importClaudeConversations(
  db: SqlJsDatabase,
  path: string,
  options: { project?: string } = {}
): Promise<{ conversations: number; items: number }> {
  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  const stats = { conversations: 0, items: 0 };

  // Check if it's a JSON file (Claude data export) or directory of markdown
  if (path.endsWith('.json')) {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const conversations = Array.isArray(data) ? data : data.conversations || [];

    for (const convo of conversations) {
      try {
        const messages = convo.chat_messages || convo.messages || [];
        if (messages.length < 2) continue;

        // Build conversation text
        const text = messages
          .map((m: any) => `${m.sender || m.role}: ${m.text || m.content || ''}`)
          .join('\n\n')
          .slice(0, 8000);

        const extracted = await extractIntelligence(text, apiKey);
        const embText = `${extracted.title}\n${extracted.summary}`;
        const embedding = await generateEmbedding(embText, apiKey);

        const item: KnowledgeItem = {
          id: uuid(),
          title: extracted.title || convo.name || convo.title || 'Claude conversation',
          summary: extracted.summary,
          source: 'claude',
          source_ref: `claude:${convo.uuid || convo.id || uuid()}`,
          source_date: convo.created_at || convo.updated_at || new Date().toISOString(),
          contacts: extracted.contacts,
          organizations: extracted.organizations,
          decisions: extracted.decisions,
          commitments: extracted.commitments,
          action_items: extracted.action_items,
          tags: [...extracted.tags, 'claude-conversation'],
          project: options.project || extracted.project,
          importance: extracted.importance,
          embedding,
        };

        insertKnowledge(db, item);
        stats.items++;
        stats.conversations++;

        await new Promise(r => setTimeout(r, 200));
      } catch {
        continue;
      }
    }
  } else {
    // Directory of markdown files
    const files = readdirSync(path)
      .filter(f => extname(f) === '.md' || extname(f) === '.txt')
      .map(f => join(path, f));

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.length < 50) continue;

        // Parse frontmatter if present
        let metadata: Record<string, any> = {};
        let bodyContent = content;

        if (content.startsWith('---')) {
          const endIdx = content.indexOf('---', 3);
          if (endIdx > 0) {
            const frontmatter = content.slice(3, endIdx).trim();
            bodyContent = content.slice(endIdx + 3).trim();
            for (const line of frontmatter.split('\n')) {
              const colonIdx = line.indexOf(':');
              if (colonIdx > 0) {
                metadata[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
              }
            }
          }
        }

        const extracted = await extractIntelligence(bodyContent.slice(0, 6000), apiKey);
        const embText = `${extracted.title}\n${extracted.summary}`;
        const embedding = await generateEmbedding(embText, apiKey);

        const item: KnowledgeItem = {
          id: uuid(),
          title: metadata.title || extracted.title || basename(filePath, extname(filePath)),
          summary: metadata.summary || extracted.summary,
          source: 'claude',
          source_ref: filePath,
          source_date: metadata.date || new Date().toISOString(),
          contacts: extracted.contacts,
          organizations: extracted.organizations,
          decisions: extracted.decisions,
          commitments: extracted.commitments,
          action_items: extracted.action_items,
          tags: [...extracted.tags, 'claude-conversation', ...(metadata.label ? [metadata.label] : [])],
          project: options.project || metadata.project || extracted.project,
          importance: extracted.importance,
          embedding,
          artifact_path: filePath,
        };

        insertKnowledge(db, item);
        stats.items++;
        stats.conversations++;

        await new Promise(r => setTimeout(r, 200));
      } catch {
        continue;
      }
    }
  }

  db.run(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('claude', datetime('now'), ?, 'idle', datetime('now'))`,
    [stats.items]
  );
  saveDb();

  return stats;
}
