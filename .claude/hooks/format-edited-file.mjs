#!/usr/bin/env node
// PostToolUse (Edit|Write): run the repo's Prettier on the file just written,
// so `pnpm format:check` never fails on an agent's edit. Files Prettier does
// not handle or that .prettierignore excludes are skipped.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const filePath = input.tool_input?.file_path ?? input.tool_response?.filePath;
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const prettier = join(root, 'node_modules', '.bin', 'prettier');
if (typeof filePath !== 'string' || !existsSync(filePath) || !existsSync(prettier)) process.exit(0);

execFileSync(prettier, ['--write', '--ignore-unknown', '--log-level', 'warn', filePath], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
});
