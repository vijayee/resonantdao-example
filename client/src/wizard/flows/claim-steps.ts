import { FlowStep } from '../types';

// The claim family's tie steps (slices #6a/#6e), reduced to a pure function of
// the dim answer + the mirror's read: the store-read options arrive as plain
// params, so the derivation is testable without the browser store.
//   - C_19 (slice #6a): the recognized-member pick (members minus self — the
//     machine's only barring is self-recognition, S-B) + the record tie pick
//     (the recognizer's OWN accepted records).
//   - C_5 (slice #6e): the taught-member pick (members minus self — a claim
//     demonstrates competence in ANOTHER member, S-5-B) + the DYNAMIC record
//     tie pick: the chosen TAUGHT member's accepted records — the
//     demonstration's proven work must belong to the student (the machine's
//     owner-set pin; the picker mirrors exactly that so a bogus tie is never
//     offerable). The options re-read per the taught answer: the flow's step
//     list re-evaluates on every answer commit, so the record pick renders
//     from the taught member's accepted work.
// The exact count-1 members picks are the flow's validation (Choose exactly
// 1); EMPTY options leave Next unpassable — the machine's gate mirrors it.
export interface ClaimTieWorld {
  members: string[]; // the store's known member list
  username: string | null; // the viewer (the filer)
  acceptedContributions: Array<{ id: string; submitter: string }>; // the mirror's accepted records
}

export function claimTieSteps(
  dim: number,
  answers: { taught?: string },
  world: ClaimTieWorld
): FlowStep[] {
  const nonSelf = world.members.filter((m) => m && m !== world.username).sort();
  const acceptedBy = (submitter: string | undefined) => {
    if (!submitter) return [];
    return world.acceptedContributions
      .filter((c) => c.submitter === submitter)
      .map((c) => c.id);
  };
  if (dim === 19) {
    return [
      {
        kind: 'members' as const, id: 'recognized', title: 'Whose work is recognized?',
        options: nonSelf,
        count: 1,
      },
      {
        kind: 'members' as const, id: 'record', title: 'Tie it to a proven record',
        options: acceptedBy(world.username ?? undefined),
        count: 1,
      },
    ];
  }
  if (dim === 5) {
    return [
      {
        kind: 'members' as const, id: 'taught', title: 'Who did you teach?',
        options: nonSelf,
        count: 1,
      },
      {
        kind: 'members' as const, id: 'record', title: 'Tie it to the student’s proven record',
        options: acceptedBy(answers.taught),
        count: 1,
      },
    ];
  }
  return [];
}
