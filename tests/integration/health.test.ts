import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';

describe('GET /health', () => {
  const app = createApp();

  it('responde 200 com status ok', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('não expõe o header x-powered-by', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('responde 404 route_not_found no formato padrão de erro para rota inexistente', async () => {
    const response = await request(app).get('/rota-inexistente');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'route_not_found', message: 'Route GET /rota-inexistente not found' },
    });
  });

  it('responde 400 invalid_json quando o body não é um JSON válido', async () => {
    const response = await request(app)
      .post('/health')
      .set('content-type', 'application/json')
      .send('{"name":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_json');
  });
});
