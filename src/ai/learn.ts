import type Database from 'better-sqlite3';
import { searchByText, getConfig, setConfig } from '../db.js';
import { setBusinessContext } from './extract.js';
import { getDefaultProvider } from './providers.js';

/**
 * Auto-learn business context from ingested knowledge.
 *
 * After initial scan (e.g., Gmail connect), analyze all knowledge items
 * and generate a business context document that improves future extraction.
 *
 * Uses Claude Code CLI (free via Max subscription) for reasoning.
 */
export async function learnBusinessContext(db: Database.Database): Promise<string> {
  const apiKey = getConfig(db, 'openai_api_key');
  const provider = await getDefaultProvider(apiKey || undefined);

  // Get all knowledge items
  const items = searchByText(db, '', 500);
  if (items.length < 5) return ''; // Not enough data to learn from

  // Build a summary of what we know
  const contactCounts = new Map<string, number>();
  const orgCounts = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  const allTags = new Map<string, number>();
  const commitments: string[] = [];
  const titles: string[] = [];

  for (const item of items) {
    titles.push(item.title);
    const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    const orgs = Array.isArray(item.organizations) ? item.organizations : JSON.parse(item.organizations || '[]');
    const tags = Array.isArray(item.tags) ? item.tags : JSON.parse(item.tags || '[]');
    const comms = Array.isArray(item.commitments) ? item.commitments : JSON.parse(item.commitments || '[]');

    for (const c of contacts) contactCounts.set(c, (contactCounts.get(c) || 0) + 1);
    for (const o of orgs) orgCounts.set(o, (orgCounts.get(o) || 0) + 1);
    for (const t of tags) allTags.set(t, (allTags.get(t) || 0) + 1);
    if (item.project) projectCounts.set(item.project, (projectCounts.get(item.project) || 0) + 1);
    for (const c of comms) commitments.push(c);
  }

  const topContacts = Array.from(contactCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topOrgs = Array.from(orgCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topProjects = Array.from(projectCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topTags = Array.from(allTags.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);

  // Build contact-to-project mapping directly from data
  const contactProjectMap = new Map<string, Map<string, number>>(); // contact → {project → count}
  for (const item of items) {
    if (!item.project) continue;
    const contacts = Array.isArray(item.contacts) ? item.contacts : JSON.parse(item.contacts || '[]');
    for (const c of contacts) {
      if (!contactProjectMap.has(c)) contactProjectMap.set(c, new Map());
      const projMap = contactProjectMap.get(c)!;
      projMap.set(item.project, (projMap.get(item.project) || 0) + 1);
    }
  }

  // For each contact, determine their PRIMARY project (highest count)
  const contactPrimaryProject: string[] = [];
  for (const [contact, projMap] of contactProjectMap.entries()) {
    const sorted = Array.from(projMap.entries()).sort((a, b) => b[1] - a[1]);
    const projects = sorted.map(([p, c]) => `${p} (${c})`).join(', ');
    contactPrimaryProject.push(`${contact} → ${projects}`);
  }

  const dataSnapshot = `
DATA SNAPSHOT (from ${items.length} knowledge items):

Top contacts: ${topContacts.map(([n, c]) => `${n} (${c})`).join(', ')}

Top organizations: ${topOrgs.map(([n, c]) => `${n} (${c})`).join(', ')}

Detected projects: ${topProjects.map(([n, c]) => `${n} (${c} items)`).join(', ')}

Common topics: ${topTags.map(([n, c]) => `${n} (${c})`).join(', ')}

CONTACT → PROJECT ASSIGNMENTS (from database, use as-is):
${contactPrimaryProject.join('\n')}

Recent commitments: ${commitments.slice(0, 10).join('; ')}

Sample titles: ${titles.slice(0, 20).join('; ')}
`;

  const context = await provider.chat(
    [
      {
        role: 'system',
        content: `You are analyzing a user's email and business data to generate a business context document. This will be injected into future AI extraction prompts to correctly categorize information.

CRITICAL: The #1 problem this solves is CONFLATION — AI models wrongly associating contacts, organizations, and topics with the wrong project. Your output must make it IMPOSSIBLE to confuse one project with another.

Generate a business context with these sections:

## Business Overview
What the user does. One paragraph.

## Projects (EXPLICIT SEPARATION)
For EACH project, list:
- **Name**: The project name
- **What it is**: One sentence
- **Key contacts**: WHO is involved (name + role)
- **Key organizations**: Which companies are part of THIS project
- **NOT related to**: Explicitly list other projects this should NOT be confused with

Example format:
- **Carefront**: Senior living liability insurance MGA backed by Lloyds. Contacts: [names]. Orgs: [orgs]. NOT related to: Physician Cyber Program, GridProtect.
- **Physician Cyber Program**: Cyber liability for physicians via ECBM. Contacts: [names]. Orgs: [orgs]. NOT related to: Carefront, Rural Health.

## Contact → Project Mapping
Copy the CONTACT → PROJECT ASSIGNMENTS section from the data exactly as provided. Do NOT re-infer contact-project associations — the database assignments are authoritative. Just reformat them clearly.

## Current Priorities
Top 3-5 things based on frequency and recency.

Be SPECIFIC. Use real names from the data. The goal is disambiguation, not summarization.`,
      },
      { role: 'user', content: dataSnapshot },
    ],
    { temperature: 0.3, max_tokens: 2000 }
  );

  if (context) {
    // Save to config
    setConfig(db, 'business_context', context);
    // Update extraction cache
    setBusinessContext(context);
  }

  return context;
}
