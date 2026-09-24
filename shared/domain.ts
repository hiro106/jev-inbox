import { z } from 'zod';

export const categories = ['technical', 'billing', 'account', 'feature', 'other'] as const;
export type Category = (typeof categories)[number];
export const categoryLabels: Record<Category, string> = {
  technical: '不具合・技術',
  billing: '請求・契約',
  account: 'アカウント',
  feature: '機能リクエスト',
  other: 'その他',
};
export const categoryTeams: Record<Category, string> = {
  technical: 'エンジニアリング',
  billing: 'カスタマーサクセス',
  account: 'サポート',
  feature: 'プロダクト',
  other: '総合窓口',
};
export const priorities = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof priorities)[number];
export const priorityLabels: Record<Priority, string> = {
  low: '低',
  normal: '通常',
  high: '高',
  urgent: '緊急',
};
export const channels = ['メール', 'チャット', 'フォーム'] as const;
const fraction = z.number().finite().min(0).max(1);
const distribution = <T extends readonly [string, ...string[]]>(keys: T) =>
  z
    .record(z.enum(keys), fraction)
    .refine(
      (value) => Math.abs(Object.values<number>(value).reduce((a, b) => a + b, 0) - 1) < 0.02,
      '確率の合計が不正です',
    );

export const decisionSchema = z.object({
  source: z.enum(['demo', 'live']),
  model: z.string().min(1).max(120),
  category: z.enum(categories),
  categoryConfidence: fraction,
  categoryProbabilities: distribution(categories),
  urgency: z.number().finite().min(0).max(3),
  urgencyConfidence: fraction,
  urgencyProbabilities: distribution(['0', '1', '2', '3'] as const),
  needsReply: fraction,
  evaluatedAt: z.iso.datetime(),
  durationMs: z.number().int().min(0).max(600_000),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});
export type Decision = z.infer<typeof decisionSchema>;
export const ticketInputSchema = z.object({
  subject: z.string().trim().min(1, '件名を入力してください').max(160),
  body: z.string().trim().min(1, '本文を入力してください').max(6000),
  sender: z.string().trim().min(1, '差出人を入力してください').max(80),
  channel: z.enum(channels),
});
export type TicketInput = z.infer<typeof ticketInputSchema>;
const reviewSchema = z.object({
  category: z.enum(categories),
  priority: z.enum(priorities),
  needsReply: z.boolean(),
  reviewedAt: z.iso.datetime(),
});
export const ticketSchema = ticketInputSchema.extend({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  createdAt: z.iso.datetime(),
  decision: decisionSchema.optional(),
  review: reviewSchema.optional(),
  resolvedAt: z.iso.datetime().optional(),
  history: z.array(z.object({ at: z.iso.datetime(), text: z.string().max(300) })).max(50),
});
export type Ticket = z.infer<typeof ticketSchema>;
export type Stage = 'new' | 'review' | 'ready' | 'resolved';
export const stageLabels: Record<Stage, string> = {
  new: '未仕分け',
  review: '要確認',
  ready: '対応待ち',
  resolved: '対応済み',
};
export const thresholdSchema = z.number().min(0.5).max(0.99);
export const workspaceSchema = z.object({
  version: z.literal(1),
  tickets: z.array(ticketSchema).max(200),
  threshold: thresholdSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const evaluateSchema = z.object({
  mode: z.enum(['demo', 'live']),
  ticket: ticketInputSchema,
});

export function priorityFromScore(score: number): Priority {
  return score >= 2.5 ? 'urgent' : score >= 1.5 ? 'high' : score >= 0.5 ? 'normal' : 'low';
}
export function reviewReasons(decision: Decision, threshold: number): string[] {
  const reasons: string[] = [];
  if (decision.categoryConfidence < threshold) reasons.push('分類の確信度が基準未満');
  if (decision.urgencyConfidence < threshold) reasons.push('優先度の確信度が基準未満');
  if (decision.category === 'other') reasons.push('担当分野を特定できません');
  if (decision.urgency >= 2.5) reasons.push('緊急度が高いため、人の確認が必要');
  if (decision.needsReply > 0.35 && decision.needsReply < 0.65) reasons.push('返信の要否が曖昧');
  return reasons;
}
export function getStage(ticket: Ticket, threshold: number): Stage {
  if (ticket.resolvedAt) return 'resolved';
  if (ticket.review) return 'ready';
  if (!ticket.decision) return 'new';
  return reviewReasons(ticket.decision, threshold).length ? 'review' : 'ready';
}
export function getCategory(ticket: Ticket): Category | undefined {
  return ticket.review?.category ?? ticket.decision?.category;
}
export function getPriority(ticket: Ticket): Priority | undefined {
  return (
    ticket.review?.priority ??
    (ticket.decision ? priorityFromScore(ticket.decision.urgency) : undefined)
  );
}
export function withHistory(ticket: Ticket, text: string): Ticket {
  return {
    ...ticket,
    history: [...ticket.history, { at: new Date().toISOString(), text }].slice(-50),
  };
}
export function applyDecision(ticket: Ticket, decision: Decision): Ticket {
  return withHistory(
    { ...ticket, decision, review: undefined, resolvedAt: undefined },
    `${decision.source === 'demo' ? 'デモ' : 'Jev'}で仕分け：${categoryLabels[decision.category]}`,
  );
}
export function parseWorkspace(value: unknown): Workspace {
  const workspace = workspaceSchema.parse(value);
  if (new Set(workspace.tickets.map((t) => t.id)).size !== workspace.tickets.length)
    throw new Error('問い合わせIDが重複しています');
  return workspace;
}

export function toCsv(tickets: Ticket[], threshold: number): string {
  // Quoting alone does not stop spreadsheet formula execution.
  const cell = (value: string) =>
    `"${(/^[\s]*[=+@-]/.test(value) ? "'" : '') + value.replaceAll('"', '""')}"`;
  const rows = [
    [
      'ID',
      '件名',
      '差出人',
      'チャネル',
      '分類',
      '優先度',
      'ステータス',
      '判定元',
      '分類確信度',
      '本文',
    ],
    ...tickets.map((t) => [
      t.id,
      t.subject,
      t.sender,
      t.channel,
      getCategory(t) ? categoryLabels[getCategory(t)!] : '',
      getPriority(t) ? priorityLabels[getPriority(t)!] : '',
      stageLabels[getStage(t, threshold)],
      t.decision?.source ?? '',
      t.decision ? String(t.decision.categoryConfidence) : '',
      t.body,
    ]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
}
