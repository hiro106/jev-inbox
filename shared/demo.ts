import {
  type Decision,
  type Ticket,
  type TicketInput,
  type Category,
  categories,
  applyDecision,
} from './domain';

// Deliberately simple, deterministic offline simulation. These are NOT Jev predictions.
export function demoDecision(ticket: TicketInput, now = new Date().toISOString()): Decision {
  const text = `${ticket.subject}\n${ticket.body}`.toLowerCase();
  const patterns: Record<Category, RegExp> = {
    technical: /不具合|エラー|障害|動か|止ま|停止|500|error|bug|outage|読み込|表示され/,
    billing: /請求|支払|返金|契約|料金|二重|プラン|invoice|billing|refund/,
    account: /ログイン|パスワード|認証|アカウント|招待|login|password|account/,
    feature: /機能|追加|要望|対応して|ほしい|欲しい|feature|request/,
    other: /相談|ありがとう|確認したい/,
  };
  const matches = categories.filter(
    (category) => category !== 'other' && patterns[category].test(text),
  );
  const category: Category = matches[0] ?? 'other';
  const ambiguous = matches.length > 1 || category === 'other';
  const confidence = ambiguous ? 0.61 : 0.94;
  const probabilities = Object.fromEntries(
    categories.map((c) => [c, c === category ? confidence : (1 - confidence) / 4]),
  ) as Decision['categoryProbabilities'];
  const urgency = /全員|全社|本番|停止|至急|緊急|outage|urgent/.test(text)
    ? 2.85
    : /二重|返金|できない|できません|明日/.test(text)
      ? 2.05
      : /ありがとう|急ぎません/.test(text)
        ? 0.15
        : 1.05;
  const low = Math.floor(urgency);
  const high = Math.ceil(urgency);
  return {
    source: 'demo',
    model: 'offline-rules-v1',
    category,
    categoryConfidence: confidence,
    categoryProbabilities: probabilities,
    urgency,
    urgencyConfidence: ambiguous ? 0.73 : 0.92,
    urgencyProbabilities: Object.fromEntries(
      ['0', '1', '2', '3'].map((i) => [
        i,
        +i === low ? high - urgency : +i === high ? urgency - low : 0,
      ]),
    ) as Decision['urgencyProbabilities'],
    needsReply: /ありがとう|解決しました/.test(text) ? 0.08 : ambiguous ? 0.58 : 0.96,
    evaluatedAt: now,
    durationMs: 0,
  };
}

export function createSeedTickets(): Ticket[] {
  const data: Array<TicketInput & { classified?: boolean }> = [
    {
      sender: '山田 美咲',
      channel: 'メール',
      subject: '今月の請求が二重になっています',
      body: 'お世話になっております。9月分の利用料金が、同じクレジットカードに2回請求されていました。明細をご確認いただき、重複分の返金をお願いできますでしょうか。',
      classified: true,
    },
    {
      sender: '佐藤 健太',
      channel: 'チャット',
      subject: '本番環境で500エラーが発生しています',
      body: '本日10時頃から管理画面にアクセスすると500エラーが表示され、全員が業務を進められない状況です。至急ご確認をお願いします。',
      classified: true,
    },
    {
      sender: '鈴木 遥',
      channel: 'フォーム',
      subject: 'CSVでレポートを出力したい',
      body: '毎月のレポートにCSV出力機能を追加してほしいです。現在は画面から手動でコピーしています。急ぎませんが、ご検討いただけるとうれしいです。',
      classified: true,
    },
    {
      sender: '高橋 蓮',
      channel: 'メール',
      subject: 'プランの変更とメンバー招待について',
      body: '契約プランを変更した場合、メンバーの招待上限も変わりますか？ アカウントの設定で対応できるのか、料金の相談が必要なのか確認したいです。',
      classified: true,
    },
    {
      sender: '伊藤 葵',
      channel: 'チャット',
      subject: 'パスワードの再設定メールが届きません',
      body: '昨日からログインできません。パスワードの再設定を3回試しましたが、メールが届きません。迷惑メールフォルダも確認済みです。',
    },
    {
      sender: '渡辺 悠',
      channel: 'フォーム',
      subject: 'ダークモードの追加をお願いします',
      body: '夜間に使用することが多いため、ダークモード機能がほしいです。設定画面から切り替えられるとうれしいです。',
    },
    {
      sender: '小林 凛',
      channel: 'メール',
      subject: '年間契約への切り替えについて',
      body: '現在の月額プランから年間契約への切り替えを検討しています。料金と手続きについて教えてください。',
    },
    {
      sender: '中村 湊',
      channel: 'メール',
      subject: '迅速なご対応ありがとうございました',
      body: '先日お問い合わせした件は、無事に解決しました。丁寧にご案内いただき、ありがとうございました。',
      classified: true,
    },
  ];
  const base = Date.now();
  return data.map(({ classified, ...input }, index) => {
    const at = new Date(base - (index + 1) * 36 * 60_000).toISOString();
    const ticket: Ticket = {
      ...input,
      id: `sample-${index + 1}`,
      createdAt: at,
      history: [{ at, text: '架空のサンプル問い合わせを追加' }],
    };
    const result = classified ? applyDecision(ticket, demoDecision(input, at)) : ticket;
    return index === 7 ? { ...result, resolvedAt: at } : result;
  });
}
