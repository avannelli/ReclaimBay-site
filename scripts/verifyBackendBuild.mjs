import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export async function verifyBackendBuild(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  for (const relative of ['backend/dist/server.js', 'backend/dist/routes/billing.js', 'backend/private/report.js']) {
    const info = await lstat(path.join(root, relative));
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Required backend release artifact is not a regular file.');
  }
  const asset = await readFile(path.join(root, 'backend/private/report.js'));
  if (asset.length < 1000 || !asset.includes(Buffer.from('ReclaimBayPaid'))) throw Error('Private paid renderer is missing or invalid.');
  if (/(?:\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_-]{8,}|\bwhsec_[A-Za-z0-9_-]{8,}|sourceMappingURL=)/.test(asset.toString())) throw Error('Private renderer contains forbidden secret or source map material.');
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('NEXT_PUBLIC_') && /SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(name) && value?.length >= 12 && asset.includes(Buffer.from(value))) throw Error('Configured private value found in paid renderer.');
  }
  try { await lstat(path.join(root, 'backend/private/report.js.map')); throw Error('Paid renderer source map must not ship.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { privateArtifact: 'backend/private/report.js', bytes: asset.length, sha256: createHash('sha256').update(asset).digest('hex') };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyBackendBuild().then(r => console.log('Backend release boundary PASS: ' + JSON.stringify(r))).catch(() => {
    console.error('Backend release boundary FAILED: required private artifact invalid, absent or unsafe.'); process.exitCode = 1;
  });
}
