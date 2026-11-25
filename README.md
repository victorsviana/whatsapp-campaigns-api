# Campanhas de WhatsApp — API

API para criar campanhas de mensagens com variáveis, cadastrar contatos, disparar o envio por um provedor externo e acompanhar o andamento (enviadas, entregues, lidas e falhas com motivo).

## 1. Como entendi o problema

Uma empresa quer disparar mensagens de WhatsApp em massa. Cada campanha tem um template com variáveis (`Olá {{nome}}, seu pedido {{pedido}} saiu para entrega.`) e uma lista de contatos com o telefone e os valores dessas variáveis. A API precisa de três coisas: cadastrar a campanha e os contatos, iniciar o envio e mostrar o andamento, com o motivo de cada falha.

O enunciado traz quatro pontos que guiam o desenho. Para cada um, a regra que tirei dele:

| O que o enunciado diz | Regra que identifiquei |
|---|---|
| Os contatos vêm de planilhas, com telefones inválidos, repetidos ou faltando informação | Validar contato a contato e rejeitar só os ruins, devolvendo o motivo de cada um sem derrubar o lote. Normalizar o telefone antes de comparar, porque `(11) 98765-4321` e `+55 11 98765-4321` são o mesmo número. |
| Campanhas podem ter milhares de contatos | O envio não pode acontecer dentro da requisição. `start` só muda o estado da campanha, e um worker separado envia em segundo plano, com concorrência limitada. Os contatos podem chegar em vários lotes. |
| O provedor às vezes falha, e algumas falhas são passageiras e outras não | Pelo `fakeProvider.js`, `400 invalid_number` (finais `0000`) é definitiva e `503 provider_unavailable` é passageira. Definitiva vira `failed` na hora; passageira é tentada de novo com backoff até um limite de tentativas. |
| O provedor avisa o resultado por webhook, com avisos repetidos e fora de ordem | Deduplicar por `event_id`. O status da mensagem só avança (`sent < delivered < read`, e `failed` é terminal), então um `delivered` que chega depois do `read` é ignorado. O aviso também pode chegar antes de gravarmos o `provider_message_id`, e não pode se perder. |

### Premissas que assumi

Onde o enunciado não diz nada, decidi o seguinte. Cada spec em [`specs/`](specs/) detalha as premissas do seu assunto.

- **Uma única empresa, sem autenticação.** Autenticação e multiempresa ficam fora do escopo.
- **Telefones brasileiros.** Número sem DDI recebe `55`. O telefone válido é celular (9 dígitos começando com 9) ou fixo (8 dígitos), com DDD sem zero, gravado em E.164 (`+5511987654321`). Número estrangeiro é `invalid_phone`.
- **Ordem da validação de um contato:** telefone ausente → telefone inválido → variável faltando → telefone duplicado. A duplicidade só é verificada contra contatos já **aceitos**, dentro do lote e entre lotes da mesma campanha.
- **Valores de variável:** número é aceito e vira texto (planilhas mandam `pedido: 1234`). Texto vazio, `null`, objeto, lista ou booleano contam como faltando. Variáveis extras são ignoradas.
- **Contatos só entram com a campanha em `draft`.** Depois do `start`, a lista fica fechada.
- **`completed` quer dizer que o envio acabou, não que os avisos acabaram.** Uma mensagem de campanha `completed` ainda pode passar de `sent` para `delivered` ou `read`.
- **`failed` só vale para mensagem `sent`.** Depois de `delivered`, um `failed` é tratado como aviso atrasado ou contraditório e é ignorado. Já `sent → read` direto é aceito, porque a leitura prova a entrega.
- **Garantia "pelo menos uma vez".** Se o worker cair depois de o provedor aceitar e antes de gravarmos o resultado, a mensagem pode ser reenviada. O provedor simulado não aceita chave de idempotência, então "exatamente uma vez" não é possível do nosso lado.
- **Sem pausa, cancelamento, edição ou remoção** de campanha e contatos.
- **Acompanhamento por consulta (polling).** Não há push nem webhook de saída para a empresa.
- **Datas em UTC**, no formato ISO 8601.

## 2. Decisões e por quê

### Como trabalhei: specs primeiro (SDD)

Antes de qualquer código, escrevi as regras e o contrato de cada parte em [`specs/`](specs/), com 80 critérios de aceite numerados (`CMP-xx`, `SND-xx`, `WHK-xx`, `RPT-xx`). Cada critério tem pelo menos um teste com o mesmo ID no nome, por exemplo `it('WHK-06: ...')`, e o script `npm run check:criteria` aponta critério sem teste (hoje: 80/80). As specs são a referência mais completa das regras; esta seção explica as escolhas.

### Stack

| Escolha | Por quê |
|---|---|
| **Node 24 + TypeScript** | Tipos ajudam a manter os estados e contratos coerentes entre API, worker e banco. |
| **Express 5** | Simples e conhecido. A versão 5 já repassa erros de handlers `async` para o middleware de erro, sem wrapper. |
| **PostgreSQL 17** | Pedido pelo enunciado, e também resolve a fila (abaixo), sem precisar de outro serviço. |
| **Drizzle ORM** | Schema tipado e consultas próximas do SQL. Onde preciso de controle fino (a reserva de mensagens), escrevo SQL direto. |
| **Zod** | Validação da entrada com mensagens por campo, e o tipo TypeScript sai do mesmo schema. |
| **Vitest + Supertest** | Testes rápidos em TypeScript, com testes de integração batendo num Postgres real. |

### Arquitetura: API e worker separados

```
cliente ──► API (Express) ──► Postgres ◄── worker ──► fakeProvider.js
provedor ──► POST /webhooks/provider ──┘
```

- A **API** só lê e grava no banco e responde rápido. `POST /campaigns/:id/start` muda a campanha para `running` e responde `202`, sem esperar o envio.
- O **worker** é outro processo (outro service no `docker compose`, mesma imagem). Ele busca mensagens prontas, chama o provedor e grava o resultado.
- Separados, um não derruba o outro, e dá para escalar o worker sem mexer na API.
- O código é organizado por módulo (`campaigns`, `messages`, `webhooks`). Cada um tem schemas de validação, repository (banco), service (regras) e routes (HTTP), montados por funções `createX(...)` que recebem as dependências. Isso deixa trocar o banco ou o provedor nos testes sem mocks globais.

### Postgres como fila

Não usei Redis nem fila externa: cada contato aceito vira uma linha em `messages` com status `pending`, e essa tabela é a fila.

- **Reserva com `FOR UPDATE SKIP LOCKED`.** Numa única instrução, o worker escolhe um lote de mensagens prontas (`pending`, `next_attempt_at <= now()`, campanha `running`), muda para `sending`, grava `locked_at` e soma 1 em `attempts`. O `SKIP LOCKED` faz dois workers nunca pegarem a mesma mensagem, então dá para rodar várias réplicas.
- **A transação fecha antes de chamar o provedor.** Nenhuma transação fica aberta durante a chamada externa, que é lenta e pode travar.
- **Ordem estável.** As mensagens saem por `next_attempt_at` e depois pela ordem de cadastro (coluna `seq`).
- **Por quê:** uma peça a menos para subir e operar, e o estado da mensagem e a "fila" nunca divergem, porque são a mesma linha. O custo é que o banco recebe a carga da fila; para o volume do teste (milhares de mensagens) isso é tranquilo.

### Envio, falhas e retry

- **Classificação:** erro 4xx é definitivo (`failed` com o motivo do provedor, ex.: `invalid_number`). Erro 5xx, erro sem status ou timeout é passageiro.
- **Retry com backoff exponencial e jitter:** 1 s, 2 s, 4 s... até 60 s, com um sorteio entre 50% e 100% do valor. O jitter evita que mensagens que falharam juntas voltem todas no mesmo instante. Na última tentativa (`MAX_ATTEMPTS`, padrão 5), vira `failed` com `max_attempts_exceeded`, guardando o último erro em `last_error`.
- **Retry não é um estado próprio.** A mensagem volta para `pending` com `next_attempt_at` no futuro. O relatório mostra quantas estão nessa situação (`retrying`).
- **Concorrência limitada** (`WORKER_CONCURRENCY`, padrão 10) e **timeout por chamada** (`PROVIDER_TIMEOUT_MS`), para não sobrecarregar o provedor nem travar o worker.
- **Gravação condicional:** o resultado só é gravado `WHERE status = 'sending'`, para não sobrescrever uma mensagem que mudou por outro caminho.
- **Mensagens presas:** se o worker cair no meio, a mensagem fica em `sending`. A cada ciclo, o worker devolve para `pending` as que estão travadas há mais de `SENDING_TIMEOUT_MS` (ou marca `failed`, se esgotaram as tentativas). É aqui que pode haver reenvio ("pelo menos uma vez").
- **Fechamento da campanha:** a cada ciclo, campanhas `running` sem mensagem `pending` ou `sending` viram `completed`.
- **Desligamento gracioso:** no `SIGTERM`, o worker para de reservar, termina o lote em andamento e grava os resultados. O `docker compose` dá 60 s para isso (`stop_grace_period`).
- O `fakeProvider.js` é usado **sem alterações**. Um adapter em volta dele faz a classificação dos erros e o timeout, e é a única parte que conhece o formato do provedor.

### Webhooks repetidos e fora de ordem

- **Repetidos:** o evento é gravado em `provider_events`, com `event_id` como chave primária e `INSERT ... ON CONFLICT DO NOTHING`. Se já existia, a resposta é `200 duplicate` e nada muda. A chave primária também resolve o mesmo evento chegando duas vezes ao mesmo tempo.
- **Fora de ordem:** a mensagem só muda com um `UPDATE ... WHERE status IN (...)` que lista os estados a partir dos quais o evento é um avanço. A regra fica numa única função (`canTransition`) e o banco garante que o status nunca regride, mesmo com eventos da mesma mensagem chegando juntos.
- **Aviso antes da mensagem:** o provedor pode avisar antes de o worker gravar o `provider_message_id`. Nesse caso, o evento fica gravado como `pending`. Quando o worker grava a mensagem como `sent`, na mesma transação ele aplica os eventos pendentes daquele id.
  - Isso tinha uma corrida: as duas transações podiam rodar ao mesmo tempo e uma não ver a linha ainda não confirmada da outra, deixando o evento pendente para sempre. Resolvi com um lock por `provider_message_id` (`pg_advisory_xact_lock`) que o webhook e o worker pegam antes de olhar um para o outro. Há um teste que reproduz a corrida e falha sem o lock.
- **Sempre `200` para evento válido**, inclusive `duplicate`, `ignored` e `pending`. Responder erro faria o provedor reenviar um aviso que já foi tratado.
- **Auditoria:** cada evento guarda o resultado (`applied`, `ignored` ou `pending`) e a hora do processamento, para explicar por que uma mensagem está em determinado status.
- Gravar o evento e atualizar a mensagem acontecem na **mesma transação**: se algo falhar, nenhum dos dois fica gravado e o provedor pode reenviar.

### Cadastro de contatos

- **Criar a campanha e cadastrar contatos são rotas separadas**, porque uma planilha grande pode vir em vários lotes (até 10.000 contatos por requisição).
- **O lote responde `200` mesmo com rejeições**, com o total aceito e a lista dos rejeitados (`index` no array, telefone como veio e motivo). Assim a empresa acha a linha da planilha.
- **Os aceitos de um lote são gravados numa transação única**, com a campanha travada (`FOR UPDATE`) para que dois lotes simultâneos não aceitem o mesmo telefone. O banco também tem `UNIQUE (campaign_id, phone)` como última proteção.
- A campanha guarda o total acumulado de rejeitados. O detalhe de cada rejeição só aparece na resposta do cadastro.

### Início idempotente

`start` numa campanha já `running` ou `completed` responde `202` com o estado atual, sem erro. Um cliente que repete a chamada (timeout, clique duplo) não dispara nada duas vezes. Campanha sem contatos responde `409 campaign_has_no_contacts`, porque ficaria `running` sem ter o que enviar.

### Relatório calculado na hora

`GET /campaigns/:id` calcula os números a cada consulta, com `COUNT ... GROUP BY` sobre `messages` (índice `(campaign_id, status)`). Não há contadores gravados que possam ficar desatualizados.

O relatório tem dois blocos, porque respondem perguntas diferentes:

- `by_status` diz em que estado cada mensagem está **agora**, e a soma bate com o total.
- `funnel` diz quantas **chegaram pelo menos até** cada etapa. Uma mensagem lida conta em `sent`, `delivered` e `read`.

Também traz `retrying` (pendentes que já falharam alguma vez) e `failures_by_reason`. O motivo de cada falha, mensagem a mensagem, está em `GET /campaigns/:id/messages?status=failed`, que é paginado.

### Contrato de erros

Todo erro sai no mesmo formato: `{ "error": { "code", "message", "details"? } }`. Além dos códigos das specs, a API tem:

- `invalid_json` (400) e `payload_too_large` (413) para body malformado ou grande demais;
- `route_not_found` (404) e `internal_error` (500);
- `details` com `[{ path, message }]` em todo `validation_error`, listando todos os campos com problema de uma vez;
- `:id` que não é UUID responde `400 validation_error` em `params.id`, em vez de chegar ao banco;
- item de `contacts` que não é objeto (ex.: uma string solta) recusa o lote inteiro com `400`. É erro de formato da requisição, não um contato com dado ruim.

### Testes

- **Unitários** para as regras puras: template, normalização de telefone, validação de contatos, retry/backoff, transições de status, adapter do provedor e laço do worker.
- **Integração contra um Postgres real** para tudo que depende do banco: rotas HTTP, reserva concorrente (`SKIP LOCKED`), webhooks em paralelo, eventos pendentes e relatório. Corridas e concorrência só são provadas de verdade no banco; com mock, esses testes passariam sem garantir nada. Nos testes mais delicados (reserva sem `SKIP LOCKED`, corrida do webhook), confirmei que o teste falha quando a proteção é removida.
- **Ponta a ponta:** um teste percorre o fluxo inteiro pela API e pelo worker real (criar → contatos → start → envio com retry e falhas → webhooks repetidos e fora de ordem → relatório). Nele, o provedor é roteirizado por telefone para o resultado ser determinístico; o `fakeProvider.js` original sorteia 20% de falhas.

## 3. Como rodar o projeto e os testes

### Subir tudo

Precisa só de Docker com o Compose.

```bash
docker compose up --build
```

O comando sobe quatro serviços:

| Serviço | O que faz |
|---|---|
| `postgres` | Banco, exposto em `localhost:5432` (usuário e senha `postgres`, banco `wpp_campaigns`). |
| `migrate` | Aplica as migrations e termina. A API e o worker só sobem depois dele. |
| `api` | A API em `http://localhost:3000` (`GET /health` responde `{"status":"ok"}`). |
| `worker` | Envia as mensagens pelo `fakeProvider.js`. |

Para mudar a taxa de falha passageira do provedor simulado (padrão 20%): `FAKE_FAIL_RATE=0.5 docker compose up`. As demais configurações do worker estão em [`.env.example`](.env.example) e na [spec 02](specs/02-envio.md#configuração).

Para zerar o banco: `docker compose down -v`.

### Rodar os testes

Os testes de integração usam um Postgres de verdade. Eles criam sozinhos o banco `wpp_campaigns_test`, aplicam as migrations e limpam as tabelas no início de cada execução. Precisa de Node 18+ (o projeto usa Node 24 na imagem).

```bash
docker compose up -d postgres   # só o banco, se a stack não estiver de pé
npm ci
npm test                        # unitários, integração e ponta a ponta (~30 s)
npm run typecheck
npm run check:criteria          # lista critério das specs sem teste (esperado: 80/80)
```

Para usar outro Postgres, defina `TEST_DATABASE_URL`. O nome do banco precisa terminar em `_test`, porque o setup apaga os dados dele.

### Rodar fora do Docker (desenvolvimento)

```bash
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run dev           # API com reload
npm run dev:worker    # worker, em outro terminal
```

### Exemplos de chamadas

O roteiro abaixo percorre o fluxo inteiro. As respostas são de uma execução real; ids e datas mudam a cada vez. O `jq` só serve para guardar os ids em variáveis; sem ele, copie o id da resposta.

**1. Criar a campanha.** As variáveis são extraídas do template.

```bash
ID=$(curl -s -X POST localhost:3000/campaigns \
  -H 'Content-Type: application/json' \
  -d '{"name": "Entrega novembro", "template": "Olá {{nome}}, seu pedido {{pedido}} saiu para entrega."}' \
  | tee /dev/stderr | jq -r .id)
```

```json
{"id":"fb84ecfd-...","name":"Entrega novembro","template":"Olá {{nome}}, seu pedido {{pedido}} saiu para entrega.","variables":["nome","pedido"],"status":"draft","created_at":"2026-11-25T01:25:39.273Z"}
```

**2. Cadastrar contatos, com os problemas típicos de planilha.** O lote não é recusado: os válidos entram e os inválidos voltam com a posição e o motivo.

```bash
curl -s -X POST localhost:3000/campaigns/$ID/contacts \
  -H 'Content-Type: application/json' \
  -d '{"contacts": [
    {"phone": "(11) 98765-4321",   "variables": {"nome": "Ana",  "pedido": "A-100"}},
    {"phone": "11 98765-4321",     "variables": {"nome": "Ana",  "pedido": "A-100"}},
    {"phone": "123",               "variables": {"nome": "Bia",  "pedido": "B-200"}},
    {"phone": "21987650000",       "variables": {"nome": "Caio", "pedido": "C-300"}},
    {"phone": "21987654322",       "variables": {"nome": "Duda"}},
    {                              "variables": {"nome": "Edu",  "pedido": "E-500"}},
    {"phone": "+55 31 99876-5432", "variables": {"nome": "Fê",   "pedido": 1234}}
  ]}'
```

```json
{
  "accepted": 3,
  "rejected": [
    { "index": 1, "phone": "11 98765-4321", "reason": "duplicate_phone" },
    { "index": 2, "phone": "123", "reason": "invalid_phone" },
    { "index": 4, "phone": "21987654322", "reason": "missing_variables", "missing": ["pedido"] },
    { "index": 5, "phone": null, "reason": "missing_phone" }
  ]
}
```

O `21987650000` é aceito no cadastro, porque o formato é válido, mas o provedor simulado recusa números terminados em `0000` com `400 invalid_number` no envio.

**3. Iniciar o envio.** Responde na hora; chamar de novo devolve o estado atual, sem erro.

```bash
curl -s -X POST localhost:3000/campaigns/$ID/start
```

```json
{"id":"fb84ecfd-...","status":"running","started_at":"2026-11-25T01:25:41.675Z"}
```

Depois do `start`, a campanha não aceita mais contatos (`409 campaign_not_draft`).

**4. Acompanhar o andamento.** Repita até `status` virar `completed`. Com a taxa de falha padrão, algumas mensagens podem passar por retry antes (`retrying > 0`).

```bash
curl -s localhost:3000/campaigns/$ID
```

```json
{
  "id": "fb84ecfd-...",
  "status": "completed",
  "started_at": "2026-11-25T01:25:41.675Z",
  "completed_at": "2026-11-25T01:25:42.296Z",
  "contacts": { "accepted": 3, "rejected": 4 },
  "messages": {
    "by_status": { "pending": 0, "sending": 0, "sent": 2, "delivered": 0, "read": 0, "failed": 1 },
    "funnel": { "sent": 2, "delivered": 0, "read": 0, "failed": 1 },
    "retrying": 0,
    "failures_by_reason": { "invalid_number": 1 }
  }
}
```

(campos `name`, `template`, `variables` e `created_at` omitidos aqui)

**5. Ver o motivo de cada falha.** A lista aceita `?status=`, `?limit=` (até 500) e `?offset=`.

```bash
curl -s "localhost:3000/campaigns/$ID/messages?status=failed"
```

```json
{
  "total": 1, "limit": 50, "offset": 0,
  "items": [
    { "phone": "+5521987650000", "status": "failed", "attempts": 1,
      "failure_reason": "invalid_number", "last_error": null, "provider_message_id": null, "...": "..." }
  ]
}
```

**6. Simular os webhooks do provedor, repetidos e fora de ordem.** Pegue o `provider_message_id` de uma mensagem enviada:

```bash
PM=$(curl -s "localhost:3000/campaigns/$ID/messages?status=sent" | jq -r '.items[0].provider_message_id')

webhook() {
  curl -s -X POST localhost:3000/webhooks/provider \
    -H 'Content-Type: application/json' \
    -d "{\"event_id\": \"$1\", \"provider_message_id\": \"$2\", \"status\": \"$3\"}"
  echo
}

webhook evt_001 $PM read           # {"event_id":"evt_001","result":"applied"}    sent → read
webhook evt_002 $PM delivered      # {"event_id":"evt_002","result":"ignored"}    chegou depois do read
webhook evt_001 $PM read           # {"event_id":"evt_001","result":"duplicate"}  mesmo event_id
webhook evt_003 $PM failed         # {"event_id":"evt_003","result":"ignored"}    read é final
webhook evt_004 pm_nao_existe read # {"event_id":"evt_004","result":"pending"}    mensagem ainda não conhecida
```

Os `event_id` precisam ser novos a cada execução do roteiro; repetidos de uma execução anterior voltam `duplicate`.

No relatório, a mensagem conta como lida e também como entregue no funil, e nada regrediu:

```json
"by_status": { "pending": 0, "sending": 0, "sent": 1, "delivered": 0, "read": 1, "failed": 1 },
"funnel":    { "sent": 2, "delivered": 1, "read": 1, "failed": 1 }
```

**Erros de validação** listam todos os campos com problema:

```bash
curl -s -X POST localhost:3000/campaigns -H 'Content-Type: application/json' -d '{"template": ""}'
```

```json
{"error":{"code":"validation_error","message":"Invalid request","details":[
  {"path":"body.name","message":"Invalid input: expected string, received undefined"},
  {"path":"body.template","message":"Template must not be empty"}]}}
```

## 4. O que ficou de fora e próximos passos

### Fora do escopo, de propósito

- **Autenticação e multiempresa.** Em produção, cada requisição teria uma chave de API ou token, e as campanhas pertenceriam a uma conta.
- **Assinatura do webhook.** Hoje qualquer um pode chamar `POST /webhooks/provider`. Um provedor real assina o aviso (ex.: HMAC num header) e a rota validaria a assinatura antes de tudo.
- **Pausar, cancelar e editar campanhas**, e remover contatos. O desenho comporta: pausar seria um estado `paused` que o worker já ignoraria, porque só reserva mensagens de campanha `running`.
- **Listagem de campanhas** (`GET /campaigns`). O enunciado pede o acompanhamento de uma campanha.
- **Upload direto de CSV/planilha.** A API recebe JSON em lotes de até 10.000 contatos; a leitura da planilha fica com o cliente.
- **Telefones de outros países.** A validação assume Brasil.

### Com mais tempo ou em produção

**Envio**
- **Rate limit do provedor.** Hoje só há limite de concorrência. Um provedor real limita envios por segundo e responde `429`, que precisaria ser tratado como passageiro (hoje todo 4xx é definitivo) e respeitar o `Retry-After`.
- **Divisão justa entre campanhas.** A fila é FIFO: uma campanha de 100 mil contatos atrasa uma pequena que começou depois. Daria para reservar em rodízio por campanha.
- **Reduzir o reenvio duplicado.** Com um provedor que aceite chave de idempotência, mandar o id da mensagem como chave tornaria o reenvio após queda do worker inofensivo.
- **Janela de horário.** Não disparar campanha de madrugada, agendar o início.

**Webhooks**
- **Limpeza de eventos pendentes** cujo `provider_message_id` nunca apareceu, e retenção da tabela `provider_events`, que cresce com cada aviso.
- **Responder ao provedor antes de processar** (gravar o evento e processar de forma assíncrona) se o volume de avisos crescer muito.

**Relatório e escala**
- **Contadores mantidos por evento** em vez de `COUNT` a cada consulta, para campanhas de milhões de mensagens.
- **Paginação por cursor** (`seq`) na lista de mensagens, que é mais eficiente que `offset` em páginas distantes.
- **Avisar a empresa quando a campanha terminar** (webhook de saída), em vez de ela ficar consultando.
- **Particionar ou arquivar** mensagens de campanhas antigas.

**Operação**
- **Logs estruturados** (JSON com id da campanha e da mensagem) e **métricas**: tamanho da fila, taxa de falha por motivo, tempo até o envio, tentativas. E alertas, por exemplo fila parada ou taxa de falha alta.
- **Healthcheck do worker** (hoje só a API tem) e **readiness** checando o banco.
- **CI** rodando typecheck, testes e `check:criteria` em cada push, e lint/format automáticos.
- **Documentação da API em OpenAPI**, gerada a partir dos schemas Zod.
- **Pool de conexões e índices** revisados com carga real; teste de carga com campanhas de 100 mil contatos.
