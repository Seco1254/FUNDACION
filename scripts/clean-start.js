import { rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

rmSync('dist', { recursive: true, force: true });
execSync('npm run build', { stdio: 'inherit' });
execSync('npm run start', { stdio: 'inherit' });
