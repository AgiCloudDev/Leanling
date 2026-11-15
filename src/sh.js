// Runs external commands (docker, git, scanners, agents) without an intermediate shell.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

/** Runs a command; `onLine` receives each output line as it arrives. */
export function run(cmd, args, { cwd, env, input, onLine, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = timeout ? setTimeout(() => child.kill('SIGTERM'), timeout * 1000) : null;
    const feed = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) err += text;
      else out += text;
      if (onLine) for (const line of text.split('\n')) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', (c) => feed(c, false));
    child.stderr.on('data', (c) => feed(c, true));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, out, err: err + e.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

/** Free port on 127.0.0.1 for test containers */
export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
