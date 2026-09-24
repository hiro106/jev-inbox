import { describe, expect, it } from 'vitest';
import {
  applyDecision,
  decisionSchema,
  getStage,
  parseWorkspace,
  priorityFromScore,
  reviewReasons,
  ticketInputSchema,
  toCsv,
  withHistory,
  type Ticket,
} from '../shared/domain';
import { createSeedTickets, demoDecision } from '../shared/demo';

const input = {
  subject: '請求書をください',
  body: '契約中のプランの請求書を送ってください。',
  sender: 'テスト',
  channel: 'メール' as const,
};
const ticket: Ticket = {
  ...input,
  id: 'test-1',
  createdAt: '2026-09-24T00:00:00.000Z',
  history: [],
};

describe('triage policy', () => {
  it('routes high-confidence ordinary work to ready, but never resolves it', () => {
    const result = applyDecision(ticket, demoDecision(input));
    expect(getStage(result, 0.8)).toBe('ready');
    expect(result.resolvedAt).toBeUndefined();
  });
  it('uses each confidence separately, not the label probability', () => {
    const decision = { ...demoDecision(input), urgencyConfidence: 0.51 };
    expect(reviewReasons(decision, 0.8)).toContain('優先度の確信度が基準未満');
  });
  it('reviews urgent cases regardless of confidence', () => {
    expect(reviewReasons({ ...demoDecision(input), urgency: 2.9 }, 0.8)).toContain(
      '緊急度が高いため、人の確認が必要',
    );
  });
  it('reviews other and uncertain reply probability', () => {
    expect(
      reviewReasons({ ...demoDecision(input), category: 'other', needsReply: 0.5 }, 0.8),
    ).toHaveLength(2);
  });
  it('handles exact confidence and reply boundaries', () => {
    expect(
      reviewReasons(
        {
          ...demoDecision(input),
          categoryConfidence: 0.8,
          urgencyConfidence: 0.8,
          needsReply: 0.65,
        },
        0.8,
      ),
    ).toEqual([]);
    expect(reviewReasons({ ...demoDecision(input), needsReply: 0.35 }, 0.8)).toEqual([]);
  });
  it('recomputes the queue when threshold changes, preserves a human review', () => {
    const t = applyDecision(ticket, demoDecision(input));
    expect(getStage(t, 0.99)).toBe('review');
    expect(
      getStage(
        {
          ...t,
          review: {
            category: 'billing',
            priority: 'normal',
            needsReply: true,
            reviewedAt: ticket.createdAt,
          },
        },
        0.99,
      ),
    ).toBe('ready');
  });
  it('keeps resolved tickets resolved even if the threshold changes', () => {
    expect(
      getStage(
        { ...applyDecision(ticket, demoDecision(input)), resolvedAt: ticket.createdAt },
        0.99,
      ),
    ).toBe('resolved');
  });
  it.each([
    [0.49, 'low'],
    [0.5, 'normal'],
    [1.49, 'normal'],
    [1.5, 'high'],
    [2.49, 'high'],
    [2.5, 'urgent'],
  ] as const)('maps score %s to %s', (score, expected) => {
    expect(priorityFromScore(score)).toBe(expected);
  });
});

describe('data boundaries', () => {
  it('validates seeded offline decisions and their distribution', () => {
    const seeds = createSeedTickets();
    expect(seeds).toHaveLength(8);
    for (const seed of seeds) {
      if (seed.decision) {
        expect(decisionSchema.safeParse(seed.decision).success).toBe(true);
        const expectedScore = Object.entries(seed.decision.urgencyProbabilities).reduce(
          (sum, [bin, probability]) => sum + +bin * probability,
          0,
        );
        expect(expectedScore).toBeCloseTo(seed.decision.urgency);
      }
    }
    expect(new Set(seeds.map((t) => getStage(t, 0.8)))).toEqual(
      new Set(['new', 'review', 'ready', 'resolved']),
    );
  });
  it('rejects malformed distributions and nonfinite confidence', () => {
    const d = demoDecision(input);
    expect(decisionSchema.safeParse({ ...d, categoryConfidence: NaN }).success).toBe(false);
    expect(
      decisionSchema.safeParse({
        ...d,
        categoryProbabilities: { ...d.categoryProbabilities, billing: 0.1 },
      }).success,
    ).toBe(false);
    expect(decisionSchema.safeParse({ ...d, categoryProbabilities: { billing: 1 } }).success).toBe(
      false,
    );
  });
  it('bounds input and trims whitespace', () => {
    expect(ticketInputSchema.safeParse({ ...input, subject: '   ' }).success).toBe(false);
    expect(ticketInputSchema.safeParse({ ...input, body: 'a'.repeat(6001) }).success).toBe(false);
    expect(ticketInputSchema.parse({ ...input, subject: ' hello ' }).subject).toBe('hello');
  });
  it('rejects duplicate IDs and unsupported backup versions', () => {
    expect(() => parseWorkspace({ version: 1, tickets: [ticket, ticket], threshold: 0.8 })).toThrow(
      '重複',
    );
    expect(() => parseWorkspace({ version: 2, tickets: [ticket], threshold: 0.8 })).toThrow();
  });
  it('strips unrelated imported fields including keys', () => {
    expect(
      parseWorkspace({
        version: 1,
        tickets: [ticket],
        threshold: 0.8,
        apiKey: 'not-a-real-secret',
      }),
    ).not.toHaveProperty('apiKey');
  });
  it('keeps only 50 history events and resets decisions on reevaluation', () => {
    let t = ticket;
    for (let i = 0; i < 60; i++) t = withHistory(t, String(i));
    expect(t.history).toHaveLength(50);
    expect(t.history[0].text).toBe('10');
    const result = applyDecision({ ...t, resolvedAt: ticket.createdAt }, demoDecision(input));
    expect(result.resolvedAt).toBeUndefined();
    expect(result.history).toHaveLength(50);
  });
  it('escapes CSV commas, quotes, line breaks and formula triggers', () => {
    const csv = toCsv(
      [{ ...ticket, subject: '=HYPERLINK("x")', sender: 'a,b', body: 'first\nsecond' }],
      0.8,
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"first\nsecond"');
  });
});
