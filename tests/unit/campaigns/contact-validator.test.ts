import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../../../src/modules/campaigns/contact-validator';

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
