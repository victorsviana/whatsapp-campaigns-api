# Spec 00: Visão geral

## Objetivo

Permitir que uma empresa envie mensagens de WhatsApp em massa por meio de **campanhas**: cadastrar a campanha e seus contatos, disparar o envio por um provedor externo e acompanhar o resultado de cada mensagem.

## Como ler as specs

| Spec | Assunto | Prefixo dos critérios |
|---|---|---|
| [00-visao-geral.md](00-visao-geral.md) | Glossário, ciclos de vida, premissas gerais | — |
| [01-campanhas.md](01-campanhas.md) | Criar campanha e cadastrar contatos | `CMP-xx` |
| [02-envio.md](02-envio.md) | Iniciar campanha, worker e retry | `SND-xx` |
| [03-webhooks.md](03-webhooks.md) | Avisos do provedor (repetidos e fora de ordem) | `WHK-xx` |
| [04-relatorio.md](04-relatorio.md) | Acompanhamento do andamento | `RPT-xx` |

Cada critério de aceite tem um ID único. **Todo critério precisa de pelo menos um teste automatizado com o mesmo ID no nome**, por exemplo `it('CMP-03: rejeita telefone duplicado')`.

## Glossário

| Termo | Significado |
|---|---|
| **Campanha** | Um envio em massa: tem um nome, um template e uma lista de contatos. |
| **Template** | Texto com variáveis no formato `{{nome}}`. Ex.: `Olá {{nome}}, seu pedido {{pedido}} saiu para entrega.` |
| **Variável** | Um nome entre `{{ }}` no template. Cada contato precisa informar um valor para cada variável. |
| **Contato** | Um telefone mais os valores das variáveis, vindos da planilha do cliente. |
| **Mensagem** | O envio do template renderizado para **um** contato aceito. Ao ser aceito, cada contato vira uma mensagem. É a unidade que é enviada, tentada de novo e acompanhada. |
| **Contato rejeitado** | Contato que não passou na validação (telefone ausente, inválido, duplicado ou variável faltando). Não vira mensagem; o motivo é devolvido para quem cadastrou. |
| **Provedor** | Serviço externo que de fato envia a mensagem (simulado por `fakeProvider.js`). |
| **`provider_message_id`** | ID que o provedor devolve quando aceita uma mensagem. É o elo entre a nossa mensagem e os webhooks. |
| **Webhook / evento** | Aviso que o provedor manda para a nossa API dizendo o que aconteceu com uma mensagem (`delivered`, `read` ou `failed`). Cada um tem um `event_id`. |
| **Falha transitória** | Erro do provedor que pode dar certo numa nova tentativa (status 5xx, ex.: `503 provider_unavailable`). |
| **Falha definitiva** | Erro que não adianta tentar de novo (status 4xx, ex.: `400 invalid_number`). |

## Atores

```
 Empresa (cliente da API) ──► cria campanha, cadastra contatos, inicia, consulta andamento
 Worker (processo nosso)  ──► envia as mensagens pendentes para o provedor
 Provedor externo         ──► recebe os envios e depois avisa o resultado via webhook
```

## Ciclo de vida da campanha

```
           POST /campaigns                POST /campaigns/:id/start         worker: nenhuma mensagem
                 │                                  │                       pendente ou em envio
                 ▼                                  ▼                                │
            ┌─────────┐                       ┌──────────┐                           ▼
            │  draft  │──────────────────────►│ running  │─────────────────────►┌───────────┐
            └─────────┘                       └──────────┘                      │ completed │
   aceita novos contatos               não aceita novos contatos                └───────────┘
```

| Estado | Pode cadastrar contatos? | Worker envia? |
|---|---|---|
| `draft` | Sim | Não |
| `running` | Não | Sim |
| `completed` | Não | Não (nada a enviar) |

`completed` significa que **o envio terminou**, não que todos os webhooks chegaram. Uma mensagem de campanha `completed` ainda pode mudar de `sent` para `delivered` ou `read`.

## Ciclo de vida da mensagem

```
                          worker pega
  contato aceito ──► pending ──────────► sending ──── provedor aceitou ────► sent ──webhook──► delivered ──webhook──► read
                       ▲                    │
                       │  falha transitória │
                       └────────────────────┤  (attempts < máximo: volta para pending com next_attempt_at no futuro)
                                            │
                                            ├── falha definitiva ─────────────────────────────► failed
                                            └── falha transitória e attempts = máximo ─────────► failed

                    sent ──webhook "failed"──► failed
```

| Estado | Significado | Terminal? |
|---|---|---|
| `pending` | Aguardando envio. Pode já ter tentativas anteriores (`attempts > 0`) e uma data mínima para a próxima (`next_attempt_at`). | Não |
| `sending` | Um worker reservou a mensagem e está chamando o provedor. | Não |
| `sent` | O provedor aceitou e devolveu o `provider_message_id`. | Não |
| `delivered` | Webhook confirmou a entrega no aparelho. | Não |
| `read` | Webhook confirmou a leitura. | Sim |
| `failed` | Não foi possível entregar. `failure_reason` explica o motivo. | Sim |

Regra central dos webhooks (detalhada na spec 03): **o status só avança, nunca volta.** A ordem é `sent < delivered < read`, e `failed` é terminal. Por isso um `delivered` que chega depois de um `read` é ignorado.

Uma tentativa que falha de forma transitória volta para `pending` em vez de ganhar um estado próprio. O número de tentativas fica em `attempts`, e o relatório pode mostrar quantas mensagens pendentes já tiveram retry.

## Premissas gerais

Pontos que o enunciado não define e que assumi. Cada spec detalha as premissas do seu assunto.

1. **Sem autenticação nem multiempresa.** A API atende uma única empresa; autenticação fica fora do escopo do teste.
2. **Garantia "pelo menos uma vez" no envio.** Se o worker cair depois de o provedor aceitar a mensagem e antes de gravarmos o resultado, a mensagem pode ser enviada de novo. O provedor simulado não aceita chave de idempotência, então não há como garantir "exatamente uma vez". O risco é documentado e reduzido ao mínimo.
3. **Não há pausa nem cancelamento de campanha.** Ficam como próximo passo no README.
4. **Telefones brasileiros.** A normalização assume Brasil (DDI 55) quando o número vier sem DDI.
5. **Horário em UTC.** Datas são gravadas e devolvidas em ISO 8601 UTC.
