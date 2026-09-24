import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { demoDecision } from '../shared/demo';

const ticket = {
  subject: '請求書',
  body: '請求書が必要です。',
  sender: 'テスト',
  channel: 'メール',
} as const;
const host = '127.0.0.1:8787';

describe('local API', () => {
  it('returns health without revealing a server key', async () => {
    const res = await request(createApp({ apiKey: 'test-secret' }))
      .get('/api/health')
      .set('Host', host);
    expect(res.status).toBe(200);
    expect(res.body.hasServerKey).toBe(true);
    expect(res.text).not.toContain('test-secret');
    expect(res.headers['cache-control']).toBe('no-store');
  });
  it('performs a demo without calling the provider', async () => {
    const live = vi.fn();
    const res = await request(createApp({ live }))
      .post('/api/evaluate')
      .set('Host', host)
      .send({ mode: 'demo', ticket });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('demo');
    expect(live).not.toHaveBeenCalled();
  });
  it('refuses a missing key instead of falling back to simulation', async () => {
    const res = await request(createApp())
      .post('/api/evaluate')
      .set('Host', host)
      .send({ mode: 'live', ticket });
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('source');
  });
  it('uses a transient key ahead of the environment key', async () => {
    const decision = { ...demoDecision(ticket), source: 'live' as const };
    const live = vi.fn().mockResolvedValue(decision);
    const res = await request(createApp({ apiKey: 'server-test-key', live }))
      .post('/api/evaluate')
      .set('Host', host)
      .set('x-typesafe-api-key', 'transient-test-key')
      .send({ mode: 'live', ticket });
    expect(res.status).toBe(200);
    expect(live.mock.calls[0][1]).toBe('transient-test-key');
    expect(res.text).not.toContain('test-key');
  });
  it.each(['https://evil.example', 'http://127.0.0.1:9999', 'http://127.0.0.1:8787.evil.example'])(
    'rejects cross-origin %s',
    async (origin) => {
      const res = await request(createApp())
        .post('/api/evaluate')
        .set('Host', host)
        .set('Origin', origin)
        .send({ mode: 'demo', ticket });
      expect(res.status).toBe(403);
    },
  );
  it('rejects DNS rebinding hostnames', async () => {
    expect(
      (await request(createApp()).get('/api/health').set('Host', 'attacker.example:8787')).status,
    ).toBe(403);
  });
  it('accepts the local frontend origin', async () => {
    expect(
      (
        await request(createApp())
          .post('/api/evaluate')
          .set('Host', host)
          .set('Origin', 'http://127.0.0.1:5173')
          .send({ mode: 'demo', ticket })
      ).status,
    ).toBe(200);
  });
  it('rejects malformed and oversized input before the provider runs', async () => {
    const live = vi.fn();
    const app = createApp({ live });
    expect(
      (
        await request(app)
          .post('/api/evaluate')
          .set('Host', host)
          .send({ mode: 'live', ticket: { ...ticket, body: 'a'.repeat(6001) } })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/evaluate')
          .set('Host', host)
          .send({ mode: 'live', ticket: { ...ticket, body: 'a'.repeat(40000) } })
      ).status,
    ).toBe(413);
    expect(live).not.toHaveBeenCalled();
  });
  it('handles invalid JSON without exposing parser internals', async () => {
    const res = await request(createApp())
      .post('/api/evaluate')
      .set('Host', host)
      .set('Content-Type', 'application/json')
      .send('{broken');
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('SyntaxError');
  });
  it('does not leak provider exceptions', async () => {
    const live = vi
      .fn()
      .mockRejectedValue(new Error('secret: test-secret and private customer content'));
    const res = await request(createApp({ apiKey: 'test-secret', live }))
      .post('/api/evaluate')
      .set('Host', host)
      .send({ mode: 'live', ticket });
    expect(res.status).toBe(502);
    expect(res.text).not.toContain('test-secret');
    expect(res.text).not.toContain('customer');
  });
  it('bounds paid requests within a minute', async () => {
    const live = vi.fn().mockResolvedValue({ ...demoDecision(ticket), source: 'live' });
    const app = createApp({ live, apiKey: 'test-key' });
    for (let i = 0; i < 30; i++)
      expect(
        (await request(app).post('/api/evaluate').set('Host', host).send({ mode: 'live', ticket }))
          .status,
      ).toBe(200);
    expect(
      (await request(app).post('/api/evaluate').set('Host', host).send({ mode: 'live', ticket }))
        .status,
    ).toBe(429);
    expect(live).toHaveBeenCalledTimes(30);
  });
});
