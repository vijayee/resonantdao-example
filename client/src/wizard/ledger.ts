// Pure earned-money projection for the account page. Protocol truth lives in
// the registers (the BALANCE is authoritative); this module retells the feed
// mirror as line items — same shared payout math the handlers and receipts
// use, so the ledger cannot disagree with the machine. Vote spends are NOT
// listed (the feed carries no vote rows by design — rule D2).
import { harmFactorFor, paymentFor, DIMENSIONS, HarmVerdict } from '../../../shared/src/contribution';
import { RES_CONFIG } from '../../../shared/src/policies';
import type { FeedEvent } from '../../../shared/src/feed';

export interface LedgerContribution {
  contributionId: string;
  dims: Record<string, number>;
  harm?: string;
  summary?: string;
}

export interface LedgerLine {
  at: number;
  label: string;
  amount?: number;            // absent when the data degrades
  sign: '+' | '−' | '?';
}

function dimLabel(dims: Record<string, number>): string {
  const k = Object.keys(dims)[0];
  const def = DIMENSIONS[Number(k)];
  return def ? `C_${def.index}` : 'C_?';
}

export function ledgerLines(feedEvents: FeedEvent[], contributions: LedgerContribution[], viewer: string): LedgerLine[] {
  const lines: LedgerLine[] = [];
  const byId = new Map(contributions.map((c) => [c.contributionId, c]));
  for (const e of feedEvents) {
    if (e.type === 'contribution_settled' && e.actor === viewer) {
      const c = byId.get(e.targetId ?? '');
      if (!c) {
        lines.push({ at: e.at, label: 'settled contribution (aged out of the mirror)', amount: undefined, sign: '?' });
        continue;
      }
      if (c.harm === 'voided') {
        lines.push({ at: e.at, label: `${c.summary ?? 'contribution'} — settled, outcome voided (harm)`, amount: undefined, sign: '−' });
        continue;
      }
      const base = Object.entries(c.dims).reduce((sum, [k, match]) => sum + paymentFor(Number(k), match), 0);
      const amount = c.harm && c.harm !== 'none' ? base * harmFactorFor(c.harm as HarmVerdict) : base;
      // C_1 pays a bounty, C_2 pays a credit — the money word follows the class.
      const word = Object.keys(c.dims).some((k) => Number(k) === 1) ? 'bounty' : 'credit';
      lines.push({
        at: e.at,
        label: `settled — ${word} ${amount} — "${c.summary ?? 'contribution'}"${c.harm && c.harm !== 'none' ? ' (harm reduced)' : ''}`,
        amount,
        sign: '+',
      });
    } else if (e.type === 'contribution_verified' && e.actor === viewer) {
      const c = byId.get(e.targetId ?? '');
      lines.push({
        at: e.at,
        label: c ? `verification check — "${c.summary ?? 'contribution'}"` : 'verification check (contribution aged out of the mirror)',
        amount: c ? RES_CONFIG.verificationCheckCredit : undefined,
        sign: c ? '+' : '?',
      });
    }
  }
  return lines;
}