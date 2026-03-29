import { getBulkProvider } from './providers.js';

export async function summarizeThreads(
  threads: { id: string; subject: string; from: string; lastFrom: string; lastDate: string; snippet: string; messageCount: number }[],
  apiKey: string,
  userEmail: string
): Promise<{
  droppedBalls: { contact: string; subject: string; daysSince: number; threadId: string }[];
  goingCold: { contact: string; daysSince: number; threadId: string }[];
  commitments: { text: string; threadId: string }[];
  summary: string;
}> {
  const provider = await getBulkProvider(apiKey || undefined);

  const threadSummaries = threads.map(t => {
    const daysSince = Math.floor((Date.now() - new Date(t.lastDate).getTime()) / 86400000);
    const lastFromUser = t.lastFrom.toLowerCase().includes(userEmail.toLowerCase());
    return `Thread "${t.subject}" (${t.messageCount} msgs)\n  From: ${t.from}\n  Last: ${t.lastFrom} ${daysSince}d ago\n  ${lastFromUser ? '[YOU SENT LAST]' : '[THEY SENT LAST - WAITING ON YOU]'}\n  Snippet: ${t.snippet}`;
  }).join('\n\n');

  const response = await provider.chat(
    [
      {
        role: 'system',
        content: `Analyze these email thread summaries and identify:
1. DROPPED BALLS: Threads where someone is waiting for the user's reply (they sent last, 7+ days ago)
2. GOING COLD: Important relationships with no contact in 14+ days
3. COMMITMENTS: Things the user promised to do

Return JSON:
{
  "dropped_balls": [{"contact": "Name", "subject": "thread subject", "days_since": N, "thread_id": "id"}],
  "going_cold": [{"contact": "Name", "days_since": N, "thread_id": "id"}],
  "commitments": [{"text": "what was promised", "thread_id": "id"}],
  "summary": "Brief overview of the user's email landscape"
}`
      },
      { role: 'user', content: `User email: ${userEmail}\n\n${threadSummaries}` }
    ],
    { temperature: 0.1, max_tokens: 2000, json: true }
  );

  try {
    const parsed = JSON.parse(response);
    return {
      droppedBalls: parsed.dropped_balls || [],
      goingCold: parsed.going_cold || [],
      commitments: parsed.commitments || [],
      summary: parsed.summary || '',
    };
  } catch {
    return { droppedBalls: [], goingCold: [], commitments: [], summary: '' };
  }
}
