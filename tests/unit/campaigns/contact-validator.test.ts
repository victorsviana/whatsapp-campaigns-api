import { describe, expect, it } from 'vitest';
import { normalizePhone, validateContacts } from '../../../src/modules/campaigns/contact-validator';

describe('normalizePhone', () => {
  it('CMP-08: aceita celular com parênteses, espaço e hífen', () => {
    expect(normalizePhone('(11) 98765-4321')).toEqual({ ok: true, phone: '+5511987654321' });
  });

  it('CMP-09: aceita celular já com DDI e +', () => {
    expect(normalizePhone('+55 11 98765-4321')).toEqual({ ok: true, phone: '+5511987654321' });
  });

  it('CMP-10: remove o zero de discagem à esquerda', () => {
    expect(normalizePhone('011 98765-4321')).toEqual({ ok: true, phone: '+5511987654321' });
  });

  it('CMP-11: aceita fixo com 8 dígitos depois do DDD', () => {
    expect(normalizePhone('1133334444')).toEqual({ ok: true, phone: '+551133334444' });
  });

  it('CMP-11: aceita DDD 55 sem confundir com o DDI', () => {
    expect(normalizePhone('55 3333-4444')).toEqual({ ok: true, phone: '+555533334444' });
  });

  it.each([
    ['curto demais', '123'],
    ['sem dígitos', 'abc'],
    ['9 dígitos sem começar com 9', '11887654321'],
    ['DDD com zero', '0198765432'],
    ['estrangeiro', '+1 415 555 0100'],
    ['DDI 55 com dígitos sobrando', '+55 11 98765-43210'],
  ])('CMP-12: rejeita telefone inválido (%s)', (_case, input) => {
    expect(normalizePhone(input)).toEqual({ ok: false, reason: 'invalid_phone' });
  });

  it.each([
    ['ausente', undefined],
    ['null', null],
    ['vazio', ''],
    ['só espaços', '   '],
  ])('CMP-13: telefone %s é missing_phone', (_case, input) => {
    expect(normalizePhone(input)).toEqual({ ok: false, reason: 'missing_phone' });
  });

  it('aceita telefone enviado como número pela planilha', () => {
    expect(normalizePhone(11987654321)).toEqual({ ok: true, phone: '+5511987654321' });
  });

  it.each([
    ['booleano', true],
    ['objeto', { numero: '11987654321' }],
    ['lista', ['11987654321']],
  ])('rejeita telefone de tipo %s como invalid_phone', (_case, input) => {
    expect(normalizePhone(input)).toEqual({ ok: false, reason: 'invalid_phone' });
  });
});

describe('validateContacts', () => {
  const variables = ['nome', 'pedido'];

  it('CMP-14: variável ausente, vazia, só espaços, null ou objeto conta como faltando', () => {
    const result = validateContacts(
      [
        { phone: '11987650001', variables: { nome: 'Ana' } },
        { phone: '11987650002', variables: { nome: 'Bia', pedido: '' } },
        { phone: '11987650003', variables: { nome: 'Caio', pedido: '   ' } },
        { phone: '11987650004', variables: { nome: 'Duda', pedido: null } },
        { phone: '11987650005', variables: { nome: 'Edu', pedido: {} } },
        { phone: '11987650006', variables: { nome: 'Fê', pedido: ['A-1'] } },
        { phone: '11987650007', variables: { nome: 'Gui', pedido: true } },
      ],
      variables,
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((index) => ({
        index,
        phone: `1198765000${index + 1}`,
        reason: 'missing_variables',
        missing: ['pedido'],
      })),
    );
  });

  it('CMP-14: lista todas as variáveis faltando na ordem do template', () => {
    const result = validateContacts([{ phone: '11987654321' }], variables);

    expect(result.rejected).toEqual([
      { index: 0, phone: '11987654321', reason: 'missing_variables', missing: ['nome', 'pedido'] },
    ]);
  });

  it('CMP-15: ignora variáveis extras e converte números para texto', () => {
    const result = validateContacts(
      [{ phone: '(11) 98765-4321', variables: { nome: 'Ana', pedido: 1234, extra: 'x' } }],
      variables,
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([{ phone: '+5511987654321', variables: { nome: 'Ana', pedido: '1234' } }]);
  });

  it('CMP-16: mesmo telefone em formatos diferentes no lote é duplicate_phone', () => {
    const result = validateContacts(
      [
        { phone: '(11) 98765-4321', variables: { nome: 'Ana', pedido: 'A-1' } },
        { phone: '+55 11 98765-4321', variables: { nome: 'Ana', pedido: 'A-2' } },
      ],
      variables,
    );

    expect(result.accepted).toEqual([{ phone: '+5511987654321', variables: { nome: 'Ana', pedido: 'A-1' } }]);
    expect(result.rejected).toEqual([{ index: 1, phone: '+55 11 98765-4321', reason: 'duplicate_phone' }]);
  });

  it('CMP-17: telefone aceito em lote anterior é duplicate_phone', () => {
    const existing = new Set(['+5511987654321']);
    const result = validateContacts(
      [{ phone: '011 98765-4321', variables: { nome: 'Ana', pedido: 'A-1' } }],
      variables,
      existing,
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, phone: '011 98765-4321', reason: 'duplicate_phone' }]);
    expect(existing).toEqual(new Set(['+5511987654321']));
  });

  it('CMP-18: linha rejeitada por variável não bloqueia a próxima com o mesmo telefone', () => {
    const result = validateContacts(
      [
        { phone: '11987654321', variables: { nome: 'Ana' } },
        { phone: '11987654321', variables: { nome: 'Ana', pedido: 'A-1' } },
      ],
      variables,
    );

    expect(result.rejected).toEqual([
      { index: 0, phone: '11987654321', reason: 'missing_variables', missing: ['pedido'] },
    ]);
    expect(result.accepted).toEqual([{ phone: '+5511987654321', variables: { nome: 'Ana', pedido: 'A-1' } }]);
  });

  it('CMP-13: telefone ausente é missing_phone com phone null', () => {
    const result = validateContacts([{ variables: { nome: 'Ana', pedido: 'A-1' } }], variables);

    expect(result.rejected).toEqual([{ index: 0, phone: null, reason: 'missing_phone' }]);
  });

  it('R10: telefone é avaliado antes das variáveis', () => {
    const result = validateContacts([{ phone: '123' }], variables);

    expect(result.rejected).toEqual([{ index: 0, phone: '123', reason: 'invalid_phone' }]);
  });

  it('CMP-19: lote misto separa aceitos e rejeitados com index e motivo', () => {
    const result = validateContacts(
      [
        { phone: '(11) 98765-4321', variables: { nome: 'Ana', pedido: 'A-100' } },
        { phone: '11 98765-4321', variables: { nome: 'Ana', pedido: 'A-100' } },
        { phone: '123', variables: { nome: 'Bia', pedido: 'B-200' } },
        { phone: '21987650000', variables: { nome: 'Caio' } },
        { variables: { nome: 'Duda', pedido: 'D-400' } },
      ],
      variables,
    );

    expect(result.accepted).toEqual([
      { phone: '+5511987654321', variables: { nome: 'Ana', pedido: 'A-100' } },
    ]);
    expect(result.rejected).toEqual([
      { index: 1, phone: '11 98765-4321', reason: 'duplicate_phone' },
      { index: 2, phone: '123', reason: 'invalid_phone' },
      { index: 3, phone: '21987650000', reason: 'missing_variables', missing: ['pedido'] },
      { index: 4, phone: null, reason: 'missing_phone' },
    ]);
  });

  it('CMP-03: template sem variáveis aceita contato só com telefone', () => {
    const result = validateContacts([{ phone: '11987654321' }], []);

    expect(result.accepted).toEqual([{ phone: '+5511987654321', variables: {} }]);
  });
});
