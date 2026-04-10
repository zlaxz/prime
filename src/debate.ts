import { execFile } from 'child_process';
import { request as httpRequest } from 'http';

// ============================================================
// Multi-Agent Debate — Real back-and-forth between Claude instances
//
// Two or more Claude instances debate a topic with persistent sessions.
// Each agent responds to the other's actual arguments, not just the topic.
// Works locally (claude -p) or via Mac Mini proxy (localhost:3211).
//
// Usage:
//   const result = await debate({
//     topic: "Should we pursue the Foresite acquisition?",
//     agents: [
//       { name: "Bull", system: "You argue FOR this decision. Be specific, cite evidence." },
//       { name: "Bear", system: "You argue AGAINST. Find the risks others miss." },
//     ],
//     rounds: 3,
//     synthesize: true,
//   });
// ============================================================

export interface DebateAgent {
  name: string;
  system: string;                   // Role/personality prompt
  sessionId?: string;               // For --resume across debates
}

export interface DebateOptions {
  topic: string;
  context?: string;                 // Background info all agents see
  agents: DebateAgent[];
  rounds?: number;                  // Default 2
  synthesize?: boolean;             // Run a synthesizer at the end? Default true
  synthesizerSystem?: string;       // Custom synthesizer prompt
  mode?: 'local' | 'proxy';        // 'local' = claude -p, 'proxy' = Mac Mini :3211
  proxyUrl?: string;                // Default http://localhost:3211
  maxTurns?: number;                // Per-agent per-round, default 3
  timeout?: number;                 // Per-agent timeout in seconds, default 120
  onTurn?: (agent: string, round: number, content: string) => void;  // Live callback
}

export interface DebateResult {
  topic: string;
  transcript: DebateTurn[];
  synthesis?: string;
  sessionIds: Record<string, string>;  // For resuming later
  durationMs: number;
}

interface DebateTurn {
  agent: string;
  round: number;
  content: string;
  durationMs: number;
}

// Call claude -p locally
async function callLocal(prompt: string, opts: { sessionId?: string; maxTurns?: number; timeout?: number }): Promise<{ result: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json'];
    if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));
    if (opts.sessionId) args.push('--resume', opts.sessionId);

    const proc = execFile('claude', args, {
      timeout: (opts.timeout || 120) * 1000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const envelope = JSON.parse(stdout);
        resolve({ result: envelope.result || stdout, sessionId: envelope.session_id || '' });
      } catch {
        resolve({ result: stdout, sessionId: '' });
      }
    });

    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}

// Call claude via Mac Mini proxy
async function callProxy(prompt: string, opts: { sessionId?: string; maxTurns?: number; timeout?: number; proxyUrl?: string }): Promise<{ result: string; sessionId: string }> {
  const url = new URL(opts.proxyUrl || 'http://localhost:3211');
  const args: string[] = [];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));

  const body = JSON.stringify({ prompt, timeout: opts.timeout || 120, args });

  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port || 3211,
      path: '/claude',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: ((opts.timeout || 120) + 30) * 1000,
    }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ result: parsed.result || '', sessionId: parsed.session_id || '' });
        } catch { resolve({ result: data, sessionId: '' }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxy timeout')); });
    req.write(body);
    req.end();
  });
}

export async function debate(options: DebateOptions): Promise<DebateResult> {
  const start = Date.now();
  const rounds = options.rounds ?? 2;
  const transcript: DebateTurn[] = [];
  const sessionIds: Record<string, string> = {};
  const call = options.mode === 'proxy' ? callProxy : callLocal;
  const callOpts = { maxTurns: options.maxTurns ?? 3, timeout: options.timeout ?? 120, proxyUrl: options.proxyUrl };

  // Initialize session IDs from agent configs
  for (const agent of options.agents) {
    if (agent.sessionId) sessionIds[agent.name] = agent.sessionId;
  }

  // Build shared context header
  const contextBlock = options.context ? `\nCONTEXT:\n${options.context}\n` : '';

  for (let round = 1; round <= rounds; round++) {
    for (let i = 0; i < options.agents.length; i++) {
      const agent = options.agents[i];
      const turnStart = Date.now();

      // Build prompt with previous turns from THIS round and the prior round
      const recentTurns = transcript.slice(-options.agents.length * 2);
      const historyBlock = recentTurns.length > 0
        ? '\nDEBATE SO FAR:\n' + recentTurns.map(t =>
            `[${t.agent}, Round ${t.round}]:\n${t.content}`
          ).join('\n\n---\n\n') + '\n'
        : '';

      let prompt: string;
      if (round === 1 && i === 0) {
        // First agent, first round — opening statement
        prompt = `${agent.system}\n${contextBlock}\nTOPIC: ${options.topic}\n\nThis is Round 1 of a ${rounds}-round debate. Give your opening argument. Be specific and grounded.`;
      } else {
        // Subsequent turns — respond to what others said
        prompt = `${agent.system}\n${contextBlock}\n${historyBlock}\nTOPIC: ${options.topic}\n\nThis is Round ${round}. Respond directly to the other participants' arguments. Address their specific points. Build on or challenge their reasoning.`;
      }

      const response = await call(prompt, { ...callOpts, sessionId: sessionIds[agent.name] });
      sessionIds[agent.name] = response.sessionId;

      const turn: DebateTurn = {
        agent: agent.name,
        round,
        content: response.result,
        durationMs: Date.now() - turnStart,
      };
      transcript.push(turn);

      if (options.onTurn) {
        options.onTurn(agent.name, round, response.result);
      }
    }
  }

  // Synthesis
  let synthesis: string | undefined;
  if (options.synthesize !== false) {
    const fullTranscript = transcript.map(t =>
      `[${t.agent}, Round ${t.round}]:\n${t.content}`
    ).join('\n\n---\n\n');

    const synthPrompt = (options.synthesizerSystem || `You are the synthesizer. You've observed a multi-round debate. Your job is to:
1. Identify where the agents AGREE (high confidence conclusions)
2. Identify where they DISAGREE (genuine uncertainty)
3. Surface the strongest argument from each side
4. Give YOUR verdict — what should the decision-maker actually do?

Be direct. Don't just summarize — take a position.`) + `\n${contextBlock}\nTOPIC: ${options.topic}\n\nFULL DEBATE TRANSCRIPT:\n${fullTranscript}\n\nSynthesize this debate. What's the answer?`;

    const synthResponse = await call(synthPrompt, callOpts);
    synthesis = synthResponse.result;

    if (options.onTurn) {
      options.onTurn('Synthesizer', 0, synthResponse.result);
    }
  }

  return {
    topic: options.topic,
    transcript,
    synthesis,
    sessionIds,
    durationMs: Date.now() - start,
  };
}

// ── Convenience: common debate patterns ──

export function bullBearDebate(topic: string, context?: string, mode?: 'local' | 'proxy') {
  return debate({
    topic,
    context,
    mode: mode || 'local',
    rounds: 2,
    agents: [
      { name: 'Bull', system: 'You are the Bull Advocate. Argue FOR the proposed action. Find every reason it will work, every opportunity it creates, every upside others miss. Be specific — cite evidence, name numbers, reference real constraints.' },
      { name: 'Bear', system: 'You are the Bear Advocate (Risk Analyst). Argue AGAINST. Find every risk, every failure mode, every assumption that could be wrong. Be specific — what exactly breaks, when, and what does it cost?' },
    ],
  });
}

export function redTeamDebate(topic: string, context?: string, mode?: 'local' | 'proxy') {
  return debate({
    topic,
    context,
    mode: mode || 'local',
    rounds: 2,
    agents: [
      { name: 'Architect', system: 'You are the Architect. Propose the best approach to this problem. Be specific about implementation, timeline, and resources.' },
      { name: 'Red Team', system: 'You are the Red Team. Your job is to break the Architect\'s proposal. Find every flaw, edge case, and failure mode. Then suggest what would actually work.' },
      { name: 'Pragmatist', system: 'You are the Pragmatist. You care about what actually ships. Cut through both the optimism and the fear. What\'s the minimum viable version that handles the real risks?' },
    ],
  });
}

export function advisorPanel(topic: string, context?: string, mode?: 'local' | 'proxy') {
  return debate({
    topic,
    context,
    mode: mode || 'local',
    rounds: 2,
    agents: [
      { name: 'CFO', system: 'You are the CFO. Every decision is a financial decision. What does this cost, what does it return, what\'s the cash flow impact? Show the math.' },
      { name: 'Risk Officer', system: 'You are the Chief Risk Officer. What could go wrong? What\'s the worst case? What insurance do we need? What\'s the reputational risk?' },
      { name: 'Strategist', system: 'You are the Chief Strategy Officer. How does this fit the 3-year plan? What does it enable? What does it foreclose? What are competitors doing?' },
      { name: 'Operator', system: 'You are the COO. Can we actually execute this? Do we have the people, systems, and bandwidth? What breaks if we try?' },
    ],
  });
}
