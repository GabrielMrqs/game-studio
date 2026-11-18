import { checkReviewEvidence } from '../review-evidence.mjs';
import { publishRun } from '../publish-run.mjs';

// Fixture-only: the key and approval flag must come from a trusted controller.
export async function publishReviewedFixture({ humanApproved, evidence, signature, publicKey, ...run }) {
  if (humanApproved !== true) throw new Error('explicit human approval required');
  if (!checkReviewEvidence({ evidence, signature, publicKey, runId: run.id, commit: run.approvedSha })) throw new Error('trusted review evidence required');
  return publishRun({ ...run, evidence, signature, publicKey });
}
