import { createPublicKey, verify } from 'node:crypto';

// The trusted public key must be provisioned outside agent control.
export function checkReviewEvidence({ evidence, signature, publicKey, runId, commit }) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId || '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit || '')) return false;
  if (!evidence || evidence.runId !== runId || evidence.commit !== commit || evidence.verdict !== 'approve' || Object.keys(evidence).sort().join(',') !== 'commit,runId,verdict') return false;
  if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/.test(signature)) return false;
  try {
    const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const payload = JSON.stringify({ runId: evidence.runId, commit: evidence.commit, verdict: evidence.verdict });
    return verify(null, Buffer.from(payload), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}
