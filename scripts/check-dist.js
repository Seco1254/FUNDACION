import { existsSync } from 'node:fs';

if (!existsSync('dist/server.js')) {
  console.error(
    '\n  Error: dist/server.js not found.' +
    '\n  Run: npm run build\n'
  );
  process.exit(1);
}
