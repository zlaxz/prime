import { spawn, execFile, type ChildProcess } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================
// Shared Claude CLI spawn utility
//
// On Mac Mini (headless/SSH/launchd), claude -p can't access
// the Keychain for OAuth. The GUI wrapper routes through
// osascript "tell Terminal" so Keychain is reachable.
//
// On laptop (GUI session), claude -p works directly.
//
// ALL files that spawn claude -p MUST use this utility.
// ============================================================

const GUI_WRAPPER = join(homedir(), 'GitHub', 'prime', 'scripts', 'claude-gui.sh');

/**
 * Build the command + args for a claude -p invocation.
 * Handles GUI wrapper vs direct CLI transparently.
 */
export function buildClaudeCommand(options: {
  sessionId?: string;
  extraArgs?: string[];
  outputFormat?: 'json' | 'text';
  maxTurns?: number;
} = {}): { cmd: string; args: string[] } {
  const useGui = false; // NEVER use GUI wrapper
  const extra = options.extraArgs || [];

  if (useGui) {
    // GUI wrapper: reads prompt from stdin, passes args through
    const args: string[] = ['--model', 'claude-opus-4-6'];
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
    args.push(...extra);
    return { cmd: GUI_WRAPPER, args };
  } else {
    // Direct CLI
    const args: string[] = ['-p', '--model', 'claude-opus-4-6'];
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.outputFormat === 'json') args.push('--output-format', 'json');
    if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
    args.push(...extra);
    return { cmd: 'claude', args };
  }
}

/**
 * Build a clean env object for claude spawns.
 * Removes ANTHROPIC_API_KEY to force OAuth (Max subscription).
 */
export function buildClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // Ensure Homebrew paths are available (cron/launchd strip PATH)
  const homebrew = '/opt/homebrew/bin:/opt/homebrew/sbin';
  if (!env.PATH?.includes(homebrew)) {
    env.PATH = `${homebrew}:${env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
  }
  return env;
}

/**
 * Spawn claude -p with stdin piping. Returns the raw ChildProcess.
 * Use this when you need low-level control (custom stdio, detached, etc).
 */
export function spawnClaude(options: {
  sessionId?: string;
  extraArgs?: string[];
  outputFormat?: 'json' | 'text';
  maxTurns?: number;
  timeout?: number;
  detached?: boolean;
  stdio?: 'pipe' | 'ignore';
} = {}): ChildProcess {
  const { cmd, args } = buildClaudeCommand(options);
  const env = buildClaudeEnv();

  return spawn(cmd, args, {
    stdio: options.stdio === 'ignore' ? 'ignore' : ['pipe', 'pipe', 'pipe'],
    env,
    timeout: options.timeout,
    detached: options.detached,
  });
}

/**
 * Run claude -p with a prompt via stdin. Returns stdout as a string.
 * This is the most common pattern — fire prompt, get response.
 */
export async function runClaude(prompt: string, options: {
  sessionId?: string;
  extraArgs?: string[];
  outputFormat?: 'json' | 'text';
  maxTurns?: number;
  timeout?: number;
} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaude(options);

    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 300)}`));
    });
    proc.on('error', reject);

    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}

/**
 * Spawn claude -p in background (detached, fire-and-forget).
 * Prompt is passed as a CLI argument (for short prompts) or
 * via a temp file + shell pipe (for long prompts in agents).
 */
export function spawnClaudeBackground(options: {
  prompt?: string;
  promptPath?: string;
  extraArgs?: string[];
}): ChildProcess {
  const { cmd, args } = buildClaudeCommand({ extraArgs: options.extraArgs });
  const env = buildClaudeEnv();

  if (options.promptPath) {
    // Long prompt via temp file: cat file | claude -p ...
    const shellCmd = `cat '${options.promptPath}' | ${cmd} ${args.join(' ')} 2>/dev/null; rm -f '${options.promptPath}'`;
    const child = spawn('sh', ['-c', shellCmd], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    return child;
  } else if (options.prompt) {
    // Short prompt as arg
    const child = spawn(cmd, [...args, options.prompt], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    return child;
  } else {
    throw new Error('spawnClaudeBackground requires either prompt or promptPath');
  }
}

/**
 * Check if the claude CLI is available on PATH.
 */
export async function isClaudeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('which', ['claude'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
