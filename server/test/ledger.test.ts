import { ledgerLines, LedgerLine, LedgerContribution } from '../../client/src/wizard/ledger';
import type { FeedEvent } from '../../shared/src/feed';
import { RES_CONFIG } from '../../shared/src/policies';

const contrib = (overrides: Partial<LedgerContribution> = {}): LedgerContribution => ({
  contributionId: 'c-1',
  dims: { '2': 1 },
  harm: 'none',
  ...overrides,
});

function ev(type: string, actor: string, targetId: string, at: number): FeedEvent {
  return { index: 1, type, actor, at, round: 1, summary: type, targetId } as FeedEvent;
}

describe('ledgerLines', () => {
  it('a settled contribution IS the submitter income — harm-scaled, labeled', () => {
    const lines = ledgerLines(
      [ev('contribution_settled', 'alice', 'c-1', 2000)],
      [contrib({ contributionId: 'c-1', dims: { '1': 1 }, harm: 'none', summary: 'built a bridge' })],
      'alice',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ at: 2000, amount: RES_CONFIG.buildingBounty, sign: '+' });
    expect(lines[0].label).toContain('bounty');
    expect(lines[0].label).toContain('built a bridge');
  });

  it('harm scales the settle line (reduces, voids) and names the harm', () => {
    const lines = ledgerLines(
      [ev('contribution_settled', 'alice', 'c-1', 2000)],
      [contrib({ contributionId: 'c-1', dims: { '1': 1 }, harm: 'reduced', summary: 'x' })],
      'alice',
    );
    expect(lines[0].amount).toBeLessThan(RES_CONFIG.buildingBounty);
    expect(lines[0].label).toContain('harm');
    const voided = ledgerLines(
      [ev('contribution_settled', 'alice', 'c-1', 2000)],
      [contrib({ contributionId: 'c-1', dims: { '1': 1 }, harm: 'voided', summary: 'x' })],
      'alice',
    );
    expect(voided[0].amount).toBe(undefined);   // voided: no payment
    expect(voided[0].label).toContain('voided');
  });

  it('verification checks pay the VERIFIER, not the submitter', () => {
    const lines = ledgerLines(
      [ev('contribution_verified', 'bob', 'c-1', 3000), ev('contribution_settled', 'alice', 'c-1', 4000)],
      [contrib({ contributionId: 'c-1', dims: { '2': 1 }, summary: 'a record' })],
      'bob',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: RES_CONFIG.verificationCheckCredit, sign: '+' });
    expect(lines[0].label).toContain('a record');
    const aliceView = ledgerLines(
      [ev('contribution_verified', 'bob', 'c-1', 3000), ev('contribution_settled', 'alice', 'c-1', 4000)],
      [contrib({ contributionId: 'c-1', dims: { '2': 1 }, summary: 'a record' })],
      'alice',
    );
    expect(aliceView).toHaveLength(1);   // only HER settle line
    expect(aliceView[0].amount).toBe(RES_CONFIG.recordingBaseCredit);
  });

  it('zero-amount consequential events never render; unknown contributions degrade to "?"', () => {
    const lines = ledgerLines(
      [ev('proposal_created', 'alice', 'p-1', 1000), ev('reassign_verifiers', 'bob', 'c-9', 1500), ev('contribution_verified', 'bob', 'c-9', 2000)],
      [],
      'bob',
    );
    expect(lines).toHaveLength(1);           // the verified check on an AGED-OUT contribution
    expect(lines[0].sign).toBe('?');
    expect(lines[0].amount).toBeUndefined();
  });

  it('empty mirror history is an empty ledger', () => {
    expect(ledgerLines([], [], 'alice')).toEqual([]);
  });
});
