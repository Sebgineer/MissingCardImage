# Agent-brief: repo til manglende kortbilleder

Dette dokument er opgaven til en agent i et **nyt, offentligt GitHub-repo**. Agenten må ikke ændre MyPokeCollection. Den opretter billed-repoet, skriver sine egne søgeregler, henter de manglende scans og lukker dem i backloggen.

Giv agenten filen, og kør derefter en af prompterne nederst.

## Systemet

MyPokeCollection gemmer ikke billedfiler, hverken i git eller i Supabase Storage.

TCGdex leverer et URL-prefix. `cardImage` i `app/utils/cards.ts` sætter `/low.webp` eller `/high.webp` på. Når kataloget har `image: null`, og brugeren er logget ind, upsert’er `reportMissingImages` i `app/composables/useCatalog.ts` én række i `public.missing_card_images`. Det sker fra `loadIllustrationCards`, `loadDexCards`, `loadSetCards` og `loadIllustratorCards`, også når svaret kommer fra IndexedDB-cachen. En tom tabel betyder, at de samlinger ikke er åbnet endnu.

Hver række er ét katalogkort:

| Kolonne | Betydning |
| --- | --- |
| `card_id` | Primærnøgle, fx `swsh9tg-TG01` eller `mep-101` |
| `name` | Kortnavn |
| `set_id` | TCGdex-sæt, fx `swsh9tg` eller `mep` |
| `set_name` | Sættets navn |
| `local_id` | Nummeret i sættet, fx `TG01` eller `101` |
| `created_at` | Hvornår rækken blev lagt ind |
| `resolved_at` | Tom betyder, at billedet stadig mangler |

Appen bruger upsert med `ignoreDuplicates` på `card_id`. En række, der allerede findes, bliver ikke skrevet om. Derfor må agenten **ikke slette** rækken. Når begge billedfiler ligger på repoets default-branch, sættes `resolved_at` til `now()`. Så bliver kortet ikke lagt på listen igen, selv om TCGdex stadig sender `image: null`.

Læs kun de åbne rækker:

```sql
select card_id, name, set_id, set_name, local_id, created_at
from public.missing_card_images
where resolved_at is null
order by created_at;
```

Luk kun de kort, hvis filer er pushet:

```sql
update public.missing_card_images
set resolved_at = now()
where card_id = $1
  and resolved_at is null;
```

Forbindelsen bruger miljøvariablerne `SUPABASE_URL` og `SUPABASE_SERVICE_ROLE_KEY`. Service role går uden om RLS. Indloggede brugere i appen må læse og indsætte, men ikke opdatere eller slette. Nøglen skrives aldrig i git, i commits, i issues eller i chattens svar.

## Filerne

Repoet hedder `poke-card-images` og er offentligt, så jsDelivr kan hente filerne. Stien bygges af `set_id` og `local_id` fra tabellen. Split ikke `card_id`.

```text
poke-card-images/
  AGENTS.md
  <set_id>/<local_id>/low.webp
  <set_id>/<local_id>/high.webp
```

Eksempler:

```text
swsh9tg/TG01/low.webp
swsh9tg/TG01/high.webp
mep/101/low.webp
mep/101/high.webp
```

Den adresse, appen senere kan bruge, er:

```text
https://cdn.jsdelivr.net/gh/<ejer>/poke-card-images@main/<set_id>/<local_id>/<size>.webp
```

`size` er `low` eller `high`. `raw.githubusercontent.com` må ikke være den adresse, appen skal bruge. Den bliver rate-limited, når et binder viser mange kort.

`high.webp` laves fra den største ægte scan. `low.webp` er en mindre udgave til bindergitteret, lang kant omkring 400 px. Begge filer skal findes, før rækken må lukkes. Et HTTP 200, der ikke er et billede, tæller ikke.

## Første handling: skriv reglerne

Før noget downloades, skal agenten oprette `AGENTS.md` i billed-repoet med reglerne nedenfor, og følge den fil ved hvert senere kald. Ret kun `AGENTS.md`, når en kilde er testet og den gamle rækkefølge er forkert.

### Søgeregler

For hvert åbent kort, prøv kilderne i denne rækkefølge. Brug den første, der giver HTTP 200, en content-type der starter med `image/`, og en fil på mindst 20 KB. 403 og 404 betyder, at kilden ikke har billedet. Gå videre.

1. **Pokémon TCG API, samme sæt-id som tabellen**

   - Lav: `https://images.pokemontcg.io/<set_id>/<local_id>.png`
   - Høj: `https://images.pokemontcg.io/<set_id>/<local_id>_hires.png`

   Alle 120 Trainer Gallery-kort findes, når `set_id` er `swsh9tg`, `swsh10tg`, `swsh11tg` eller `swsh12tg`. Brug galleri-id’et. `swsh10/TG01` giver 404, mens `swsh10tg/TG01` giver 200. `mep/101` giver 404. Antag ikke, at nye promoer ligger her. Hvis kun den lave fil findes, må den bruges som kilde til begge webp-filer, og `high.webp` laves i den opløsning, kilden har.

2. **Pokémons eget site**

   `https://www.pokemon.com/static-assets/content-assets/cms2/img/cards/web/<SÆT>/<SÆT>_EN_<NUMMER>.png`

   Sæt-koden er store bogstaver. Nummeret er tre cifre, når `local_id` er et tal (`101` bliver `101`, `1` bliver `001`). `MEP_EN_101` virker og er Nidorina med Pikachu-30-stemplet. `MEP_EN_001` svarer 403 og skal behandles som manglende. Filerne her er ofte mindre end en hires-scan.

3. **Limitless**

   - Stor: `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/<SÆT>/<SÆT>_<NUMMER>_R_EN.png`
   - Mindre: samme sti med `_R_EN_LG.png`

   Sæt-koden her er **ikke** TCGdex-id. `mep` kan prøves som `MEP`. Sword & Shield-gallerier bruger sættets eget kodeord (`BRS`, `ASR`, `LOR`, `SIT`), ikke `swsh9tg`. 403 fra denne host betyder ofte, at objektet ikke findes. Flareon `BRS_TG01` manglede, mens `BRS_TG23` og `BRS_TG30` fandtes. Prøv også suffiksene `C`, `U`, `RR`, `SR` og `HR`, hvis `_R_` fejler. Findes billedet på kilde 1, så stop. Limitless er kun til kort, de første kilder ikke har.

Lykkes ingen kilde, bliver `resolved_at` tom. Kortet prøves igen næste kørsel. Skriv kortet i `still-missing.md` med `card_id`, de URL’er der blev prøvet, og statuskoden, så næste kørsel kan se hvorfor. Den fil må committes. Den er ikke en hemmelighed.

Én række er ét billede. Stempel-varianter får ikke ekstra filer, medmindre de har deres eget `card_id`.

### Arbejdsgang i reglerne

`AGENTS.md` skal også sige:

- Læs kun rækker med `resolved_at is null`.
- Byg stien fra `set_id` og `local_id`.
- Gem ikke billeder i MyPokeCollection eller i Supabase Storage.
- Commit og push begge webp-filer, før `resolved_at` sættes.
- Sæt ikke `resolved_at`, hvis push fejler, eller hvis kun den ene fil kom med.
- Udskriv aldrig `SUPABASE_SERVICE_ROLE_KEY`.
- Læg ikke `.env` i git.

## Senere ændring i MyPokeCollection

Agenten i billed-repoet skal ikke lave denne ændring. Den står her, så filerne passer, når appen engang skal vise dem.

Når `image` er null, kan `CardImage` prøve jsDelivr-adressen ovenfor. Fejler den også, vises den nuværende pladsholder. I `nuxt.config.ts` skal der ligge en `runtimeCaching`-regel for `cdn.jsdelivr.net` ved siden af den, der allerede cacher `assets.tcgdex.net` som `tcgdex-images`. Uden den regel virker de kort ikke offline i PWA’en.

## Prompter

### Første kørsel

Klistres ind i et tomt arbejdsbibliotek, med `SUPABASE_URL` og `SUPABASE_SERVICE_ROLE_KEY` sat i miljøet.

```text
Læs docs/card-image-agent.md fra MyPokeCollection, hvis den ligger her. Ellers følg den brief, der er klistret ind i chatten.

Opret det offentlige GitHub-repo poke-card-images.
Før du downloader noget, skal du skrive AGENTS.md med søgereglerne fra briefet og følge den fil herefter.

Hent derefter de åbne rækker fra missing_card_images, hvor resolved_at er null.
Find et billede til hvert kort i den rækkefølge, AGENTS.md angiver.
Skriv <set_id>/<local_id>/low.webp og high.webp.
Commit, push til default-branchen, og sæt resolved_at kun for de kort, hvis begge filer ligger på den branch.
Kort uden billede bliver stående. Skriv dem i still-missing.md.
Udskriv ikke service role-nøglen, og commit den ikke.
```

### Senere kørsler

Klistres ind i billed-repoet, når backloggen skal tømmes igen.

```text
Læs AGENTS.md, og følg den.

Hent kort fra Supabase-tabellen missing_card_images, hvor resolved_at er null.
Find billederne i den rækkefølge, AGENTS.md angiver.
Skriv <set_id>/<local_id>/low.webp og high.webp.
Commit og push.
Sæt resolved_at kun for kort, hvis begge filer ligger på default-branchen.
Lad resten blive på backloggen, og opdater still-missing.md.
Udskriv ikke service role-nøglen.
```
