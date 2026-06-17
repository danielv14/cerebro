---
name: cerebro
description: Sök och återhämta innehåll ur alla tidigare Claude Code-sessioner (verbatim-arkiv med fulltextsök). Använd vid "cerebro", "tidigare session", "vad gjorde jag i", "vad sa vi om", "hitta konversationen där", "sök i mina claude-sessioner", "recall session", "förra gången vi", "hur löste vi X tidigare". Till skillnad från vault-recall (kurerad kunskap) frågar detta de råa konversationstranskripten.
---

# cerebro

`cerebro` är ett lokalt CLI som indexerar **alla** Claude Code-sessioner (inklusive de Claude Code redan raderat) till en SQLite-databas och gör dem sökbara. Det är ett verbatim-arkiv: hela konversationer, vilket repo/mapp de tillhör, och subagent-transkript. Använd det för att hitta vad som faktiskt sades eller gjordes i en tidigare session.

Binären finns på PATH som `cerebro`. Om den saknas: `bun run ~/dev-personal/cerebro/src/cli.ts <kommando>`.

> Exempelutdata nedan använder påhittad testdata.

## Arbetsflöde (viktigt: index-först, progressiv exponering)

Dränk inte kontextfönstret. Följ den här trappan:

1. **`cerebro index`** först om sökningen gäller nyligt arbete (indexet är inkrementellt och snabbt; sessioner som är öppna just nu kanske inte är fullständigt skrivna än).
2. **`cerebro search <query>`** eller **`cerebro sessions`** för att hitta rätt tråd. Ger bara id + tidsstämpel + projekt + snippet.
3. **`cerebro show <id>`** för en outline (en rad per meddelande) av den intressanta tråden.
4. **`cerebro show <id> --full`** först när du behöver det ordagranna transkriptet. Hämta inte `--full` i onödan; trådar kan vara tusentals meddelanden.

Id:n kan förkortas till prefixet (8 tecken) som listorna visar. Tvetydiga prefix ger fel.

## Kommandon

### `cerebro index [--full] [--dry-run]`
Indexerar inkrementellt sedan förra körningen. Varje fil har en byte-cursor: oförändrade filer hoppas över helt, filer som vuxit läses bara från cursorn och framåt. Du behöver alltså **inte** köra `--full` i vardagen, bara `cerebro index`. `--full` nollar cursorerna och läser om allt (säkert tack vare dedup på meddelande-UUID, men långsammare och netto 0 nya på ett aktuellt arkiv). `--dry-run` rapporterar vad som skulle indexeras utan att skriva något.

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

## Indexering (mental modell)

- **`cerebro index` är allt du behöver i vardagen.** Den är inkrementell: varje fil har en byte-cursor (`index_state`) med hur långt vi läst plus filens mtime. Oförändrade filer hoppas över helt, filer som vuxit läses bara från cursorn och framåt. Att köra om är billigt.
- **Kör `index` innan du söker i färskt arbete.** Den aktiva sessionen skrivs löpande till disk och fångas vid nästa indexering.
- **`--full` behövs nästan aldrig.** Den nollar cursorerna och läser om allt från början. Dedup på meddelande-UUID gör det ofarligt (netto 0 nya på ett aktuellt arkiv), men det är långsammare. Använd bara vid misstänkt trasigt index eller efter en schema-ändring.
- **`--dry-run` skriver ingenting**, rapporterar bara vad en körning skulle göra (nya meddelanden, bytes, filuppdelning). Bra för att inspektera innan en stor `--full`.
- **Dedup på UUID, inte fil eller session-id.** Samma meddelande som dyker upp i flera filer (resumes, subagent-ekon) lagras en gång. Därför ger `--full` aldrig dubbletter.

## Bra att veta

- **Databas:** `~/.claude/cerebro/archive.sqlite` (override `--db <path>` eller `$CEREBRO_DB`). Den ligger medvetet utanför git-repot: den innehåller privata konversationer ordagrant och växer stort (tiotals MB+).
- **tool_use / tool_result** plattas till greppbar text (`[tool_use:Bash] {...}`, `[tool_result] ...`), så du kan söka på kommandon och filinnehåll som faktiskt kördes.
- **Trådar fäller in resumes:** `sessions` visar bara rötter; återupptagna sessioner och subagent-arbete syns inne i `show`.
