# Arquitetura para agentes de codificação: diagnóstico e proposta

Revisão de 2026-10-29. **Status:** P0, P1 e P2 implementados no PR #39. Objetivo: deixar o repositório mais seguro e barato de
modificar por agentes de IA (Claude Code, o repair agent de `src/agent`, outros
que leem `AGENTS.md`), sem mudar o comportamento do produto.

## O que já funciona bem

- **Loop de feedback rápido**: `pnpm typecheck` (~2 s), `pnpm test` (258 testes,
  ~2,5 s) e `wrangler deploy --dry-run` (~2 s). Um agente pode validar cada
  mudança em menos de 10 s.
- **Vocabulário e decisões explícitos**: `GLOSSARY.md` com termos "_Avoid_" e
  seis ADRs. Agentes têm onde ancorar nomes e onde checar conflitos.
- **Módulos com cabeçalho de responsabilidade** (`Owns / Depends on / Does NOT
know about`) e seams injetáveis (`transport`, `now`, `writer`, `quota`), o que
  torna os testes determinísticos.
- **Repair agent com guarda-corpos**: diff restrito a `src/`, limite de linhas,
  conteúdo do Sentry tratado como dado não confiável, só abre PR draft.

## Problemas encontrados

| #   | Problema                                                                                                                                                       | Evidência                                                                                                                                                                                                                     | Efeito em agentes                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | `AGENTS.md` só aponta para skills; não diz como rodar, testar ou o que não tocar.                                                                              | `AGENTS.md` (3 seções, nenhum comando)                                                                                                                                                                                        | Cada sessão redescobre comandos e regras lendo README e código.                                              |
| 2   | As regras de fronteira existem só em comentários.                                                                                                              | `src/server/app.ts`, `src/worker.ts`, `src/shared/index.ts`, `SYSTEM_PROMPT` em `src/agent/prompt.ts`                                                                                                                         | Nada falha quando um agente importa `node:*` ou `src/yt` no grafo do Worker.                                 |
| 3   | O CI não empacota o Worker.                                                                                                                                    | `.github/workflows/ci.yml` roda typecheck, test e format:check; o bundle só acontece no job `deploy`, já no `main`                                                                                                            | Um PR verde pode quebrar o deploy depois do merge.                                                           |
| 4   | A verificação do repair agent é mais fraca que o CI.                                                                                                           | `VERIFY_STEPS = ['typecheck', 'test']` em `src/agent/diagnose.ts`                                                                                                                                                             | O agente abre PRs que falham em `format:check` (e que quebrariam o bundle).                                  |
| 5   | Convenções duplicadas: o `SYSTEM_PROMPT` do repair agent tem regras (named exports, JSDoc, sem `process.env` fora de `cli/agent`) que não estão em nenhum doc. | `src/agent/prompt.ts:32`                                                                                                                                                                                                      | Agentes interativos não as veem; as duas cópias vão divergir.                                                |
| 6   | As skills declaradas não estão no repositório.                                                                                                                 | `skills-lock.json` lista 37 skills; `.agents/` está no `.gitignore`                                                                                                                                                           | Sessões na nuvem e no CI não têm `/triage`, `/tdd`, `/domain-modeling`… que os docs de `docs/agents/` citam. |
| 7   | `docs/agents/issue-tracker.md` exige o CLI `gh`.                                                                                                               | "Use the `gh` CLI for all operations"                                                                                                                                                                                         | Ambientes sem `gh` (sessões na nuvem com MCP do GitHub) seguem uma instrução que não conseguem cumprir.      |
| 8   | Referências que levam a lugar nenhum.                                                                                                                          | `src/cli/ingest.ts` cita `.scratch/build-spec/issue.md` (ignorado pelo git); `src/shared/index.ts` cita "wayfinder #3"; `src/db/index.ts` descreve só SQLite e só exporta `{}`; README: "`cp .env.example .env # if present`" | O agente procura a fonte, não acha, e chuta.                                                                 |
| 9   | Hotspot: `runIngest` tem ~350 linhas e 10 passos numa função; `ingest.test.ts` tem 783 linhas.                                                                 | `src/cli/ingest.ts:199`                                                                                                                                                                                                       | Mudanças pequenas exigem ler o arquivo inteiro; diffs maiores, conflitos mais prováveis, contexto caro.      |

## Proposta (por prioridade)

### P0: barato e de alto impacto

**1. Transformar `AGENTS.md` no ponto de entrada.** Manter as seções de skills e
adicionar, em até cerca de 80 linhas:

- _Comandos_: `pnpm install`, `pnpm check` (ver item 3), como rodar um único
  teste (`pnpm exec tsx --test src/yt/anchors.test.ts`).
- _Mapa de módulos_: uma linha por pasta de `src/` com o que ela possui.
- _Regras de fronteira_ (ver item 2) e _convenções_ (movidas do
  `SYSTEM_PROMPT`).
- _Zonas de perigo_: `migrations/` (só arquivos novos, nunca editar um já
  aplicado), `.github/workflows/`, `wrangler.jsonc`, `--remote` (escreve no D1
  de produção), segredos em `.env`.
- _Definição de pronto_: `pnpm check` verde, glossário respeitado, ADR citado ou
  criado quando houver decisão.

Criar `CLAUDE.md` contendo apenas `@AGENTS.md`, para o Claude Code carregar o
mesmo arquivo sem duplicar conteúdo.

**2. Fronteiras verificadas por teste.** Adicionar `src/architecture.test.ts`
(sem dependências novas: lê os `import` com regex e roda no `pnpm test`), com a
matriz:

| Módulo                       | Pode importar                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `shared`                     | nada                                                                            |
| `yt`                         | `shared`                                                                        |
| `db`                         | `shared` (só `sqlite.ts` pode usar `node:*` e `better-sqlite3`)                 |
| `server` (exceto `index.ts`) | `db/executor`, `db/queries`, `db/d1`, `shared`; sem `node:*`, sem `process.env` |
| `worker.ts`                  | `server/app`, `db/d1`                                                           |
| `cli`                        | `yt`, `db`, `shared`                                                            |
| `agent`                      | só `agent` e `node:*` (pipeline isolado, ADR-0006)                              |

A mensagem de falha deve citar a regra e o ADR, porque é ela que o agente lê.
Arquivos `*.test.ts` ficam fora da matriz. Conferi os imports atuais: todas essas regras já são respeitadas, então o teste entra verde.

**3. Um comando de verificação: `pnpm check`.**

```jsonc
"build:worker": "wrangler deploy --dry-run --outdir .wrangler/check",
"check": "pnpm typecheck && pnpm test && pnpm format:check && pnpm build:worker"
```

Usar o mesmo comando no CI (resolve o problema 3) e no `VERIFY_STEPS` do repair
agent (resolve o 4). Um só comando dá a todos os agentes a mesma definição de
"verde".

**4. Corrigir as referências quebradas** do problema 8: apontar para
`docs/spec/v1.md` e para os ADRs, remover o `src/db/index.ts` vazio ou
atualizá-lo para D1, corrigir o README.

### P1: estrutura

**5. Skills reprodutíveis.** Escolher o subconjunto usado de fato (por exemplo
`triage`, `tdd`, `diagnosing-bugs`, `domain-modeling`,
`improve-codebase-architecture`, `code-review`) e:

- _versioná-las_ em `.claude/skills/` (simples, funciona em qualquer ambiente); ou
- instalá-las num hook `SessionStart` a partir do `skills-lock.json`.

Tirar do lock as que não se aplicam a este projeto (`scaffold-exercises`,
`migrate-to-shoehorn`, `writing-*`, `teach`…), para que a lista de skills
carregada no contexto do agente seja curta e relevante.

**6. Issue tracker neutro quanto à ferramenta.** Em `issue-tracker.md`, descrever
as operações (criar, ler, rotular, fechar) e citar `gh` _ou_ as ferramentas do
MCP do GitHub como formas equivalentes.

**7. Uma única fonte de convenções para o repair agent.** Gerar a seção de
convenções do `SYSTEM_PROMPT` a partir de um bloco marcado em `AGENTS.md`
(`<!-- conventions:start --> … <!-- conventions:end -->`), lido por
`collectContext`. Um teste garante que o bloco existe. Assim, mudar uma regra
muda o comportamento dos dois tipos de agente.

**8. Quebrar o pipeline de ingest.** Criar `src/ingest/` (o glossário já chama a
Ingest de pipeline) com:

- `pipeline.ts`: os passos 4–9 como funções puras ou com transport injetado
  (`resolveChannel`, `listUploadIds`, `enrichVideos`, `fetchComments`,
  `detectAllAnchors`) que retornam `IngestRows`;
- `cli/ingest.ts` como adaptador fino: argumentos, env, reporter de status,
  escolha do writer, código de saída.

Cada passo ganha um teste pequeno; o teste de ponta a ponta do CLI fica para os
caminhos de erro e exit codes. É o maior ganho de "contexto por mudança" do
repositório.

### P2: refinamentos

**9. Índice de ADRs** (`docs/adr/README.md`): uma linha por ADR, com status e as
pastas que ele afeta, para o agente decidir o que ler sem abrir os seis.

**10. Configuração tipada num lugar só.** `src/worker.ts` (`Env`) e
`src/server/index.ts` (`process.env`) montam as mesmas opções de `createApp`;
extrair um `appOptionsFrom(source)` evita que um agente adicione uma variável
num runtime e esqueça o outro.

**11. Hooks opcionais do Claude Code** em `.claude/settings.json`: `prettier
--write` após edições (`PostToolUse`) e bloqueio de escrita em `migrations/`
existentes e em `.env`. Isso transforma as zonas de perigo em regras aplicadas,
não só documentadas.

## Ordem sugerida de PRs

1. `pnpm check` + CI + `VERIFY_STEPS` (itens 3 e 4 do diagnóstico).
2. `src/architecture.test.ts`.
3. `AGENTS.md` / `CLAUDE.md` + referências corrigidas.
4. Skills e issue tracker.
5. Convenções em fonte única para o repair agent.
6. Extração de `src/ingest/`.

Os passos 1 a 3 cabem em um dia e já mudam o que um agente consegue verificar
sozinho. O 6 é o único refactor de código de produção e deve ter ADR próprio se
alterar a fronteira CLI ↔ pipeline descrita na spec §5.
