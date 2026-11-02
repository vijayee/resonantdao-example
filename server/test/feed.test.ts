import { CONSEQUENTIAL_OPS, feedEventFromOp, type FeedEvent } from '../../shared/src/feed';

describe('feed event builder', () => {
  it('maps create_proposal to proposal_created with title and type detail', () => {
    const payload = JSON.stringify({
      proposalId: '11111111-2222-3333-4444-555555555555',
      title: 'Fix the roof',
      description: 'x',
      proposalType: 'direct',
      options: ['Yes', 'No'],
      expiresAt: 1,
    });
    const ev = feedEventFromOp('create_proposal', 'alice', payload, 1000, 1, 4) as FeedEvent;
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('proposal_created');
    expect(ev!.actor).toBe('alice');
    expect(ev!.at).toBe(1000);
    expect(ev!.round).toBe(1);
    expect(ev!.index).toBe(4);
    expect(ev!.summary).toBe('"Fix the roof" — direct proposal created');
    expect(ev!.targetId).toBe('11111111-2222-3333-4444-555555555555');
    expect(ev!.detail).toEqual({ proposalType: 'direct' });
  });

  it('maps execute to proposal_executed without a title (payload is only an id)', () => {
    const ev = feedEventFromOp(
      'execute', 'bob',
      JSON.stringify({ proposalId: 'aaaabbbb-1' }), 2000, 1, 5,
    ) as FeedEvent;
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('proposal_executed');
    expect(ev!.summary).toBe('proposal aaaabbbb executed');
    expect(ev!.targetId).toBe('aaaabbbb-1');
  });

  it('maps submit_contribution with the dimension class label', () => {
    const payload = JSON.stringify({
      contributionId: 'ccccdddd-2',
      dims: { '2': 1 },
      summary: 'Wrote an architecture record',
      evidenceRef: { hash: 'h', uri: 'u', mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v2',
    });
    const ev = feedEventFromOp('submit_contribution', 'carol', payload, 3000, 1, 6) as FeedEvent;
    expect(ev!.type).toBe('contribution_submitted');
    expect(ev!.summary).toBe('Recording (C_2) contribution submitted — "Wrote an architecture record"');
    expect(ev!.targetId).toBe('ccccdddd-2');
  });

  it('maps verify_contribution with pass/harm detail and no full reason text', () => {
    const payload = JSON.stringify({
      contributionId: 'eeeeffff-3', submitter: 'alice', dims: { '1': 1 },
      stepId: 'verify', pass: true, reason: 'a very long reason that must not leak into the feed summary',
      harm: 'reduced', priorVerifiers: [],
    });
    const ev = feedEventFromOp('verify_contribution', 'bob', payload, 4000, 1, 7) as FeedEvent;
    expect(ev!.type).toBe('contribution_verified');
    expect(ev!.summary).toBe('bob verified alice — upheld (reduced)');
    expect(ev!.detail).toEqual({ verifyPass: true, harm: 'reduced' });
    expect(ev!.summary.includes('long reason')).toBe(false);
  });

  it('maps settle and appeal minimally', () => {
    const s = feedEventFromOp(
      'settle_contribution', 'alice',
      JSON.stringify({ contributionId: 'c-4', submitter: 'alice', reason: 'n', verifiers: [] }), 5000, 1, 8,
    ) as FeedEvent;
    const a = feedEventFromOp(
      'appeal_verdict', 'carol',
      JSON.stringify({ contributionId: 'c-4', submitter: 'alice', reason: 'n' }), 6000, 1, 9,
    ) as FeedEvent;
    expect(s!.type).toBe('contribution_settled');
    expect(s!.summary).toBe('alice settled');
    expect(a!.type).toBe('contribution_appealed');
    expect(a!.summary).toBe('carol appealed — awaiting re-verification');
  });

  it('maps election lifecycle with candidate counts', () => {
    const start = feedEventFromOp(
      'start_election', 'dave',
      JSON.stringify({ electionId: 'e-1', candidates: ['alice', 'bob', 'carol', 'dave'], expiresAt: 1 }), 7000, 1, 10,
    ) as FeedEvent;
    const fin = feedEventFromOp(
      'finalize_election', 'alice',
      JSON.stringify({ electionId: 'e-1', candidates: ['alice'] }), 8000, 1, 11,
    ) as FeedEvent;
    expect(start!.type).toBe('election_started');
    expect(start!.summary).toBe('custodian election started — 4 candidates');
    expect(start!.targetId).toBe('e-1');
    expect(fin!.type).toBe('election_finalized');
  });

  it('stamps round events on their TARGET round (publish completes the previous one)', () => {
    const audit = feedEventFromOp(
      'audit_round', 'alice',
      JSON.stringify({ fair: true, note: 'ok', calibrationVersion: 'v1' }), 9000, 2, 12,
    ) as FeedEvent;
    const pub = feedEventFromOp(
      'complete_round', 'alice',
      JSON.stringify({ entries: [{ contributionId: 'x', submitter: 'a', dims: {}, harm: 'none' }] }), 10000, 2, 13,
    ) as FeedEvent;
    expect(audit!.type).toBe('round_audited');
    expect(audit!.round).toBe(2);
    expect(audit!.summary).toBe('round 2 audited — fair');
    expect(audit!.detail).toEqual({ fair: true });
    expect(pub!.type).toBe('round_published');
    expect(pub!.round).toBe(1); // complete_round bumps current BEFORE capture; publish belongs to the finishing round
    expect(pub!.summary).toBe('round 1 published — 1 contribution(s) aggregated');
    expect(pub!.detail).toEqual({ aggregatedCount: 1 });
  });

  it('returns null for non-consequential ops (votes, roles, membership)', () => {
    for (const type of ['vote', 'cast_ballot', 'cast_runoff_vote', 'add_member', 'remove_member', 'sync_roles', 'set_rct_alpha', 'set_calibration_version', 'unknown_op_type']) {
      expect(feedEventFromOp(type, 'x', '{}', 1, 1, 1)).toBeNull();
    }
  });

  it('degrades a consequential op with a corrupt payload to a generic summary', () => {
    for (const type of ['create_proposal', 'submit_contribution', 'verify_contribution']) {
      const ev = feedEventFromOp(type, 'y', 'not-json{', 1, 1, 1) as FeedEvent;
      expect(ev).not.toBeNull();
      expect(ev!.summary).toContain(type.replace(/_/g, ' '));
      expect(ev!.targetId).toBeUndefined();
    }
  });

  it('maps reassign_verifiers with the named names', () => {
    const ev = feedEventFromOp(
      'reassign_verifiers', 'alice',
      JSON.stringify({ contributionId: 'c-1', verifiers: ['carol', 'dave'] }), 7000, 1, 20,
    ) as FeedEvent;
    expect(ev!.type).toBe('verifiers_reassigned');
    expect(ev!.summary).toBe('alice named carol & dave as additional verifier(s)');
    expect(ev!.targetId).toBe('c-1');
  });

  it('declares exactly the consequential op set', () => {
    expect([...CONSEQUENTIAL_OPS].sort()).toEqual([
      'appeal_verdict', 'audit_round', 'complete_round', 'create_proposal', 'execute',
      'finalize_election', 'reassign_verifiers', 'reckon_round', 'settle_contribution',
      'start_election', 'submit_contribution', 'verify_contribution',
    ]);
  });
});
