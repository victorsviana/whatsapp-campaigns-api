import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { closeDatabase, db } from '../../../src/database/client';
import { campaigns } from '../../../src/database/schema';

describe('POST /campaigns', () => {
  const app = createApp();

  afterAll(async () => {
    await closeDatabase();
  });

  it('CMP-01: cria a campanha em draft com as variáveis extraídas do template', async () => {
    const response = await request(app)
      .post('/campaigns')
      .send({ name: 'Entrega novembro', template: 'Olá {{nome}}, seu pedido {{ pedido }} saiu. {{nome}}!' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      name: 'Entrega novembro',
      template: 'Olá {{nome}}, seu pedido {{ pedido }} saiu. {{nome}}!',
      variables: ['nome', 'pedido'],
      status: 'draft',
      created_at: expect.any(String),
    });
    expect(new Date(response.body.created_at).toISOString()).toBe(response.body.created_at);

    const [stored] = await db.select().from(campaigns).where(eq(campaigns.id, response.body.id));
    expect(stored).toMatchObject({
      name: 'Entrega novembro',
      variables: ['nome', 'pedido'],
      status: 'draft',
      rejectedContacts: 0,
      startedAt: null,
      completedAt: null,
    });
  });

  it('CMP-03: template sem variáveis cria a campanha com variables vazia', async () => {
    const response = await request(app)
      .post('/campaigns')
      .send({ name: 'Aviso fixo', template: 'Sua entrega saiu hoje.' });

    expect(response.status).toBe(201);
    expect(response.body.variables).toEqual([]);
  });

  it('remove espaços das pontas do nome', async () => {
    const response = await request(app)
      .post('/campaigns')
      .send({ name: '  Entrega dezembro  ', template: 'Oi {{nome}}' });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Entrega dezembro');
  });

  it('aceita template com exatamente 4096 caracteres', async () => {
    const response = await request(app)
      .post('/campaigns')
      .send({ name: 'Longa', template: 'a'.repeat(4096) });

    expect(response.status).toBe(201);
  });

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['só espaços', '   \n  '],
    ['maior que 4096 caracteres', 'a'.repeat(4097)],
    ['que não é texto', 123],
  ])('CMP-04: template %s responde 400 validation_error', async (_case, template) => {
    const response = await request(app).post('/campaigns').send({ name: 'Campanha', template });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toEqual([{ path: 'body.template', message: expect.any(String) }]);
  });

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['só espaços', '   '],
    ['maior que 200 caracteres', 'a'.repeat(201)],
  ])('CMP-05: name %s responde 400 validation_error', async (_case, name) => {
    const response = await request(app).post('/campaigns').send({ name, template: 'Oi {{nome}}' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toEqual([{ path: 'body.name', message: expect.any(String) }]);
  });

  it('CMP-04/CMP-05: lista todos os campos inválidos de uma vez', async () => {
    const response = await request(app).post('/campaigns').send({});

    expect(response.status).toBe(400);
    expect(response.body.error.details.map((detail: { path: string }) => detail.path)).toEqual([
      'body.name',
      'body.template',
    ]);
  });

  it('responde 400 validation_error quando o body não é um objeto', async () => {
    const response = await request(app).post('/campaigns').send(['x']);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });
});
