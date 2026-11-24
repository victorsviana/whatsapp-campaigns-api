# Spec 03: Webhooks do provedor

## Objetivo

Receber os avisos do provedor sobre o que aconteceu com cada mensagem (entregue, lida ou falhou) e atualizar o status dela corretamente, mesmo quando os avisos chegam **repetidos** e **fora de ordem**.

## Visão do processo

```
POST /webhooks/provider { event_id, provider_message_id, status }
   │
   ▼
valida o payload ──inválido──► 400 (nada gravado)
   │
   ▼
BEGIN
 grava o evento (event_id é PK) ──já existia──► 200 "duplicate" (nada muda)
   │
   ▼
 procura a mensagem pelo provider_message_id
   ├── não achou ──► evento fica pendente ──► 200 "pending"     (R7)
   │
   ▼
 update condicional: só se o novo status "avança" o atual
   ├── avançou ──► 200 "applied"
   └── não avançou ──► 200 "ignored"
COMMIT
```

## Regras

### Contrato e validação

- **R1.** O formato é fixo pelo enunciado: `event_id` (texto), `provider_message_id` (texto) e `status` (`delivered`, `read` ou `failed`). Os três são obrigatórios e não podem ser vazios. Campos extras são ignorados.
- **R2.** Payload inválido (campo ausente, vazio, tipo errado ou `status` fora da lista) responde `400 validation_error` e não grava nada.

### Repetidos

- **R3. Deduplicação por `event_id`.** O evento é gravado na tabela `provider_events`, onde `event_id` é chave primária, com `INSERT ... ON CONFLICT DO NOTHING`. Se o `event_id` já existia, o evento é um repetido: responde `200` com `result: "duplicate"` e não mexe em nada.
- **R4.** Um `event_id` repetido com conteúdo diferente (outro status ou outra mensagem) também é tratado como repetido e ignorado. O primeiro que chegou vale.
- **R5. Concorrência.** Se o mesmo evento chegar duas vezes ao mesmo tempo, a chave primária garante que só uma das requisições grava e aplica; a outra recebe `duplicate`.

### Fora de ordem

- **R6. O status só avança.** Cada status tem uma posição:

  ```
  sent (1)  →  delivered (2)  →  read (3)
     │
     └──────→  failed (terminal)
  ```

  Tabela de transições (linha = status atual, coluna = status do evento):

  | Atual ↓ / Evento → | `delivered` | `read` | `failed` |
  |---|---|---|---|
  | `sent` | **aplica** | **aplica** | **aplica** |
  | `delivered` | ignora (igual) | **aplica** | ignora |
  | `read` | ignora | ignora (igual) | ignora |
  | `failed` | ignora | ignora | ignora (igual) |

  - `sent → read` é permitido direto: se o `delivered` se perdeu ou vai chegar depois, a leitura já prova a entrega. O relatório conta essa mensagem como entregue também (spec 04).
  - `failed` só vale enquanto a mensagem está `sent`. Depois de `delivered`, um `failed` é considerado aviso atrasado ou contraditório e é ignorado.
  - `failed` é terminal: nada muda uma mensagem que falhou.
- **R7. Garantia no banco.** A transição é um update condicional numa única instrução, por exemplo `UPDATE messages SET status = 'delivered' WHERE provider_message_id = $1 AND status = 'sent'`. Dois eventos diferentes da mesma mensagem chegando juntos nunca fazem o status regredir, porque o banco avalia a condição linha a linha com trava.
- **R8. Falha via webhook.** Quando um evento `failed` é aplicado, a mensagem fica com `failure_reason = provider_reported_failure`. O contrato não traz o motivo detalhado.

### Mensagem ainda não conhecida

- **R9. Evento antes da mensagem.** O provedor pode mandar o webhook antes de o worker gravar o `provider_message_id` (o worker recebe a resposta do provedor e ainda está gravando). Nesse caso, a mensagem não é encontrada e o evento fica gravado como pendente (`processed_at` vazio). A resposta é `200` com `result: "pending"`.
- **R10. Aplicação posterior.** Quando o worker grava uma mensagem como `sent`, na mesma transação ele aplica os eventos pendentes daquele `provider_message_id` seguindo a regra R6. Se houver mais de um, todos passam pela regra, então o resultado final é sempre o status mais avançado permitido.
- **R11.** Um evento de um `provider_message_id` que nunca aparecer fica pendente para sempre. É inofensivo; a limpeza periódica fica como próximo passo.

### Resposta e registro

- **R12.** Todo evento válido responde `200`, inclusive repetido, ignorado e pendente. Responder erro faria o provedor reenviar um aviso que já foi tratado.
- **R13.** O evento guarda o resultado do processamento (`applied`, `ignored` ou `pending`) e a hora em que foi processado. Isso permite auditar por que uma mensagem está em determinado status.
- **R14.** Gravar o evento e atualizar a mensagem acontecem na mesma transação: ou os dois ficam gravados, ou nenhum. Se algo falhar no meio, a requisição responde `500` e o provedor pode reenviar sem que o evento conste como já processado.
- **R15.** Webhooks continuam sendo aplicados mesmo com a campanha `completed` (spec 00: `completed` significa que o envio terminou, não que os avisos acabaram).

## Contrato da API

### `POST /webhooks/provider`

Request (formato do enunciado):
```json
{
  "event_id": "evt_001",
  "provider_message_id": "pm_8f2c...",
  "status": "delivered"
}
```

Response `200 OK`:
```json
{ "event_id": "evt_001", "result": "applied" }
```

| `result` | Significado |
|---|---|
| `applied` | O status da mensagem mudou |
| `ignored` | Mensagem encontrada, mas o evento não avança o status (fora de ordem ou igual) |
| `duplicate` | `event_id` já recebido antes; nada foi feito |
| `pending` | Mensagem ainda não encontrada; o evento será aplicado quando ela aparecer |

Erros:
| Status | `code` | Quando |
|---|---|---|
| 400 | `validation_error` | Payload inválido (R1/R2) |

## Premissas

- **Sem verificação de assinatura.** Um provedor real assinaria o webhook (ex.: HMAC num header) e nós validaríamos. O enunciado não define isso, então fica como próximo passo.
- O provedor reenvia um aviso quando não recebe `2xx` (comportamento comum de webhooks). Por isso a rota responde `200` sempre que entendeu o evento (R12).
- O `provider_message_id` é único por mensagem (o provedor gera um UUID por envio).
- Não há um evento `sent` no webhook: o status `sent` vem da resposta síncrona do `sendMessage` (spec 02).

## Critérios de aceite

### Validação

| ID | Dado | Quando | Então |
|---|---|---|---|
| WHK-01 | payload sem `event_id`, sem `provider_message_id` ou com campo vazio | `POST /webhooks/provider` | `400 validation_error`, nada gravado |
| WHK-02 | `status` fora da lista (ex.: `sent`, `DELIVERED`, `abc`) | `POST /webhooks/provider` | `400 validation_error`, nada gravado |

### Transições (mensagem conhecida)

| ID | Status atual | Evento | Então |
|---|---|---|---|
| WHK-03 | `sent` | `delivered` | `applied`, mensagem `delivered` |
| WHK-04 | `delivered` | `read` | `applied`, mensagem `read` |
| WHK-05 | `sent` | `read` | `applied`, mensagem `read` (pulou o `delivered`) |
| WHK-06 | `read` | `delivered` | `ignored`, mensagem continua `read` |
| WHK-07 | `sent` | `failed` | `applied`, mensagem `failed` com `failure_reason = provider_reported_failure` |
| WHK-08 | `delivered` | `failed` | `ignored`, mensagem continua `delivered` |
| WHK-09 | `failed` | `delivered` ou `read` | `ignored`, mensagem continua `failed` |
| WHK-10 | `delivered` | `delivered` (outro `event_id`) | `ignored` |

### Repetidos e concorrência

| ID | Dado | Quando | Então |
|---|---|---|---|
| WHK-11 | evento `evt_1` já processado | mesmo `evt_1` chega de novo | `200 duplicate`, nada muda |
| WHK-12 | evento `evt_1` (`delivered`) já processado | `evt_1` chega com `status: read` | `200 duplicate`, mensagem continua `delivered` (R4) |
| WHK-13 | o mesmo evento enviado várias vezes em paralelo | processar | aplicado uma única vez; as outras respostas são `duplicate` |
| WHK-14 | eventos `delivered` e `read` da mesma mensagem enviados em paralelo, em qualquer ordem | processar | a mensagem termina `read` |

### Mensagem ainda não conhecida

| ID | Dado | Quando | Então |
|---|---|---|---|
| WHK-15 | `provider_message_id` que não existe | `POST /webhooks/provider` | `200 pending`, evento gravado sem `processed_at` |
| WHK-16 | evento `read` pendente para `pm_x` | worker grava a mensagem como `sent` com `provider_message_id = pm_x` | na mesma transação a mensagem vai para `read` e o evento fica `applied` |
| WHK-17 | eventos pendentes `read` e `delivered` para `pm_x` | worker grava `sent` | mensagem termina `read` |

### Outros

| ID | Dado | Quando | Então |
|---|---|---|---|
| WHK-18 | mensagem `sent` de uma campanha `completed` | evento `delivered` | `applied` |
| WHK-19 | qualquer evento processado | consultar `provider_events` | resultado (`applied`/`ignored`/`pending`) e hora de processamento gravados |
