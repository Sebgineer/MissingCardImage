# Søgeregler for manglende kortbilleder

Følg denne fil ved hvert kald. Ret den kun, når en kilde er testet og den gamle rækkefølge er forkert.

Repoet er det offentlige `Sebgineer/MissingCardImage`. Appen kan senere hente filerne her:

```text
https://cdn.jsdelivr.net/gh/Sebgineer/MissingCardImage@main/<set_id>/<local_id>/<size>.webp
```

`size` er `low` eller `high`. Brug ikke `raw.githubusercontent.com`. Den bliver rate-limited, når et binder viser mange kort.

## Filer

Stien bygges af `set_id` og `local_id` fra tabellen. Split ikke `card_id`.

```text
<set_id>/<local_id>/low.webp
<set_id>/<local_id>/high.webp
```

`high.webp` laves fra den største ægte scan. `low.webp` er en mindre udgave til bindergitteret, lang kant omkring 400 px. Begge filer skal findes, før rækken må lukkes. Et HTTP 200, der ikke er et billede, tæller ikke.

Én række er ét billede. Stempel-varianter får ikke ekstra filer, medmindre de har deres eget `card_id`.

## Arbejdsgang

- Læs kun rækker med `resolved_at is null` fra `public.missing_card_images`.
- Byg stien fra `set_id` og `local_id`.
- Gem ikke billeder i MyPokeCollection eller i Supabase Storage.
- Commit og push begge webp-filer, før `resolved_at` sættes.
- Sæt ikke `resolved_at`, hvis push fejler, eller hvis kun den ene fil kom med.
- Udskriv aldrig `SUPABASE_SERVICE_ROLE_KEY`.
- Læg ikke `.env` i git.

Luk kun de kort, hvis begge filer ligger på default-branchen `main`:

```sql
update public.missing_card_images
set resolved_at = now()
where card_id = $1
  and resolved_at is null;
```

Slet ikke rækken. Appen upsert’er med `ignoreDuplicates`, så en slettet række kan blive lagt ind igen.

Lykkes ingen kilde, bliver `resolved_at` tom. Kortet prøves igen næste kørsel. Skriv kortet i `still-missing.md` med `card_id`, de URL’er der blev prøvet, og statuskoden. Den fil må committes. Den er ikke en hemmelighed.

## Søgeregler

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

   Sæt-koden her er **ikke** TCGdex-id. `mep` kan prøves som `MEP`. Sword & Shield-gallerier bruger sættets eget kodeord, ikke `swsh9tg`:

   | `set_id` | sætkode |
   | --- | --- |
   | `swsh9tg` | `BRS` |
   | `swsh10tg` | `ASR` |
   | `swsh11tg` | `LOR` |
   | `swsh12tg` | `SIT` |

   403 fra denne host betyder ofte, at objektet ikke findes. Flareon `BRS_TG01` manglede, mens `BRS_TG23` og `BRS_TG30` fandtes. Prøv også suffiksene `C`, `U`, `RR`, `SR` og `HR`, hvis `_R_` fejler. Findes billedet på kilde 1, så stop. Limitless er kun til kort, de første kilder ikke har.

Hent scriptet `scripts/fetch-cards.mjs` følger denne rækkefølge. Kør det kun efter denne fil er committet.
