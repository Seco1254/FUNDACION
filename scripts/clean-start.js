import { rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Env check runs first (npm run start also checks, but fail early here)
execSync('node scripts/check-env.js', { stdio: 'inherit' });
rmSync('dist', { recursive: true, force: true });
execSync('npm run build', { stdio: 'inherit' });
execSync('npm run start', { stdio: 'inherit' });
