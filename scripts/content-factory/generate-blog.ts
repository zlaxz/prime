#!/usr/bin/env tsx
/**
 * Content Factory: Blog Post Generator
 *
 * Takes a topic from topics.json and generates a markdown blog post
 * using DeepSeek (cheap, good enough for drafts).
 *
 * Usage:
 *   tsx scripts/content-factory/generate-blog.ts <slug>
 *   tsx scripts/content-factory/generate-blog.ts ai-chief-of-staff-adhd
 *   tsx scripts/content-factory/generate-blog.ts --all    # generate all topics
 *   tsx scripts/content-factory/generate-blog.ts --list   # list available topics
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOPICS_PATH = join(__dirname, 'topics.json');
const OUTPUT_DIR = join(__dirname, 'output');

interface Topic {
  slug: string;
  title: string;
  outline: string[];
}

async function loadTopics(): Promise<Topic[]> {
  const raw = readFileSync(TOPICS_PATH, 'utf-8');
  return JSON.parse(raw).topics;
}

function buildPrompt(topic: Topic): string {
  return `Write a blog post for a solo founder audience. The author is Zach Stock, founder of Prime and an insurance MGA called Recapture.

VOICE RULES:
- Direct, conversational, no corporate speak
- Short paragraphs (1-3 sentences each)
- First person. Write like you talk.
- Confident but not arrogant
- Reference specific details and real experiences
- NEVER use: "in today's fast-paced world", "leverage", "synergy", "at the end of the day", "game-changer"
- Occasional humor is fine. Forced humor is not.

STRUCTURE:
- Hook in the first 2 sentences (make the reader feel seen)
- No fluff introduction. Get to the point.
- Use headers to break sections
- End with a clear takeaway or CTA
- Target: 1200-1800 words

TITLE: ${topic.title}

OUTLINE:
${topic.outline.map((point, i) => `${i + 1}. ${point}`).join('\n')}

Write the full blog post in markdown. Start with the title as an H1.`;
}

async function generatePost(topic: Topic): Promise<string> {
  // Use DeepSeek via OpenAI-compatible API
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY not set. Export it or add to .env');
  }

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a skilled blog writer who matches the author\'s voice exactly. You write compelling, specific, no-BS content for founders.' },
        { role: 'user', content: buildPrompt(topic) },
      ],
      temperature: 0.7,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} ${err}`);
  }

  const data = await response.json() as any;
  return data.choices[0].message.content;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: tsx generate-blog.ts <slug|--all|--list>');
    process.exit(1);
  }

  const topics = await loadTopics();

  if (args[0] === '--list') {
    console.log(`\n${topics.length} topics available:\n`);
    for (const t of topics) {
      console.log(`  ${t.slug}`);
      console.log(`    "${t.title}"\n`);
    }
    return;
  }

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const slugs = args[0] === '--all' ? topics.map(t => t.slug) : args;

  for (const slug of slugs) {
    const topic = topics.find(t => t.slug === slug);
    if (!topic) {
      console.error(`Topic not found: ${slug}`);
      continue;
    }

    const outPath = join(OUTPUT_DIR, `${slug}.md`);
    if (existsSync(outPath) && args[0] !== '--force') {
      console.log(`[skip] ${slug} — already exists (use --force to overwrite)`);
      continue;
    }

    console.log(`[generating] ${topic.title}...`);
    try {
      const content = await generatePost(topic);
      writeFileSync(outPath, content, 'utf-8');
      console.log(`[done] ${outPath}`);
    } catch (err: any) {
      console.error(`[error] ${slug}: ${err.message}`);
    }
  }
}

main().catch(console.error);
