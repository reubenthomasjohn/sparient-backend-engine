import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '@/app';

const basic = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

describe('Access Hub API foundation (TASK-01 / VALIDATION-01)', () => {
  beforeAll(() => {
    expect(process.env.ACCESS_HUB_BASIC_USER).toBe('hubuser');
    expect(process.env.ACCESS_HUB_BASIC_PASSWORD).toBe('hubpass');
  });

  it('returns 401 with error envelope when Basic auth is missing', async () => {
    const res = await request(app).get('/api/v1/access-hub/ping').expect(401);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Basic authentication',
      },
    });
    expect(res.headers['www-authenticate']).toMatch(/Basic realm="Access Hub"/);
  });

  it('returns 401 with error envelope when Basic credentials are wrong', async () => {
    const res = await request(app)
      .get('/api/v1/access-hub/ping')
      .set('Authorization', basic('hubuser', 'wrong'))
      .expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('returns success envelope for GET with valid Basic auth', async () => {
    const res = await request(app)
      .get('/api/v1/access-hub/ping')
      .set('Authorization', basic('hubuser', 'hubpass'))
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { pong: true } });
  });

  it('does not require Basic auth for /health', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns 400 error envelope for malformed JSON on POST', async () => {
    const res = await request(app)
      .post('/api/v1/access-hub/ping')
      .set('Authorization', basic('hubuser', 'hubpass'))
      .set('Content-Type', 'application/json')
      .send('{ not json')
      .expect(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' },
    });
  });

  it('returns 400 error envelope for malformed JSON on PATCH', async () => {
    const res = await request(app)
      .patch('/api/v1/access-hub/ping')
      .set('Authorization', basic('hubuser', 'hubpass'))
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' },
    });
  });
});
