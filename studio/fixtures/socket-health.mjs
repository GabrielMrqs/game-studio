import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function socketHealthy({ cezar = 'http://127.0.0.1:14321/api/v1/health', relay = 'http://127.0.0.1:18080/' } = {}) {
  try {
    const [health, gateway] = await Promise.all([
      fetch(cezar, { redirect: 'manual', signal: AbortSignal.timeout(2000) }),
      fetch(relay, { redirect: 'manual', signal: AbortSignal.timeout(2000) }),
    ]);
    return health.ok && gateway.status === 404;
  } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await socketHealthy() ? 0 : 1;
}
