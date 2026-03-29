import { google } from 'googleapis';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { insertKnowledge, setConfig, getConfig, type KnowledgeItem } from '../db.js';
import { generateEmbedding } from '../embedding.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'http://localhost:9876/callback';

/**
 * Connect Calendar — reuses Gmail OAuth tokens (calendar.readonly scope added to Gmail flow).
 * No separate OAuth dance needed.
 */
export async function connectCalendar(db: Database.Database): Promise<boolean> {
  const tokens = getConfig(db, 'gmail_tokens');
  if (!tokens) {
    console.log('  ✗ Gmail not connected. Calendar shares Gmail OAuth tokens.');
    console.log('    Run: recall connect gmail  (calendar scope is included automatically)');
    return false;
  }

  // Check if the existing token has calendar scope
  const scope = tokens.scope || '';
  if (!scope.includes('calendar')) {
    console.log('  ⚠ Gmail token missing calendar scope. Re-authenticate:');
    console.log('    Run: recall connect gmail  (now includes calendar.readonly scope)');
    return false;
  }

  // Mark calendar as connected using shared gmail tokens
  setConfig(db, 'calendar_tokens', tokens);
  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, status, updated_at) VALUES ('calendar', 'connected', datetime('now'))`
  ).run();

  console.log('  ✓ Calendar connected (sharing Gmail OAuth tokens)');
  return true;
}

export async function scanCalendar(
  db: Database.Database,
  options: { daysBack?: number; daysForward?: number } = {}
): Promise<{ events: number; items: number }> {
  const daysBack = options.daysBack || 7;
  const daysForward = options.daysForward || 7;

  // Use calendar_tokens or fall back to gmail_tokens (shared OAuth)
  const tokens = getConfig(db, 'calendar_tokens') || getConfig(db, 'gmail_tokens');
  const apiKey = getConfig(db, 'openai_api_key');
  if (!tokens) throw new Error('Calendar not connected. Run: recall connect gmail (includes calendar scope)');
  if (!apiKey) throw new Error('No API key. Run: recall init');

  const clientId = CLIENT_ID || getConfig(db, 'google_client_id') || '';
  const clientSecret = CLIENT_SECRET || getConfig(db, 'google_client_secret') || '';

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', (newTokens) => {
    // Update both token stores
    const current = getConfig(db, 'gmail_tokens');
    if (current) setConfig(db, 'gmail_tokens', { ...current, ...newTokens });
    setConfig(db, 'calendar_tokens', { ...current, ...newTokens });
  });

  // Force token refresh if expired
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    setConfig(db, 'calendar_tokens', credentials);
  } catch (refreshErr: any) {
    throw new Error(`Calendar token refresh failed: ${refreshErr.message}. Run: recall connect calendar`);
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const timeMin = new Date(Date.now() - daysBack * 86400000).toISOString();
  const timeMax = new Date(Date.now() + daysForward * 86400000).toISOString();

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 100,
  });

  const events = response.data.items || [];
  let items = 0;

  for (const event of events) {
    if (!event.summary) continue;

    const start = event.start?.dateTime || event.start?.date || '';
    const attendees = (event.attendees || []).map(a => a.displayName || a.email || '').filter(Boolean);
    const isUpcoming = new Date(start) > new Date();

    const content = [
      `Calendar event: ${event.summary}`,
      `When: ${start}`,
      `Location: ${event.location || 'N/A'}`,
      `Attendees: ${attendees.join(', ') || 'Just you'}`,
      event.description ? `Description: ${event.description.slice(0, 500)}` : '',
    ].filter(Boolean).join('\n');

    const embText = `${event.summary}\n${attendees.join(', ')}\n${event.description || ''}`;
    const embedding = await generateEmbedding(embText.slice(0, 4000), apiKey);

    const item: KnowledgeItem = {
      id: uuid(),
      title: event.summary,
      summary: `${isUpcoming ? 'Upcoming' : 'Past'} meeting: ${event.summary} on ${new Date(start).toLocaleDateString()} with ${attendees.length} attendees${attendees.length > 0 ? ` (${attendees.slice(0, 3).join(', ')})` : ''}`,
      source: 'calendar',
      source_ref: `event:${event.id}`,
      source_date: start,
      contacts: attendees,
      organizations: [],
      tags: [isUpcoming ? 'upcoming' : 'past', 'meeting'],
      project: null,
      importance: isUpcoming ? 'normal' : 'low',
      embedding,
      metadata: {
        event_id: event.id,
        location: event.location,
        html_link: event.htmlLink,
        is_upcoming: isUpcoming,
        organizer: event.organizer?.email || event.organizer?.displayName,
        attendee_details: (event.attendees || []).map(a => ({
          name: a.displayName || a.email,
          email: a.email,
          status: a.responseStatus, // accepted, declined, tentative, needsAction
          organizer: a.organizer || false,
        })),
        start_time: event.start?.dateTime,
        end_time: event.end?.dateTime,
        recurrence: event.recurrence,
      },
    };

    insertKnowledge(db, item);
    items++;

    await new Promise(r => setTimeout(r, 50));
  }

  db.prepare(
    `INSERT OR REPLACE INTO sync_state (source, last_sync_at, items_synced, status, updated_at)
     VALUES ('calendar', datetime('now'), ?, 'idle', datetime('now'))`
  ).run(items);

  return { events: events.length, items };
}
