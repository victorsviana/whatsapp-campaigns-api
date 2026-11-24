# Spec 01: Campanhas e contatos

## Objetivo

Permitir que a empresa crie uma campanha (nome + template) e cadastre os contatos dela, recebendo de volta quais contatos foram aceitos e quais foram rejeitados, com o motivo de cada rejeição.

## Fluxo

```
POST /campaigns                      → cria a campanha em draft (sem contatos)
POST /campaigns/:id/contacts         → cadastra um lote de contatos (pode ser chamado várias vezes)
POST /campaigns/:id/start            → spec 02
```

Criar a campanha e cadastrar os contatos são rotas separadas porque uma planilha com milhares de linhas pode ser enviada em vários lotes.

## Regras

### Template

- **R1.** O template é obrigatório e não pode ser vazio (depois de remover espaços das pontas). Tamanho máximo: 4096 caracteres, o limite de texto do WhatsApp.
- **R2.** Uma variável tem o formato `{{nome}}`. Espaços dentro das chaves são tolerados: `{{ nome }}` equivale a `{{nome}}`.
- **R3.** O nome da variável começa com letra ou `_` e depois aceita letras, números e `_` (ex.: `nome`, `pedido_id`). O que não seguir esse formato é texto comum, e não variável.
- **R4.** O template pode ter zero variáveis (mensagem fixa). A mesma variável pode aparecer mais de uma vez.
- **R5.** A lista de variáveis da campanha é extraída do template na criação, sem repetição.

### Contatos

Cada contato chega como `{ "phone": "...", "variables": { "nome": "...", ... } }`.

- **R6. Normalização do telefone.** Antes de validar:
  1. remove tudo que não for dígito (espaços, `(`, `)`, `-`, `+`, `.`);
  2. remove zeros à esquerda (prefixo de discagem, ex.: `011...`);
  3. se sobrarem 10 ou 11 dígitos (DDD + número), adiciona o DDI `55` na frente.
- **R7. Telefone válido.** Depois de normalizado, o telefone é válido se:
  - começa com `55`;
  - o DDD (2 dígitos após o `55`) está entre 11 e 99, sem zero em nenhum dos dígitos;
  - o número após o DDD tem 8 dígitos (fixo) ou 9 dígitos começando com `9` (celular).

  O valor gravado é o formato E.164: `+` seguido dos dígitos, ex.: `+5511987654321`.
- **R8. Variáveis.** Toda variável do template precisa ter valor no contato. Valor ausente, `null` ou texto vazio (depois de remover espaços) conta como faltando. Números são aceitos e convertidos para texto (planilhas costumam mandar `pedido: 1234`). Outros tipos (objeto, lista, booleano) contam como faltando. Variáveis extras, que não estão no template, são ignoradas.
- **R9. Duplicados.** Dois contatos com o mesmo telefone **normalizado** na mesma campanha são duplicados. Vale dentro do mesmo lote e entre lotes diferentes. O primeiro aceito fica; os seguintes são rejeitados.
- **R10. Ordem da validação.** Cada contato é avaliado nesta ordem, e o primeiro problema encontrado é o motivo da rejeição:
  1. telefone ausente → `missing_phone`
  2. telefone inválido → `invalid_phone`
  3. variável faltando → `missing_variables` (com a lista das que faltam)
  4. telefone já aceito → `duplicate_phone`

  A duplicidade só é verificada contra contatos **aceitos**. Se a primeira linha de um telefone foi rejeitada por variável faltando, uma linha seguinte, completa, com o mesmo telefone é aceita.
- **R11. Rejeição não derruba o lote.** Contatos inválidos não impedem o cadastro dos válidos. A resposta diz quantos foram aceitos e lista os rejeitados.
- **R12. Só em `draft`.** Contatos só podem ser cadastrados em campanha `draft`.
- **R13. Gravação atômica.** Os contatos aceitos de um lote são gravados numa única transação: ou todos entram, ou nenhum entra (em caso de erro inesperado).
- **R14. Limite por lote.** Até 10.000 contatos por requisição. Acima disso, a requisição inteira é recusada e o cliente deve dividir em lotes.
- **R15. Contagem de rejeitados.** A campanha guarda o total acumulado de contatos rejeitados, que aparece no relatório (spec 04). O detalhe de cada rejeição é devolvido só na resposta do cadastro.

## Contrato da API

### `POST /campaigns`

Request:
```json
{
  "name": "Entrega novembro",
  "template": "Olá {{nome}}, seu pedido {{pedido}} saiu para entrega."
}
```

Response `201 Created`:
```json
{
  "id": "6f1c...-uuid",
  "name": "Entrega novembro",
  "template": "Olá {{nome}}, seu pedido {{pedido}} saiu para entrega.",
  "variables": ["nome", "pedido"],
  "status": "draft",
  "created_at": "2026-11-24T12:00:00.000Z"
}
```

Erros:
| Status | `code` | Quando |
|---|---|---|
| 400 | `validation_error` | `name` ausente/vazio ou maior que 200 caracteres; `template` ausente, vazio ou maior que 4096 caracteres |

### `POST /campaigns/:id/contacts`

Request:
```json
{
  "contacts": [
    { "phone": "(11) 98765-4321", "variables": { "nome": "Ana", "pedido": "A-100" } },
    { "phone": "11 98765-4321",   "variables": { "nome": "Ana", "pedido": "A-100" } },
    { "phone": "123",             "variables": { "nome": "Bia", "pedido": "B-200" } },
    { "phone": "21987650000",     "variables": { "nome": "Caio" } },
    {                             "variables": { "nome": "Duda", "pedido": "D-400" } }
  ]
}
```

Response `200 OK`:
```json
{
  "accepted": 1,
  "rejected": [
    { "index": 1, "phone": "11 98765-4321", "reason": "duplicate_phone" },
    { "index": 2, "phone": "123",           "reason": "invalid_phone" },
    { "index": 3, "phone": "21987650000",   "reason": "missing_variables", "missing": ["pedido"] },
    { "index": 4, "phone": null,            "reason": "missing_phone" }
  ]
}
```

- `index` é a posição do contato no array enviado, para o cliente localizar a linha na planilha.
- `phone` é o valor **como veio**, não o normalizado.

Erros:
| Status | `code` | Quando |
|---|---|---|
| 400 | `validation_error` | `contacts` ausente, vazio, não é lista, ou tem mais de 10.000 itens |
| 404 | `campaign_not_found` | Campanha não existe |
| 409 | `campaign_not_draft` | Campanha não está em `draft` |

Formato de erro (comum a toda a API):
```json
{ "error": { "code": "campaign_not_draft", "message": "Contacts can only be added to draft campaigns" } }
```

## Premissas

- Telefones são do Brasil (spec 00). Números estrangeiros são rejeitados como `invalid_phone`.
- Não verificamos se o número existe no WhatsApp. Isso só se descobre no envio (ex.: o provedor responde `400 invalid_number` para finais `0000`).
- Não há edição nem remoção de contatos nem da campanha.
- Lote em que **todos** os contatos são rejeitados ainda responde `200`, com `accepted: 0`. A requisição foi processada; o problema está nos dados.

## Critérios de aceite

### Criação da campanha

| ID | Dado | Quando | Então |
|---|---|---|---|
| CMP-01 | nome e template válidos | `POST /campaigns` | `201`, status `draft`, `variables` extraídas do template |
| CMP-02 | template `Oi {{ nome }}, {{nome}} e {{pedido}}` | extrair variáveis | `["nome", "pedido"]` (espaços tolerados, sem repetição) |
| CMP-03 | template sem variáveis | `POST /campaigns` | `201` com `variables: []` |
| CMP-04 | template vazio, só espaços ou maior que 4096 caracteres | `POST /campaigns` | `400 validation_error` |
| CMP-05 | `name` ausente | `POST /campaigns` | `400 validation_error` |

### Renderização do template

| ID | Dado | Quando | Então |
|---|---|---|---|
| CMP-06 | template `Olá {{nome}}, pedido {{ pedido }}` e variáveis `{nome: "Ana", pedido: 123}` | renderizar | `Olá Ana, pedido 123` |
| CMP-07 | template com `{{1abc}}` ou `{{ }}` | extrair/renderizar | tratado como texto comum, mantido igual |

### Normalização e validação do telefone

| ID | Entrada | Resultado |
|---|---|---|
| CMP-08 | `(11) 98765-4321` | válido, `+5511987654321` |
| CMP-09 | `+55 11 98765-4321` | válido, `+5511987654321` |
| CMP-10 | `011 98765-4321` | válido, `+5511987654321` (zero à esquerda removido) |
| CMP-11 | `1133334444` (fixo, 8 dígitos) | válido, `+551133334444` |
| CMP-12 | `123`, `abc`, `11887654321` (9 dígitos sem começar com 9), `0198765432` (DDD com zero), `+1 415 555 0100` (estrangeiro) | `invalid_phone` |
| CMP-13 | `phone` ausente, `null` ou só espaços | `missing_phone` |

### Validação do contato e do lote

| ID | Dado | Quando | Então |
|---|---|---|---|
| CMP-14 | contato sem `pedido`, ou com `pedido: ""`, `null` ou `{}` | validar | `missing_variables` com `missing: ["pedido"]` |
| CMP-15 | contato com variável extra não usada no template | validar | aceito, variável extra ignorada |
| CMP-16 | dois contatos no mesmo lote com o mesmo telefone em formatos diferentes | cadastrar | o primeiro é aceito, o segundo é `duplicate_phone` |
| CMP-17 | telefone já aceito num lote anterior da mesma campanha | cadastrar novo lote | `duplicate_phone` |
| CMP-18 | primeira linha de um telefone com variável faltando e a segunda completa | cadastrar | primeira `missing_variables`, segunda aceita |
| CMP-19 | lote com contatos válidos e inválidos | cadastrar | `200`, válidos gravados como mensagens `pending`, inválidos listados com `index` e `reason` |
| CMP-20 | lote em que todos são inválidos | cadastrar | `200` com `accepted: 0` |

### Regras da rota de contatos

| ID | Dado | Quando | Então |
|---|---|---|---|
| CMP-21 | campanha inexistente | `POST /campaigns/:id/contacts` | `404 campaign_not_found` |
| CMP-22 | campanha `running` ou `completed` | `POST /campaigns/:id/contacts` | `409 campaign_not_draft` |
| CMP-23 | `contacts` vazio ou com mais de 10.000 itens | `POST /campaigns/:id/contacts` | `400 validation_error`, nada gravado |
| CMP-24 | dois lotes cadastrados com rejeições | consultar a campanha | contador de rejeitados é a soma dos dois lotes |
