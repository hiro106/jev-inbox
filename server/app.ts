import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { APIError, APIConnectionError, APITimeoutError } from '@typesafe-ai/sdk';
import { ZodError } from 'zod';
import path from 'node:path';
import { evaluateSchema } from '../shared/domain';
import { demoDecision } from '../shared/demo';
import { evaluateLive } from './jev';

type Options = { apiKey?: string; port?: number; live?: typeof evaluateLive; staticDir?: string };
export function createApp(options: Options = {}) {
  const app = express();
  const port = options.port ?? 8787;
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    '127.0.0.1:5173',
    'localhost:5173',
  ]);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': null, 'connect-src': ["'self'"] },
      },
    }),
  );
  app.use((req, res, next) => {
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.status(403).json({ error: 'ローカルホストからアクセスしてください。' });
      return;
    }
    if (
      req.headers.origin &&
      ![...allowedHosts].some((host) => req.headers.origin === `http://${host}`)
    ) {
      res.status(403).json({ error: '外部サイトからのリクエストは許可されていません。' });
      return;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.status(403).json({ error: '外部サイトからのリクエストは許可されていません。' });
      return;
    }
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, hasServerKey: !!options.apiKey?.trim(), model: 'jev-latest' }),
  );
  app.use(express.json({ limit: '32kb' }));
  let active = 0;
  let recent: number[] = [];
  app.post('/api/evaluate', async (req, res) => {
    const parsed = evaluateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: '入力を確認してください。件名160文字・本文6,000文字までです。' });
      return;
    }
    const { ticket, mode } = parsed.data;
    if (mode === 'demo') {
      res.json(demoDecision(ticket));
      return;
    }
    const suppliedKey = req.get('x-typesafe-api-key');
    if (suppliedKey && (suppliedKey.length > 512 || !/^[\x21-\x7e]+$/.test(suppliedKey))) {
      res.status(400).json({ error: 'APIキーの形式を確認してください。' });
      return;
    }
    const key = suppliedKey?.trim() || options.apiKey?.trim();
    if (!key) {
      res.status(401).json({ error: '設定画面でTypeSafe APIキーを入力してください。' });
      return;
    }
    const now = Date.now();
    recent = recent.filter((time) => now - time < 60_000);
    if (active >= 2 || recent.length >= 30) {
      res.status(429).json({ error: '処理が混み合っています。1分ほど待ってからお試しください。' });
      return;
    }
    recent.push(now);
    active++;
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', abort);
    try {
      const result = await (options.live ?? evaluateLive)(ticket, key, controller.signal);
      res.json(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ZodError) {
        res
          .status(502)
          .json({ error: 'Jevの応答形式を確認できませんでした。結果を保存せず停止しました。' });
        return;
      }
      if (error instanceof APITimeoutError) {
        res
          .status(504)
          .json({ error: 'Jevの応答がタイムアウトしました。しばらくしてから再試行してください。' });
        return;
      }
      if (error instanceof APIError) {
        const messages: Record<number, string> = {
          401: 'APIキーが無効です。設定画面で確認してください。',
          403: 'このAPIキーではJevを利用できません。',
          402: 'TypeSafeの残高または利用プランを確認してください。',
          429: 'TypeSafeの利用制限に達しました。しばらくお待ちください。',
        };
        res
          .status(messages[error.status] ? error.status : 502)
          .json({
            error:
              messages[error.status] ??
              'Jevが一時的に利用できません。しばらくしてから再試行してください。',
          });
        return;
      }
      res
        .status(502)
        .json({
          error:
            error instanceof APIConnectionError
              ? 'TypeSafeに接続できませんでした。ネットワークをご確認ください。'
              : '仕分けに失敗しました。結果を保存せず停止しました。',
        });
    } finally {
      active--;
      res.off('close', abort);
    }
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'APIが見つかりません。' });
  });
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(options.staticDir!, 'index.html')));
  }
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    const tooLarge = err?.type === 'entity.too.large';
    res
      .status(tooLarge ? 413 : 400)
      .json({
        error: tooLarge ? '入力サイズが大きすぎます。' : 'リクエストの形式が正しくありません。',
      });
  };
  app.use(errors);
  return app;
}
