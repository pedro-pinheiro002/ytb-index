/**
 * Mask the unsealed OperatorKey in the Actions log (`cli/unseal-mask`),
 * F6 (#51), ADR-0008.
 *
 * Run by `.github/workflows/ingest.yml` before "Run ingest": when
 * `INGEST_SEALED_KEY` is set it unseals the key and prints
 * `::add-mask::<key>`, which the runner consumes so every later occurrence of
 * the key in the log is replaced by `***`. The CLI never prints the key, so
 * this is defense in depth (a stray library error or debug line).
 *
 * It never fails the job: when unsealing fails it only warns, and the ingest
 * step then fails with the same error and reports it through
 * `--report-status` (no plaintext exists to leak in that case).
 */
import { unsealOperatorKey } from './unseal.ts';

const sealed = process.env['INGEST_SEALED_KEY'] ?? '';
const privateJwk = process.env['INGEST_SEAL_PRIVATE_KEY'] ?? '';

if (sealed.trim() !== '') {
  unsealOperatorKey(sealed, privateJwk).then(
    (key) => {
      process.stdout.write(`::add-mask::${key}\n`);
    },
    (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      process.stdout.write(`::warning::could not unseal the OperatorKey: ${reason}\n`);
    },
  );
}
