import '../src/env.js';

const BASE = 'http://localhost:3000';

async function triggerScrape(n: number): Promise<{ job_id: string; discovered: number; skipped: number; duration_ms: number }> {
  console.log(`\n=== Scrape ${n} ===`);

  // Trigger
  const startRes = await fetch(`${BASE}/v1/debug/scrape/run`, { method: 'POST' });
  if (startRes.status === 409) {
    console.log(`  Scrape ${n}: concurrent lock, waiting 30s...`);
    await new Promise(r => setTimeout(r, 30000));
    return triggerScrape(n); // retry
  }
  const startData = await startRes.json() as any;
  const jobId = startData.job_id;
  console.log(`  Triggered: job_id=${jobId}`);

  // Poll until done
  for (let i = 0; i < 40; i++) { // 40 * 10s = 400s max
    await new Promise(r => setTimeout(r, 10000));
    const statusRes = await fetch(`${BASE}/v1/debug/scrape/status?job_id=${jobId}`);
    const statusData = await statusRes.json() as any;
    if (statusData.state === 'done' || statusData.state === 'failed') {
      console.log(`  Done: discovered=${statusData.discovered} skipped=${statusData.skipped} duration=${statusData.duration_ms}ms`);
      if (statusData.error) console.log(`  Error: ${statusData.error}`);
      return {
        job_id: jobId,
        discovered: statusData.discovered ?? 0,
        skipped: statusData.skipped ?? 0,
        duration_ms: statusData.duration_ms ?? 0,
      };
    }
  }
  console.log(`  Timeout waiting for scrape ${n}`);
  return { job_id: jobId, discovered: 0, skipped: 0, duration_ms: 0 };
}

async function main() {
  const rounds = parseInt(process.argv[2] ?? '4', 10);
  const results: any[] = [];

  for (let i = 1; i <= rounds; i++) {
    const r = await triggerScrape(i);
    results.push(r);
    if (i < rounds) {
      console.log('  Waiting 5s before next scrape...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log('\n=== SCRAPE SUMMARY ===');
  let totalDiscovered = 0;
  let totalSkipped = 0;
  for (const r of results) {
    totalDiscovered += r.discovered;
    totalSkipped += r.skipped;
  }
  console.log(`  Rounds: ${results.length}`);
  console.log(`  Total discovered: ${totalDiscovered}`);
  console.log(`  Total skipped: ${totalSkipped}`);
}

main().catch(console.error);
