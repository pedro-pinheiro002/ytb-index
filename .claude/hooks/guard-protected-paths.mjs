#!/usr/bin/env node
// PreToolUse (Edit|Write): refuse writes to the danger zones listed in AGENTS.md.
// - an existing file in migrations/ (already applied in production; add a new one)
// - .env / .env.* (real credentials), except .env.example
import { existsSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const filePath = input.tool_input?.file_path;
if (typeof filePath !== 'string') process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const absolute = resolve(root, filePath);
const path = relative(root, absolute).split('\\').join('/');
const name = basename(absolute);

let reason;
if (path.startsWith('migrations/') && existsSync(absolute)) {
  reason = `${path} is an applied migration: add a new numbered file in migrations/ instead (AGENTS.md, Danger zones).`;
} else if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') {
  reason = `${path} holds real credentials and is off limits to agents (AGENTS.md, Danger zones).`;
}

if (reason !== undefined) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}
