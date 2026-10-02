import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root = path.resolve(import.meta.dirname, '..')
const cardsPath = path.join(import.meta.dirname, 'cards.json')
const reportPath = path.join(import.meta.dirname, 'report.json')
const minBytes = 20 * 1024
const concurrency = 4

// Sætkoder fra AGENTS.md. Pokémon TCG API bruger tabellens set_id, med de
// alias der er testet og skrevet ind nedenfor.
const setCodes = {
  swsh9tg: ['BRS'],
  swsh10tg: ['ASR'],
  swsh11tg: ['LOR'],
  swsh12tg: ['SIT'],
  mep: ['MEP'],
  '2015xy': ['MCD15'],
  mee: ['MEE'],
  svp: ['SVP'],
}

const apiAliases = {
  'swsh12.5gg': 'swsh12pt5gg',
  'sm7.5': 'sm75',
  'sm3.5': 'sm35',
  '2016xy': 'mcd16',
  '2021swsh': 'mcd21',
}

const rarities = ['R', 'C', 'U', 'RR', 'SR', 'HR']

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function numberForms(localId) {
  const forms = [localId]
  if (/^\d+$/.test(localId)) forms.push(localId.padStart(3, '0'))
  return unique(forms)
}

function codeCandidates(setId) {
  const upper = setId.toUpperCase()
  return unique([...(setCodes[setId] ?? []), upper, upper.replaceAll('.', '')])
}

async function fetchImage(url, retries = 2) {
  const attempt = { url, status: 0, contentType: '', bytes: 0, ok: false }
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: 'image/*,*/*;q=0.8',
        'User-Agent': 'MissingCardImage/1.0',
      },
    })
    attempt.status = response.status
    attempt.contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim()
    if (response.status === 429 || response.status === 502 || response.status === 503) {
      await response.body?.cancel()
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return fetchImage(url, retries - 1)
      }
      return attempt
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      return attempt
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    attempt.bytes = buffer.length
    attempt.ok = attempt.contentType.startsWith('image/') && buffer.length >= minBytes
    if (attempt.ok) attempt.buffer = buffer
  } catch (error) {
    attempt.status = 0
    attempt.error = error.name === 'TimeoutError' ? 'timeout' : 'network'
    if (retries > 0 && attempt.error === 'timeout') return fetchImage(url, retries - 1)
  }
  return attempt
}

function withoutBuffer(attempt) {
  const { buffer, ...rest } = attempt
  return rest
}

function apiNumbers(localId) {
  if (/^\d+$/.test(localId)) return unique([String(Number(localId)), localId])
  return [localId]
}

async function fromPokemonTcg(card, attempts) {
  const setId = apiAliases[card.set_id] ?? card.set_id
  for (const number of apiNumbers(card.local_id)) {
    const lowUrl = `https://images.pokemontcg.io/${setId}/${number}.png`
    const highUrl = `https://images.pokemontcg.io/${setId}/${number}_hires.png`
    const [low, high] = await Promise.all([fetchImage(lowUrl), fetchImage(highUrl)])
    attempts.push(withoutBuffer(low), withoutBuffer(high))
    if (high.ok) return high.buffer
    if (low.ok) return low.buffer
  }
  return null
}

async function fromPokemonSite(card, attempts) {
  for (const code of codeCandidates(card.set_id)) {
    for (const number of numberForms(card.local_id)) {
      const url = `https://www.pokemon.com/static-assets/content-assets/cms2/img/cards/web/${code}/${code}_EN_${number}.png`
      const image = await fetchImage(url)
      attempts.push(withoutBuffer(image))
      if (image.ok) return image.buffer
    }
  }
  return null
}

async function fromLimitless(card, attempts) {
  for (const code of codeCandidates(card.set_id)) {
    for (const number of numberForms(card.local_id)) {
      for (const rarity of rarities) {
        const largeUrl = `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${code}/${code}_${number}_${rarity}_EN.png`
        const large = await fetchImage(largeUrl)
        attempts.push(withoutBuffer(large))
        if (large.ok) return large.buffer
        const smallUrl = `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${code}/${code}_${number}_${rarity}_EN_LG.png`
        const small = await fetchImage(smallUrl)
        attempts.push(withoutBuffer(small))
        if (small.ok) return small.buffer
      }
    }
  }
  return null
}

async function writeWebp(source, card) {
  const dir = path.join(root, card.set_id, card.local_id)
  await fs.mkdir(dir, { recursive: true })
  const image = sharp(source, { failOn: 'error' })
  const meta = await image.metadata()
  if (!meta.width || !meta.height) throw new Error('not an image')
  const highPath = path.join(dir, 'high.webp')
  const lowPath = path.join(dir, 'low.webp')
  await sharp(source).webp({ quality: 90 }).toFile(highPath)
  const longEdge = Math.max(meta.width, meta.height)
  let low = sharp(source)
  if (longEdge > 400) {
    low = low.resize(
      meta.width >= meta.height
        ? { width: 400, withoutEnlargement: true }
        : { height: 400, withoutEnlargement: true },
    )
  }
  await low.webp({ quality: 80 }).toFile(lowPath)
  const [highStat, lowStat] = await Promise.all([fs.stat(highPath), fs.stat(lowPath)])
  if (highStat.size < 1024 || lowStat.size < 1024) {
    throw new Error('webp output too small')
  }
}

async function alreadyWritten(card) {
  try {
    const dir = path.join(root, card.set_id, card.local_id)
    const [high, low] = await Promise.all([
      fs.readFile(path.join(dir, 'high.webp')),
      fs.readFile(path.join(dir, 'low.webp')),
    ])
    return high.length > 1024 && low.length > 1024 && high.subarray(0, 4).toString() === 'RIFF' && low.subarray(0, 4).toString() === 'RIFF'
  } catch {
    return false
  }
}

async function processCard(card) {
  if (await alreadyWritten(card)) {
    return { card_id: card.card_id, ok: true, skipped: true, attempts: [] }
  }
  const attempts = []
  let source = await fromPokemonTcg(card, attempts)
  let sourceName = 'pokemontcg'
  if (!source) {
    source = await fromPokemonSite(card, attempts)
    sourceName = 'pokemon.com'
  }
  if (!source) {
    source = await fromLimitless(card, attempts)
    sourceName = 'limitless'
  }
  if (!source) {
    return { card_id: card.card_id, set_id: card.set_id, local_id: card.local_id, name: card.name, ok: false, attempts }
  }
  try {
    await writeWebp(source, card)
  } catch (error) {
    return {
      card_id: card.card_id,
      set_id: card.set_id,
      local_id: card.local_id,
      name: card.name,
      ok: false,
      attempts,
      error: 'decode',
    }
  }
  return {
    card_id: card.card_id,
    set_id: card.set_id,
    local_id: card.local_id,
    name: card.name,
    ok: true,
    source: sourceName,
    attempts,
  }
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  let index = 0
  async function run() {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current], current)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return results
}

const cards = JSON.parse(await fs.readFile(cardsPath, 'utf8'))
let done = 0
const results = await mapPool(cards, concurrency, async (card) => {
  const result = await processCard(card)
  done += 1
  const label = result.ok ? result.source ?? 'cached' : 'missing'
  console.log(`${done}/${cards.length} ${card.card_id} ${label}`)
  return result
})

await fs.writeFile(reportPath, JSON.stringify(results, null, 2))
const found = results.filter((result) => result.ok)
const missing = results.filter((result) => !result.ok)
const lines = [
  '# Still missing',
  '',
  'Kort uden gyldigt billede. `resolved_at` er ikke sat.',
  '',
]
for (const card of missing) {
  lines.push(`## ${card.card_id}`)
  lines.push('')
  lines.push(`${card.name ?? ''} (\`${card.set_id}/${card.local_id}\`)`)
  lines.push('')
  for (const attempt of card.attempts ?? []) {
    const detail = [attempt.status || attempt.error || 'error', attempt.contentType, attempt.bytes ? `${attempt.bytes} B` : '']
      .filter(Boolean)
      .join(' ')
    lines.push(`- ${attempt.url} — ${detail}`)
  }
  if (card.error) lines.push(`- decode — ${card.error}`)
  lines.push('')
}
if (missing.length === 0) lines.push('Ingen.')
await fs.writeFile(path.join(root, 'still-missing.md'), `${lines.join('\n')}\n`)
console.log(`found ${found.length}/${results.length}`)
