import { google } from 'googleapis';
import type Database from 'better-sqlite3';
import { getConfig } from './db.js';

// ============================================================
// Source Retrieval — "Go back to the shelf"
//
// The knowledge base is an INDEX (card catalog).
// When the dream pipeline needs deep understanding, it uses
// this module to retrieve the ACTUAL source content via APIs.
//
// The index tells us WHAT to look at (source_ref).
// This module retrieves the actual content.
// ============================================================

export interface RetrievedSource {
  source: string;
  source_ref: string;
  content: string;          // the actual full content
  content_type: 'email_thread' | 'meeting_transcript' | 'conversation' | 'unknown';
  retrieved_at: string;
}

// ── Gmail: Retrieve actual email thread content ──────────────

async function getGmailClient(db: Database.Database) {
  const tokens = getConfig(db, 'gmail_tokens');
  if (!tokens) return null;

  const oauth2 = new google.auth.OAuth2(
    getConfig(db, 'google_client_id'),
    getConfig(db, 'google_client_secret'),
    'http://localhost:9876/callback'
  );
  oauth2.setCredentials(typeof tokens === 'string' ? JSON.parse(tokens) : tokens);
  return google.gmail({ version: 'v1', auth: oauth2 });
}

export async function retrieveGmailThread(db: Database.Database, threadId: string): Promise<string | null> {
  const gmail = await getGmailClient(db);
  if (!gmail) return null;

  try {
    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = thread.data.messages || [];
    const parts: string[] = [];

    for (const msg of messages) {
      const headers = msg.payload?.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';

      // Extract body text
      let body = '';
      if (msg.payload?.body?.data) {
        body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
      } else if (msg.payload?.parts) {
        for (const part of msg.payload.parts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
            break;
          }
        }
        // Fallback to HTML if no plain text
        if (!body) {
          for (const part of msg.payload.parts) {
            if (part.mimeType === 'text/html' && part.body?.data) {
              const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
              body = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              break;
            }
          }
        }
      }

      parts.push(`--- ${from} (${date}) ---\nSubject: ${subject}\n${body.slice(0, 2000)}`);
    }

    return parts.join('\n\n');
  } catch (err: any) {
    console.log(`  Warning: Could not retrieve Gmail thread ${threadId}: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// ── Fireflies: Retrieve full meeting transcript ──────────────

const FIREFLIES_API = 'https://api.fireflies.ai/graphql';

export async function retrieveFirefliesTranscript(db: Database.Database, meetingId: string): Promise<string | null> {
  const apiKey = getConfig(db, 'fireflies_api_key');
  if (!apiKey) return null;

  try {
    const response = await fetch(FIREFLIES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: `query { transcript(id: "${meetingId}") {
          title
          sentences { text speaker_name start_time }
          summary { overview action_items shorthand_bullet }
        }}`,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const transcript = data.data?.transcript;
    if (!transcript) return null;

    const parts: string[] = [];
    parts.push(`Meeting: ${transcript.title}`);

    if (transcript.summary?.overview) {
      parts.push(`\nOverview: ${transcript.summary.overview}`);
    }

    // Full transcript with speaker attribution
    if (transcript.sentences?.length) {
      parts.push('\n--- Full Transcript ---');
      let currentSpeaker = '';
      for (const s of transcript.sentences) {
        if (s.speaker_name !== currentSpeaker) {
          currentSpeaker = s.speaker_name;
          parts.push(`\n[${currentSpeaker}]`);
        }
        parts.push(s.text);
      }
    }

    if (transcript.summary?.action_items?.length) {
      parts.push('\n--- Action Items ---');
      const items = Array.isArray(transcript.summary.action_items)
        ? transcript.summary.action_items
        : [transcript.summary.action_items];
      for (const item of items) parts.push(`- ${item}`);
    }

    return parts.join('\n').slice(0, 12000); // Cap at 12K chars
  } catch (err: any) {
    console.log(`  Warning: Could not retrieve Fireflies transcript ${meetingId}: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

// ── Master retrieval: Given a knowledge item, get the full source ──

export async function retrieveSourceContent(
  db: Database.Database,
  item: { source: string; source_ref: string; metadata?: any }
): Promise<RetrievedSource | null> {
  const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : (item.metadata || {});

  if (item.source === 'gmail' || item.source === 'gmail-sent') {
    // source_ref format: "thread:{threadId}"
    const threadId = item.source_ref.replace('thread:', '');
    if (!threadId) return null;

    const content = await retrieveGmailThread(db, threadId);
    if (!content) return null;

    return {
      source: item.source,
      source_ref: item.source_ref,
      content,
      content_type: 'email_thread',
      retrieved_at: new Date().toISOString(),
    };
  }

  if (item.source === 'fireflies') {
    // source_ref format: "fireflies:{meetingId}"
    const meetingId = item.source_ref.replace('fireflies:', '');
    if (!meetingId) return null;

    const content = await retrieveFirefliesTranscript(db, meetingId);
    if (!content) return null;

    return {
      source: item.source,
      source_ref: item.source_ref,
      content,
      content_type: 'meeting_transcript',
      retrieved_at: new Date().toISOString(),
    };
  }

  // For other sources (claude, otter, cowork), use the stored summary as fallback
  // These can be extended with their respective APIs later
  return null;
}

// ── Selective retrieval for dream pipeline ────────────────────
// Given a list of knowledge items for an entity, retrieve full
// source content for the N most important/recent items.

export async function retrieveDeepContext(
  db: Database.Database,
  items: any[],
  maxRetrievals: number = 3
): Promise<string> {
  // Prioritize: most recent first, prefer gmail and fireflies (richest sources)
  const candidates = items
    .filter(i => i.source === 'gmail' || i.source === 'fireflies' || i.source === 'gmail-sent')
    .sort((a, b) => {
      // Fireflies first (meeting transcripts are richest), then by date
      if (a.source === 'fireflies' && b.source !== 'fireflies') return -1;
      if (b.source === 'fireflies' && a.source !== 'fireflies') return 1;
      return (b.source_date || '').localeCompare(a.source_date || '');
    })
    .slice(0, maxRetrievals);

  const retrieved: string[] = [];

  for (const item of candidates) {
    const result = await retrieveSourceContent(db, item);
    if (result) {
      retrieved.push(`\n=== FULL SOURCE: ${item.title} (${result.content_type}) ===\n${result.content}`);
    }
  }

  return retrieved.join('\n');
}
