/**
 * Ingest CLI — full implementation lands in #19 (T06).
 *
 * For #13 (T01) we ship a stub that proves the API-key validation seam works
 * end-to-end: load `.env`, validate the key, print the spec-mandated stderr
 * message and exit `1` on failure, exit `0` on success.
 */
import 'dotenv/config';
import { API_KEY_FAILURE_MESSAGES, validateApiKey } from '../yt/api-key.ts';

/** Programmatic entry — used by tests in later tickets. */
export async function runIngest(
  args: {
    channel?: string;
    verbose?: boolean;
    dbPath?: string;
  } = {},
): Promise<number> {
  const key = process.env['YOUTUBE_API_KEY'];
  const result = validateApiKey(key);
  if (!result.ok) {
    process.stderr.write(API_KEY_FAILURE_MESSAGES[result.reason] + '\n');
    return 1;
  }
  // Full pipeline lands in #19 (T06).
  if (!args.channel) {
    process.stderr.write('Error: missing <channel> argument.\n');
    return 1;
  }
  process.stdout.write('[stub] ingest pipeline not yet implemented (T06).\n');
  return 0;
}

// CLI shim — only runs when invoked directly (`tsx src/cli/ingest.ts`).
const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('ingest.ts') === true;
if (isCli) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const channel = args.find((a) => !a.startsWith('--'));
  runIngest({ ...(channel !== undefined ? { channel } : {}), verbose }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
