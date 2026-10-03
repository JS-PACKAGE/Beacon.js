import { restoreDrill } from '../dist/ops/restore.js';

process.umask(0o077);
const args = process.argv.slice(2);
if (args.length !== 1 || !args[0] || args[0].startsWith('--')) {
  console.error('Usage: npm run restore:drill -- BACKUP.sqlite (temporary isolated destination only)');
  process.exitCode = 1;
} else {
  try {
    const result = await restoreDrill(args[0]);
    console.log(JSON.stringify({ status: 'verified', ...result }));
  } catch {
    console.error('Restore drill failed; source retained unchanged');
    process.exitCode = 1;
  }
}
