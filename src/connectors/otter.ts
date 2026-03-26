import { v4 as uuid } from 'uuid';
import { readFileSync } from 'fs';
import type Database from 'better-sqlite3';
import { insertKnowledge, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';
import { extractIntelligence } from '../ai/extract.js';

/**
 * Process an Otter.ai meeting transcript.
 * Can be called from:
 * 1. Webhook (POST /api/webhooks/otter) — Zapier sends payload
 * 2. File import — local transcript file
 * 3. Manual — paste transcript text
 */
export async function processOtterMeeting(
  db: Database.Database,
  meeting: {
    title: string;
    transcript?: string;
    summary?: string;
    participants?: string[];
    meeting_date?: string;
    duration_minutes?: number;
    source_url?: string;
    action_items?: string[];
  }
): Promise<{ id: string; title: string; commitments: string[] }> {
  const apiKey = getConfig(db, 'openai_api_key');
  if (!apiKey) throw new Error('No API key. Run: prime init');

  const content = [
    `Meeting: ${meeting.title}`,
    meeting.meeting_date ? `Date: ${meeting.meeting_date}` : '',
    meeting.participants?.length ? `Participants: ${meeting.participants.join(', ')}` : '',
    meeting.duration_minutes ? `Duration: ${meeting.duration_minutes} minutes` : '',
    meeting.summary ? `\nSummary:\n${meeting.summary}` : '',
    meeting.transcript ? `\nTranscript:\n${meeting.transcript.slice(0, 6000)}` : '',
    meeting.action_items?.length ? `\nAction Items:\n${meeting.action_items.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const extracted = await extractIntelligence(content, apiKey);
  const embText = `${extracted.title}\n${extracted.summary}`;
  const embedding = await generateEmbedding(embText, apiKey);

  const item: KnowledgeItem = {
    id: uuid(),
    title: extracted.title || `Meeting: ${meeting.title}`,
    summary: extracted.summary,
    source: 'otter',
    source_ref: meeting.source_url || `otter:${Date.now()}`,
    source_date: meeting.meeting_date || new Date().toISOString(),
    contacts: [...(meeting.participants || []), ...extracted.contacts].filter((v, i, a) => a.indexOf(v) === i),
    organizations: extracted.organizations,
    decisions: extracted.decisions,
    commitments: [...extracted.commitments, ...(meeting.action_items || [])],
    action_items: extracted.action_items,
    tags: [...extracted.tags, 'meeting', 'otter'],
    project: extracted.project,
    importance: extracted.importance,
    embedding,
    metadata: {
      duration_minutes: meeting.duration_minutes,
      participant_count: meeting.participants?.length || 0,
      has_transcript: !!meeting.transcript,
      otter_url: meeting.source_url,
    },
  };

  insertKnowledge(db, item);

  return {
    id: item.id,
    title: item.title,
    commitments: [...extracted.commitments, ...(meeting.action_items || [])],
  };
}

export async function importOtterFile(
  db: Database.Database,
  filePath: string,
  options: { project?: string } = {}
): Promise<{ id: string; title: string }> {
  const content = readFileSync(filePath, 'utf-8');

  // Try to detect if it's a structured export (JSON) or plain transcript
  let meeting: any;

  try {
    meeting = JSON.parse(content);
  } catch {
    // Plain text transcript
    meeting = {
      title: filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Otter Meeting',
      transcript: content,
    };
  }

  if (options.project) {
    // Will be picked up by extraction
  }

  const result = await processOtterMeeting(db, meeting);
  return result;
}
