# Spec 04: Relatório da campanha

## Objetivo

Permitir que a empresa acompanhe o andamento de uma campanha: quantas mensagens foram enviadas, entregues, lidas ou falharam, e o motivo de cada falha.

## Duas formas de contar

Uma mensagem lida também foi entregue e enviada. Por isso o relatório mostra dois blocos com propósitos diferentes:

| Bloco | Pergunta que responde | Soma bate com o total? |
|---|---|---|
| `by_status` | "Em que estado cada mensagem está **agora**?" | Sim, cada mensagem está em exatamente um estado |
| `funnel` | "Quantas mensagens **chegaram pelo menos até** cada etapa?" | Não, uma mensagem conta em várias etapas |

Exemplo com 10 mensagens: 2 `pending`, 3 `sent`, 3 `delivered`, 1 `read`, 1 `failed` (falhou no provedor, nunca foi aceita).

```
by_status:  pending 2 · sending 0 · sent 3 · delivered 3 · read 1 · failed 1      (soma = 10)
funnel:     sent 7 (3+3+1) · delivered 4 (3+1) · read 1 · failed 1
```

## Regras

### Resumo da campanha

- **R1.** `GET /campaigns/:id` devolve os dados da campanha mais o resumo do andamento.
- **R2. `by_status`.** Quantidade de mensagens em cada estado atual: `pending`, `sending`, `sent`, `delivered`, `read`, `failed`. Todos os estados aparecem, mesmo com zero.
- **R3. `funnel` (acumulado):**
  - `sent`: mensagens que o provedor aceitou, ou seja, que têm `provider_message_id`. Inclui as que depois foram `delivered`, `read` ou `failed` via webhook.
  - `delivered`: mensagens em `delivered` ou `read` (spec 03: `read` prova a entrega).
  - `read`: mensagens em `read`.
  - `failed`: mensagens em `failed`, qualquer que seja a origem (provedor recusou, tentativas esgotadas ou webhook).
- **R4. `retrying`.** Quantas mensagens `pending` já tiveram pelo menos uma tentativa (`attempts > 0`), ou seja, estão esperando retry.
- **R5. `failures_by_reason`.** Quantidade de mensagens `failed` agrupada por `failure_reason` (ex.: `invalid_number`, `max_attempts_exceeded`, `provider_reported_failure`). Só aparecem os motivos que ocorreram.
- **R6. `contacts`.** `accepted` é o total de mensagens da campanha; `rejected` é o contador acumulado de contatos rejeitados no cadastro (spec 01, R15).
- **R7. Cálculo na hora.** Os números são calculados a cada consulta, com agregações (`COUNT ... GROUP BY`) sobre a tabela de mensagens, usando o índice `(campaign_id, status)`. Não há contadores gravados que possam ficar desatualizados.

### Lista de mensagens

- **R8.** `GET /campaigns/:id/messages` lista as mensagens da campanha, com o detalhe de cada uma, incluindo `failure_reason` e `last_error`. É assim que a empresa vê **o motivo de cada falha** individualmente.
- **R9. Filtro.** `?status=` filtra por um estado atual (ex.: `?status=failed`). Valor fora da lista de estados responde `400`.
- **R10. Paginação.** `?limit=` (padrão 50, máximo 500) e `?offset=` (padrão 0). A resposta traz o `total` de itens do filtro. A ordem é a de cadastro dos contatos, estável entre páginas.

## Contrato da API

### `GET /campaigns/:id`

Response `200 OK`:
```json
{
  "id": "6f1c...-uuid",
  "name": "Entrega novembro",
  "template": "Olá {{nome}}, seu pedido {{pedido}} saiu para entrega.",
  "variables": ["nome", "pedido"],
  "status": "running",
  "created_at": "2026-11-24T12:00:00.000Z",
  "started_at": "2026-11-24T12:05:00.000Z",
  "completed_at": null,
  "contacts": { "accepted": 10, "rejected": 3 },
  "messages": {
    "by_status": { "pending": 2, "sending": 0, "sent": 3, "delivered": 3, "read": 1, "failed": 1 },
    "funnel": { "sent": 7, "delivered": 4, "read": 1, "failed": 1 },
    "retrying": 1,
    "failures_by_reason": { "invalid_number": 1 }
  }
}
```

Erros:
| Status | `code` | Quando |
|---|---|---|
| 404 | `campaign_not_found` | Campanha não existe |

### `GET /campaigns/:id/messages?status=failed&limit=50&offset=0`

Response `200 OK`:
```json
{
  "total": 1,
  "limit": 50,
  "offset": 0,
  "items": [
    {
      "id": "a91b...-uuid",
      "phone": "+5521987650000",
      "variables": { "nome": "Caio", "pedido": "C-300" },
      "status": "failed",
      "attempts": 1,
      "failure_reason": "invalid_number",
      "last_error": null,
      "provider_message_id": null,
      "sent_at": null,
      "updated_at": "2026-11-24T12:05:01.000Z"
    }
  ]
}
```

Erros:
| Status | `code` | Quando |
|---|---|---|
| 400 | `validation_error` | `status` inválido; `limit` fora de 1–500; `offset` negativo |
| 404 | `campaign_not_found` | Campanha não existe |

## Premissas

- Consulta por polling: a empresa chama o `GET` quando quiser. Não há push (SSE/WebSocket) nem webhook de saída para o cliente.
- Calcular na hora atende bem campanhas de milhares de mensagens. Para milhões, o próximo passo seria manter contadores atualizados por evento.
- Paginação por `offset` é simples e suficiente aqui. Com volumes grandes, paginação por cursor seria mais eficiente; fica como próximo passo.
- Não há listagem de todas as campanhas (`GET /campaigns`); o enunciado pede o acompanhamento de uma campanha.

## Critérios de aceite

### Resumo

| ID | Dado | Quando | Então |
|---|---|---|---|
| RPT-01 | campanha inexistente | `GET /campaigns/:id` | `404 campaign_not_found` |
| RPT-02 | campanha recém-criada sem contatos | `GET /campaigns/:id` | `200`, todos os contadores zerados, todos os estados presentes em `by_status` |
| RPT-03 | as 10 mensagens do exemplo desta spec | `GET /campaigns/:id` | `by_status` e `funnel` exatamente como no exemplo |
| RPT-04 | mensagem que foi `sent` e depois `failed` via webhook | consultar | conta em `funnel.sent` e em `funnel.failed` |
| RPT-05 | mensagem que falhou com `invalid_number` (nunca aceita) | consultar | conta em `funnel.failed`, **não** conta em `funnel.sent` |
| RPT-06 | mensagens `pending` com `attempts` 0 e 2 | consultar | `retrying = 1` |
| RPT-07 | falhas com motivos `invalid_number` (2) e `max_attempts_exceeded` (1) | consultar | `failures_by_reason = { invalid_number: 2, max_attempts_exceeded: 1 }` |
| RPT-08 | dois lotes com 3 e 2 rejeitados, 5 aceitos no total | consultar | `contacts = { accepted: 5, rejected: 5 }` |

### Lista de mensagens

| ID | Dado | Quando | Então |
|---|---|---|---|
| RPT-09 | campanha com mensagens em vários estados | `?status=failed` | só mensagens `failed`, cada uma com `failure_reason` |
| RPT-10 | `?status=xyz` | listar | `400 validation_error` |
| RPT-11 | 120 mensagens | `?limit=50&offset=100` | 20 itens, `total = 120`, na ordem de cadastro |
| RPT-12 | `?limit=0`, `?limit=501` ou `?offset=-1` | listar | `400 validation_error` |
| RPT-13 | campanha inexistente | listar | `404 campaign_not_found` |
