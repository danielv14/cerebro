---
name: cerebro
description: Sök och återhämta innehåll ur alla tidigare Claude Code-sessioner (verbatim-arkiv med fulltextsök). Använd vid "cerebro", "tidigare session", "vad gjorde jag i", "vad sa vi om", "hitta konversationen där", "sök i mina claude-sessioner", "recall session", "förra gången vi", "hur löste vi X tidigare".
---

# cerebro

`cerebro` är ett lokalt CLI som indexerar **alla** Claude Code-sessioner (inklusive de Claude Code redan raderat) till en SQLite-databas och gör dem sökbara. Det är ett verbatim-arkiv: hela konversationer, vilket repo/mapp de tillhör, och subagent-transkript. Använd det för att hitta vad som faktiskt sades eller gjordes i en tidigare session.

Binären finns på PATH som `cerebro`. Om den saknas: `bun run /path/to/cerebro/src/cli.ts <kommando>`.

> Exempelutdata nedan använder påhittad testdata.

## Arbetsflöde (viktigt: index-först, progressiv exponering)

Dränk inte kontextfönstret. Följ den här trappan:

1. **`cerebro index`** först om sökningen gäller nyligt arbete (indexet är inkrementellt och snabbt; sessioner som är öppna just nu kanske inte är fullständigt skrivna än).
2. **`cerebro search <query>`**, **`cerebro relevant <prompt>`** (relevans-rankat mot en prompt) eller **`cerebro sessions`** / **`cerebro recent`** för att hitta rätt tråd. Ger bara id + tidsstämpel + projekt + snippet.
3. **`cerebro show <id>`** för en outline (en rad per meddelande) av den intressanta tråden.
4. **`cerebro show <id> --full`** först när du behöver det ordagranna transkriptet. Hämta inte `--full` i onödan; trådar kan vara tusentals meddelanden.

Id:n kan förkortas till prefixet (8 tecken) som listorna visar. Tvetydiga prefix ger fel.

## Kommandon

### `cerebro index [--full] [--rebuild] [--dry-run]`
Indexerar inkrementellt sedan förra körningen. Varje fil har en byte-cursor: oförändrade filer hoppas över helt, filer som vuxit läses bara från cursorn och framåt. Du behöver alltså **inte** köra `--full` i vardagen, bara `cerebro index`. `--full` nollar cursorerna och läser om allt (säkert tack vare dedup på meddelande-UUID, men långsammare och netto 0 nya på ett aktuellt arkiv; lagrad text rörs aldrig). `--rebuild` gör som `--full` men skriver dessutom om den lagrade texten för varje meddelande vars källfil finns kvar på disk (behövs efter en ändring i flattening-logiken); meddelanden vars källfil raderats behålls orörda. `--dry-run` rapporterar vad som skulle indexeras utan att skriva något.

```
$ cerebro index
Indexed 128 new message(s) (3/210 files touched).
```

```
$ cerebro index --dry-run
Dry run. Would index:
  New messages:  128
  New bytes:     412 KB
  Files:         1 new, 2 grown, 0 truncated, 207 unchanged (skipped)

Nothing written. Run `cerebro index` to apply.
```

```
$ cerebro index --full --dry-run
Dry run (--full): would re-read all 210 file(s).
  Candidate messages: 24817 (before UUID dedup)
  Bytes to read:      96.4 MB
  On an up-to-date archive dedup collapses this to ~0 net-new messages.
```

### `cerebro search <query> [--limit N]`
Fulltextsök (FTS5), rankad med bm25, snippet-först. `[...]` markerar träffade termer. Flera ord = implicit AND; citattecken för fras. Default limit 20.

```
$ cerebro search "rate limiter" --limit 2
5e6f7a8b  2026-02-10 09:14  assistant  api-server
    … added a token-bucket [rate] [limiter] to the auth middleware, 100 req/min per …
5e6f7a8b  2026-02-10 09:31  user       api-server
    … the [rate] [limiter] should return 429 with a Retry-After header when the …

2 hit(s). Open one with: cerebro show <id>
```

### `cerebro sessions [--project P] [--limit N]`
Listar trådar, senast aktiva först. `--project P` filtrerar på substring i projektets sökväg. Visar `+N resume(s)` för trådar som återupptagits och `[body deleted]` om källfilen är raderad men arkivet finns kvar. Default limit 30.

```
$ cerebro sessions --limit 4
a1b2c3d4  2026-02-12 16:48   162 msgs  my-app
    Add dark mode toggle
5e6f7a8b  2026-02-10 09:31    88 msgs  api-server  +1 resume(s)
    Fix flaky auth test
9c0d1e2f  2026-02-08 14:02   240 msgs  web-shop
    Refactor checkout flow
3a4b5c6d  2026-02-05 11:20    54 msgs  my-app  [body deleted]
    Set up CI pipeline
```

```
$ cerebro sessions --project my-app --limit 2
a1b2c3d4  2026-02-12 16:48   162 msgs  my-app
    Add dark mode toggle
3a4b5c6d  2026-02-05 11:20    54 msgs  my-app  [body deleted]
    Set up CI pipeline
```

### `cerebro recent [--cwd P] [--days D] [--limit N]`
Senaste trådarna för ett repo (default: nuvarande katalog, 14 dagar, 5 trådar), scopat på git-roten. Varje tråd visas med sin öppnings-prompt. Bra för att orientera sig i vad som hänt i ett repo nyligen.

```
$ cerebro recent --limit 2
Recent sessions in my-app (last 14 days):
  a1b2c3d4  2026-02-12   162 msgs  Add dark mode toggle
      opened: Add a dark mode toggle to the settings page, persisted in localStorage
  3a4b5c6d  2026-02-05    54 msgs  Set up CI pipeline
      opened: Set up a GitHub Actions pipeline that runs lint, typecheck and tests

Pull prior context: cerebro show <id>  |  cerebro search "<terms>"
```

### `cerebro relevant <prompt> [--limit N]`
Tidigare trådar mest relevanta för en prompt (FTS, bm25; svenska och engelska stoppord filtreras bort). Varje träff har titel, öppnings-prompt och en matchande snippet. Default 3. Bra när du vill veta om något liknande gjorts förut.

```
$ cerebro relevant "how did we set up CI"
Related past sessions:
  3a4b5c6d  2026-02-05  my-app  Set up CI pipeline
      opened: Set up a GitHub Actions pipeline that runs lint, typecheck and tests
      match:  … the [CI] workflow runs on push, cache the bun install step …

To recall one: cerebro show <id> (add --full for the transcript), or cerebro search "<terms>".
```

`recent` och `relevant` tar `--context` (agent-vänligt block, tyst om inget matchar) och `relevant` tar `--stdin` (läser prompten ur en hooks JSON-payload). Det är vad de automatiska hookarna använder (se "Bra att veta").

### `cerebro show <session-id> [--full]`
Visar en hel logisk tråd (rot + alla resumes + subagent-turer), ordnad kronologiskt. Outline som standard, `--full` ger ordagranna transkriptet. Subagent-turer taggas `[subagent]`.

Outline:
```
$ cerebro show a1b2c3d4
Thread a1b2c3d4  162 message(s)

  1. user      2026-02-12 15:02  Add a dark mode toggle to the settings page, persisted in localStorage …
  2. assistant 2026-02-12 15:02  I'll start by finding the settings page and the theme provider.
  3. assistant 2026-02-12 15:03  [tool_use:Bash] {"command":"rg -l \"ThemeProvider\" src", …}
  4. user      2026-02-12 15:03  [tool_result] src/theme/ThemeProvider.tsx src/pages/Settings.tsx …
 18. assistant 2026-02-12 15:20  [tool_use:Agent] {"subagent_type":"Explore","description":"Find theme tokens"}
 19. user      2026-02-12 15:20  [subagent] List all color tokens in src/theme …

Full transcript: cerebro show <id> --full
```

Full (utdrag):
```
$ cerebro show a1b2c3d4 --full
Thread a1b2c3d4  162 message(s)

──── user · 2026-02-12 15:02 ────
Add a dark mode toggle to the settings page, persisted in localStorage.
...

──── assistant · 2026-02-12 15:02 ────
I'll start by finding the settings page and the theme provider.
```

### `cerebro stats`
Antal trådar / sessioner / meddelanden / raderade källor.

```
$ cerebro stats
Threads:          196
Sessions:         210
Messages:         24817
Deleted sources:  12
```

### `cerebro digest <action>`
Ett kurerat lager ovanpå rådatan: en LLM-skriven sammanfattning per tråd, lagrad i samma databas med eget FTS-index. Sammanfattningarna är täta och ämnesinriktade, så att söka i dem hittar "vad jobbade jag med kring X" mycket bättre än bm25 mot råa transkript. cerebro anropar **aldrig** en LLM själv: det äger prompten och lagringsformatet, och tar emot en sammanfattning som modellen producerat.

**När du ombeds hitta mönster eller relaterat arbete:** börja med `cerebro digest search <query>` (täta sammanfattningar) och fördjupa sedan med `cerebro show <id>`. Faller den tillbaka för tunt, komplettera med `cerebro search` mot rådatan.

**Summeringen pekar på rådatan, oftast räcker den.** Varje summering är nycklad på trådens id, och varje `digest`-rad inleds med det id:t. Det är referensen tillbaka till rådatan: i de allra flesta fall är summeringen good enough för att svara, och du behöver inte öppna transkriptet. Hämta rådatan **bara vid behov**, i den här ordningen:
- `cerebro show <id>` for en outline (en rad per meddelande) om du behöver se förloppet.
- `cerebro show <id> --full` for det ordagranna transkriptet när du behöver exakta formuleringar, kod eller kommandon.
- `cerebro search "<term>"` när du vill träffa ett specifikt meddelande någonstans i tråden (eller i arkivet).

Dränk inte kontexten genom att dra `--full` reflexmässigt; summering → id → outline → full är trappan.

```
$ cerebro digest stale --limit 3
a1b2c3d4  2026-02-12 16:48   162 msgs  my-app  [never summarized]
    Add dark mode toggle
5e6f7a8b  2026-02-10 09:31    88 msgs  api-server  [new activity since summary]
    Fix flaky auth test
9c0d1e2f  2026-02-08 14:02   240 msgs  web-shop  [prompt v1 < v2]
    Refactor checkout flow

3 thread(s) need a summary. Summarize one:
  cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>
```

```
$ cerebro digest search "how did we do the rate limiter"
5e6f7a8b  2026-02-10 09:31  api-server  Fix flaky auth test
    Added a token-bucket [rate] [limiter] to the auth middleware in api-server …

1 summary hit(s). Open one: cerebro show <id>  |  full summary: cerebro digest show <id>
```

```
$ cerebro digest show 5e6f7a8b
Summary for thread 5e6f7a8b  (2026-02-10 09:31, claude-opus-4-8, prompt v1)

Added a token-bucket rate limiter to the auth middleware in api-server. ...
Keywords: src/auth/middleware.ts, rate-limiter, 429, Retry-After
```

**Att producera en sammanfattning.** Modellsteget bor utanför binären. Två vägar:
- En hook eller skill pipear transkriptet genom `claude -p`: `cerebro digest input <id> | claude -p "$(cerebro digest prompt)" | cerebro digest write <id>`.
- Eller du som agent gör det inline: läs `cerebro digest input <id>`, sammanfatta enligt `cerebro digest prompt`, och skriv tillbaka med `cerebro digest write <id>` (sammanfattningen läses från stdin; `--model <namn>` loggar vilken modell som skrev den).

Använd `cerebro digest input <id>`, inte `show <id> --full`, som modell-input: det renderar samma transkript men storleksbegränsat så att det får plats i ett enda modellkontext. Korta trådar kommer ut ordagrant; en jättetråd kapas (water-fill: korta meddelanden behålls helt, de längsta essäerna trimmas först) så att inte ens ett 1M-kontext spräcks. cerebro äger modellvalet: `cerebro digest model <id>` väljer modell efter transkriptets storlek, och clear-hooken frågar den i stället för att hårdkoda tröskeln. Små trådar → `claude-haiku-4-5` (billigast, vanligaste fallet), överstora → `claude-sonnet-4-6[1m]` i ett skott (1M-kontext, platt pris, ingen long-context-premie), så att en tråd på 400-600k tokens summeras hel istället för trunkerad. `[1m]`-suffixet krävs: det är så Claude Code väljer 1M-varianten; utan det får `claude -p` default-fönstret 200k och en jättetråd failar fortfarande med "Prompt is too long". Tröskel och modellnamn kan overridas via `CEREBRO_DIGEST_MODEL`, `CEREBRO_DIGEST_MODEL_LARGE` och `CEREBRO_DIGEST_HAIKU_MAX_CHARS`.

`cerebro digest stale` är reconcilern: kör den då och då (eller schemalagt) så fångas allt osummerat eller inaktuellt. En tråd blir inaktuell igen när den får nya meddelanden eller när prompt-versionen (`DIGEST_PROMPT_VERSION`) höjs. `--ids` ger ett maskinläsbart läge (ett fullt tråd-id per rad, ingen formatering) som skript och hooks kan loopa över utan att skrapa den människoläsbara listan; tom output betyder att inget är stale.

## Indexering (mental modell)

- **`cerebro index` är allt du behöver i vardagen.** Den är inkrementell: varje fil har en byte-cursor (`index_state`) med hur långt vi läst plus filens mtime. Oförändrade filer hoppas över helt, filer som vuxit läses bara från cursorn och framåt. Att köra om är billigt.
- **Kör `index` innan du söker i färskt arbete.** Den aktiva sessionen skrivs löpande till disk och fångas vid nästa indexering.
- **`--full` behövs nästan aldrig.** Den nollar cursorerna och läser om allt från början. Dedup på meddelande-UUID gör det ofarligt (netto 0 nya på ett aktuellt arkiv), men det är långsammare. Använd bara vid misstänkt trasig cursor-state. Efter en ändring i hur meddelanden plattas till text är det `--rebuild` som gäller: den uppdaterar även lagrad text (för filer som finns kvar på disk).
- **`--dry-run` skriver ingenting**, rapporterar bara vad en körning skulle göra (nya meddelanden, bytes, filuppdelning). Bra för att inspektera innan en stor `--full`.
- **Dedup på UUID, inte fil eller session-id.** Samma meddelande som dyker upp i flera filer (resumes, subagent-ekon) lagras en gång. Därför ger `--full` aldrig dubbletter.

## Bra att veta

- **Databas:** `~/.claude/cerebro/archive.sqlite` (override `--db <path>` eller `$CEREBRO_DB`). Den ligger medvetet utanför git-repot: den innehåller privata konversationer ordagrant och växer stort (tiotals MB+).
- **tool_use / tool_result** plattas till greppbar text (`[tool_use:Bash] {...}`, `[tool_result] ...`), så du kan söka på kommandon och filinnehåll som faktiskt kördes. Varje sådant block kapas till första 1 KB (`[+N chars truncated]`-markör) eftersom huvudet rymmer det sökbara (tool-namn, file_path, kommando) medan resten är reproducerbart brus. Prosa och resonemang lagras ordagrant; fel (`[tool_result:error]`) kapas inte.
- **Trådar fäller in resumes:** `sessions` visar bara rötter; återupptagna sessioner och subagent-arbete syns inne i `show`.
- **Automatiska hooks:** en `UserPromptSubmit`-hook kör `cerebro relevant --stdin --context` per prompt och injicerar möjligen relevanta trådar som bakgrundskontext (taggade som sådant, ignorera om de inte hör hit). `relevant` matchar **summeringarna först** (kurerat, hög signal) och faller tillbaka på rådata-bm25 for trådar som ännu inte summerats; en träff märkt `summary:` kommer från summeringen, `match:` från rådatan. En `SessionEnd`-hook vid `/clear` indexerar synkront och summerar sedan den just rensade sessionen i bakgrunden via `claude -p` (best-effort; `cerebro digest stale` är reconcilern som fångar det som missas). Du kan ändå proaktivt köra `relevant`/`search`/`digest search` när du vill gräva djupare.
