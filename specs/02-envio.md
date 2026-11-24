# Spec 02: Envio e retry

## Objetivo

Iniciar uma campanha e enviar cada mensagem pelo provedor externo, tratando falhas: tentar de novo as passageiras, desistir das definitivas e registrar o motivo de cada falha.

## Visão do processo

```
POST /campaigns/:id/start  ──► campanha draft → running  (responde na hora: 202)

Worker (processo separado, em loop):
  1. recupera mensagens presas em "sending"            (R12)
  2. reserva um lote de mensagens prontas              (R5–R7)  pending → sending
  3. envia cada uma, com limite de concorrência        (R8–R11)
       ok        → sent
       4xx       → failed
       5xx/outro → pending de novo (com backoff) ou failed se esgotou as tentativas
  4. fecha as campanhas que terminaram                 (R13)    running → completed
  5. sem trabalho? dorme um intervalo e volta ao passo 1
```

## Regras

### Início da campanha

- **R1.** `POST /campaigns/:id/start` muda a campanha de `draft` para `running`. O envio acontece em segundo plano; a API não espera.
- **R2. Idempotência.** Chamar `start` numa campanha que já está `running` ou `completed` não muda nada e responde com sucesso, mostrando o estado atual. Assim, um cliente que repetir a chamada (timeout, clique duplo) não recebe erro nem dispara nada duas vezes.
- **R3. Concorrência.** A mudança é um update condicional (`... WHERE status = 'draft'`). Se duas chamadas chegarem juntas, só uma muda o estado; as duas respondem com sucesso.
- **R4.** Campanha sem nenhuma mensagem não pode ser iniciada (`409 campaign_has_no_contacts`). Iniciar uma campanha vazia não teria o que enviar e ficaria `running` para sempre ou viraria `completed` na hora, sem utilidade.

### Reserva de mensagens (fila no Postgres)

- **R5. Mensagem pronta para envio:** status `pending`, `next_attempt_at <= agora` e campanha `running`. Mensagens de campanha `draft` nunca são enviadas.
- **R6. Reserva.** O worker seleciona um lote de mensagens prontas (`WORKER_BATCH_SIZE`, padrão 50) com `FOR UPDATE SKIP LOCKED`, marca como `sending`, grava `locked_at = agora`, soma 1 em `attempts` e confirma a transação **antes** de chamar o provedor. Assim:
  - dois workers nunca pegam a mesma mensagem (`SKIP LOCKED` pula as linhas que outro worker já travou);
  - nenhuma transação fica aberta durante a chamada externa.
- **R7. Ordem.** As mensagens prontas são reservadas por `next_attempt_at` e depois por ordem de criação (FIFO). Não há prioridade nem divisão justa entre campanhas.

### Envio

- **R8. Corpo da mensagem.** O template da campanha renderizado com as variáveis do contato (spec 01, CMP-06). O destino é o telefone em E.164 (`+5511987654321`).
- **R9. Concorrência.** No máximo `WORKER_CONCURRENCY` chamadas ao provedor ao mesmo tempo (padrão 10). Isso também funciona como controle de vazão para não sobrecarregar o provedor.
- **R10. Timeout.** Cada chamada tem limite de `PROVIDER_TIMEOUT_MS` (padrão 10 s). Estourar o timeout conta como falha transitória. O provedor simulado nunca demora tanto, mas um real pode.
- **R11. Classificação do resultado:**

| Resultado da chamada | Tipo | Novo status | Campos gravados |
|---|---|---|---|
| Sucesso `{ providerMessageId }` | — | `sent` | `provider_message_id`, `sent_at` |
| Erro com `err.status` 4xx (ex.: `400 invalid_number`) | definitiva | `failed` | `failure_reason` = mensagem do erro (ex.: `invalid_number`) |
| Erro com `err.status` 5xx (ex.: `503 provider_unavailable`) | transitória | ver R11.1 | `last_error` |
| Erro sem `status` (rede, timeout, exceção inesperada) | transitória | ver R11.1 | `last_error` |

  - **R11.1. Falha transitória:**
    - se `attempts < MAX_ATTEMPTS` (padrão 5): volta para `pending`, com `next_attempt_at = agora + backoff(attempts)` e `last_error` = mensagem do erro;
    - se `attempts = MAX_ATTEMPTS`: vira `failed` com `failure_reason = max_attempts_exceeded` e `last_error` = mensagem do último erro.
  - **R11.2. Backoff exponencial com jitter:**
    - base: `RETRY_BASE_MS * 2^(attempts - 1)` (padrão 1 s, 2 s, 4 s, 8 s...), limitado a `RETRY_MAX_MS` (padrão 60 s);
    - jitter: o atraso final é um valor aleatório entre 50% e 100% da base, para que mensagens que falharam juntas não sejam tentadas de novo todas no mesmo instante.
  - **R11.3.** A atualização do resultado é condicional (`WHERE status = 'sending'`) para não sobrescrever uma mensagem que já mudou de estado por outro caminho.

### Recuperação e fechamento

- **R12. Mensagens presas.** Uma mensagem em `sending` com `locked_at` mais antigo que `SENDING_TIMEOUT_MS` (padrão 60 s) é considerada abandonada (o worker caiu no meio). O worker a devolve para `pending` (pronta na hora) ou, se `attempts = MAX_ATTEMPTS`, marca como `failed` com `failure_reason = max_attempts_exceeded`.
  - **Risco aceito:** se o provedor já tinha aceitado a mensagem antes da queda, ela é enviada de novo (garantia "pelo menos uma vez", spec 00).
- **R13. Fim da campanha.** Uma campanha `running` vira `completed` quando não tem nenhuma mensagem em `pending` ou `sending`. Mensagens esperando retry estão em `pending`, então a campanha não fecha enquanto houver retry pendente. O update é condicional (`WHERE status = 'running'`).
- **R14. Desligamento gracioso.** Ao receber `SIGTERM`/`SIGINT`, o worker para de reservar mensagens novas, espera as chamadas em andamento terminarem e grava os resultados antes de sair.

### Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `WORKER_BATCH_SIZE` | 50 | Mensagens reservadas por ciclo |
| `WORKER_CONCURRENCY` | 10 | Chamadas simultâneas ao provedor |
| `WORKER_POLL_INTERVAL_MS` | 1000 | Espera quando não há trabalho |
| `MAX_ATTEMPTS` | 5 | Tentativas por mensagem (incluindo a primeira) |
| `RETRY_BASE_MS` | 1000 | Base do backoff |
| `RETRY_MAX_MS` | 60000 | Teto do backoff |
| `PROVIDER_TIMEOUT_MS` | 10000 | Timeout por chamada |
| `SENDING_TIMEOUT_MS` | 60000 | Tempo para considerar uma mensagem `sending` abandonada |
| `FAKE_FAIL_RATE` | 0.2 | Taxa de falha 503 do provedor simulado (lida pelo próprio `fakeProvider.js`) |

## Contrato da API

### `POST /campaigns/:id/start`

Sem body.

Response `202 Accepted` (também quando a campanha já estava `running` ou `completed`):
```json
{
  "id": "6f1c...-uuid",
  "status": "running",
  "started_at": "2026-11-24T12:05:00.000Z"
}
```

Erros:
| Status | `code` | Quando |
|---|---|---|
| 404 | `campaign_not_found` | Campanha não existe |
| 409 | `campaign_has_no_contacts` | Campanha em `draft` sem nenhuma mensagem |

## Premissas

- O código do provedor (`fakeProvider.js`) é usado como está. A classificação de erros (R11) se baseia só no `err.status` que ele devolve.
- O provedor não aceita chave de idempotência, então reenvios por queda do worker (R12) não podem ser evitados do lado dele.
- Não há limite de envios por segundo além da concorrência (R9). Um provedor real teria rate limit, e respostas `429` seriam tratadas como transitórias (são 4xx, então precisariam de exceção explícita; fica como próximo passo).
- Um único worker já atende o teste, mas o desenho permite várias réplicas graças ao `SKIP LOCKED`.

## Critérios de aceite

### Início

| ID | Dado | Quando | Então |
|---|---|---|---|
| SND-01 | campanha `draft` com mensagens | `POST /start` | `202`, status `running`, `started_at` preenchido |
| SND-02 | campanha já `running` ou `completed` | `POST /start` | `202` com o estado atual, nada muda (`started_at` mantido) |
| SND-03 | duas chamadas `start` simultâneas na mesma campanha `draft` | executar em paralelo | as duas respondem `202`, a campanha muda de estado uma vez só |
| SND-04 | campanha `draft` sem mensagens | `POST /start` | `409 campaign_has_no_contacts` |
| SND-05 | campanha inexistente | `POST /start` | `404 campaign_not_found` |

### Reserva

| ID | Dado | Quando | Então |
|---|---|---|---|
| SND-06 | mensagens `pending` de uma campanha `draft` | worker reserva lote | nenhuma é reservada |
| SND-07 | mensagem `pending` com `next_attempt_at` no futuro | worker reserva lote | não é reservada |
| SND-08 | duas reservas simultâneas sobre as mesmas mensagens prontas | executar em paralelo | nenhuma mensagem aparece nos dois lotes |
| SND-09 | mensagem pronta | reservada | status `sending`, `locked_at` preenchido, `attempts` somado em 1 |

### Envio e classificação

| ID | Dado | Quando | Então |
|---|---|---|---|
| SND-10 | provedor responde com sucesso | processar mensagem | `sent`, `provider_message_id` e `sent_at` gravados |
| SND-11 | template `Olá {{nome}}` e contato `{nome: "Ana"}` | processar mensagem | provedor recebe `body = "Olá Ana"` e `to = "+55..."` |
| SND-12 | provedor responde `400 invalid_number` | processar mensagem | `failed`, `failure_reason = invalid_number`, sem nova tentativa |
| SND-13 | provedor responde `503` e `attempts < MAX_ATTEMPTS` | processar mensagem | `pending`, `next_attempt_at` no futuro, `last_error = provider_unavailable` |
| SND-14 | provedor responde `503` e `attempts = MAX_ATTEMPTS` | processar mensagem | `failed`, `failure_reason = max_attempts_exceeded`, `last_error = provider_unavailable` |
| SND-15 | erro sem `status` (ex.: exceção de rede) ou timeout | processar mensagem | tratado como transitório (igual SND-13/14) |
| SND-16 | provedor falha com 503 duas vezes e depois aceita | processar até o fim | `sent` com `attempts = 3` |

### Backoff

| ID | Dado | Quando | Então |
|---|---|---|---|
| SND-17 | base 1000 ms, teto 60000 ms, jitter desligado (100%) | calcular para `attempts` 1, 2, 3, 10 | 1000, 2000, 4000, 60000 ms |
| SND-18 | jitter ligado | calcular para `attempts` 3 | valor entre 2000 e 4000 ms |
| SND-19 | erro 4xx, 5xx, sem status | classificar | definitiva, transitória, transitória |

### Recuperação, fechamento e desligamento

| ID | Dado | Quando | Então |
|---|---|---|---|
| SND-20 | mensagem `sending` com `locked_at` mais antigo que `SENDING_TIMEOUT_MS` e `attempts < MAX_ATTEMPTS` | worker roda a recuperação | volta para `pending`, pronta para envio |
| SND-21 | mesma situação com `attempts = MAX_ATTEMPTS` | worker roda a recuperação | `failed`, `failure_reason = max_attempts_exceeded` |
| SND-22 | campanha `running` com todas as mensagens em `sent`/`delivered`/`read`/`failed` | worker fecha campanhas | `completed`, `completed_at` preenchido |
| SND-23 | campanha `running` com uma mensagem `pending` aguardando retry | worker fecha campanhas | continua `running` |
| SND-24 | worker com chamadas em andamento | recebe `SIGTERM` | não reserva mais nada, termina as chamadas, grava os resultados e sai |
