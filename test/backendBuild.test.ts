import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyBackendBuild } from '../scripts/verifyBackendBuild.mjs';

test('backend release gate refuses missing, secret-bearing and source-mapped private assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reclaimbay-backend-build-'));
  try {
    await mkdir(path.join(root, 'backend/dist/routes'), { recursive: true });
    await mkdir(path.join(root, 'backend/private'), { recursive: true });
    for (const file of ['server.js', 'routes/billing.js']) await writeFile(path.join(root, 'backend/dist', file), '// compiled');
    await assert.rejects(verifyBackendBuild(root));
    const target = path.join(root, 'backend/private/report.js');
    const valid = 'var ReclaimBayPaid={};' + ' '.repeat(1000);
    await writeFile(target, valid);
    assert.ok((await verifyBackendBuild(root)).bytes > 1000);
    await writeFile(target, valid + 'sk_test_deliberate_fixture_key');
    await assert.rejects(verifyBackendBuild(root));
    await writeFile(target, valid);
    await writeFile(target + '.map', '{}');
    await assert.rejects(verifyBackendBuild(root));
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('reclaimbay-backend-build-')) throw Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
