import { describe, expect, it } from 'vitest';
import { extractVariables, renderTemplate } from '../../../src/modules/campaigns/template';

describe('extractVariables', () => {
  it('CMP-02: extrai as variáveis tolerando espaços e sem repetição', () => {
    expect(extractVariables('Oi {{ nome }}, {{nome}} e {{pedido}}')).toEqual(['nome', 'pedido']);
  });

  it('CMP-02: mantém a ordem da primeira aparição', () => {
    expect(extractVariables('{{pedido}} para {{nome}}, pedido {{pedido}}')).toEqual(['pedido', 'nome']);
  });

  it('CMP-02: aceita nomes com _ e números depois da primeira letra', () => {
    expect(extractVariables('{{_id}} {{pedido_id}} {{item2}}')).toEqual(['_id', 'pedido_id', 'item2']);
  });

  it('CMP-03: template sem variáveis retorna lista vazia', () => {
    expect(extractVariables('Sua entrega saiu hoje.')).toEqual([]);
  });

  it('CMP-07: ignora o que não segue o formato de variável', () => {
    expect(extractVariables('{{1abc}} {{ }} {{nome-completo}} {nome} {{nome}}')).toEqual(['nome']);
  });
});

describe('renderTemplate', () => {
  it('CMP-06: substitui as variáveis, tolerando espaços e convertendo números para texto', () => {
    expect(renderTemplate('Olá {{nome}}, pedido {{ pedido }}', { nome: 'Ana', pedido: 123 })).toBe(
      'Olá Ana, pedido 123',
    );
  });

  it('CMP-06: substitui todas as ocorrências da mesma variável', () => {
    expect(renderTemplate('{{nome}}, {{ nome }}!', { nome: 'Ana' })).toBe('Ana, Ana!');
  });

  it('CMP-07: mantém igual o que não é variável', () => {
    expect(renderTemplate('{{1abc}} e {{ }} para {{nome}}', { nome: 'Ana' })).toBe('{{1abc}} e {{ }} para Ana');
  });

  it('insere o valor literalmente, sem interpretar padrões especiais como $&', () => {
    expect(renderTemplate('Total: {{valor}}', { valor: 'R$ 10 $& $1' })).toBe('Total: R$ 10 $& $1');
  });

  it('mantém o marcador quando a variável não foi informada', () => {
    expect(renderTemplate('Olá {{nome}}, pedido {{pedido}}', { nome: 'Ana' })).toBe('Olá Ana, pedido {{pedido}}');
  });
});
