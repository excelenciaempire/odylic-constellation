/**
 * Naming-convention fields, detected from the ad names alone (no saved
 * convention, no setup). Real accounts mix conventions, so every name is
 * read on its own and the pieces are pooled afterwards:
 *
 *   1. Clean    Meta's duplicate suffixes ("- Copy 2", "Copy of", "(2)"),
 *               emoji and links go.
 *   2. Split    on the name's strongest separator: | then " - " then _
 *               then -. Bracket groups [like this] are tokens of their own.
 *   3. Keys     `FP:MOF`, `angle=pain`, `2:Runners` and (when a family of
 *               names uses them) `f-TOF` tokens become a field named by
 *               the key: FP is Funnel, AN Angle, PE Persona, TY Type ...
 *   4. Families names that share a separator and a first-token shape line
 *               up position by position. Tokens that say what they are
 *               (TOF, Static, UGC, High, v2, 9x16, @creator, a date) but
 *               move around are pulled out to a field of their own, so an
 *               optional token never shifts the rest; a variable tail is
 *               lined up from the end when that groups better.
 *   5. Pool     the same field written different ways (FP:MOF next to
 *               MOF_..., a pipe name's format next to a dash name's) is one
 *               field. Values fold across case, spacing, accents, plurals
 *               and one-letter typos.
 *
 * A field is kept when it groups: 2 to 40 values and most ads in a value
 * that repeats (ids, dates and free text drop out). Labels come from a key,
 * then from what the values look like, else "Name field N". Ads with no
 * value show as "(other)" in the space.
 *
 * Pure functions, no React: unit tested in autoNaming.test.ts.
 */

export type NamingFieldSource = 'keyed' | 'positional' | 'mixed'

export type NamingField = {
  /** Stable key, `nm:` prefixed (the space's field key). */
  key: string
  label: string
  source: NamingFieldSource
  /** Ads carrying a value. */
  coverage: number
  /** Distinct values (folded). */
  distinct: number
  /** Most common values, most common first. */
  examples: string[]
}

export type AutoNaming = {
  fields: NamingField[]
  /** ad id to field key to value. Ads outside every pattern are absent. */
  values: Map<string, Record<string, string>>
  /** Separator of the most common positional pattern, null when none was found. */
  separator: string | null
  /** Ads whose names carry KEY:value pairs. */
  keyedCount: number
  /** Ads whose names split into 2 or more plain tokens. */
  positionalCount: number
  /** Ads with no value in any field (free text, or a pattern too rare to keep). */
  otherCount: number
}

export type NamedAd = { id: string; name: string }

// ── Text ───────────────────────────────────────────────────────────────────

/** A string function remembered per input (names repeat their tokens thousands of times). */
function memo<T>(fn: (s: string) => T): (s: string) => T {
  const cache = new Map<string, T>()
  return (s: string) => {
    let v = cache.get(s)
    if (v === undefined) {
      v = fn(s)
      if (cache.size > 100000) cache.clear()
      cache.set(s, v)
    }
    return v
  }
}

const stripMarks = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '')

/** Spelling-blind form: "Social Proof", "SocialProof", "social-proof" and "Sócial proof" are one value. */
export const compact = memo((v: string) => stripMarks(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))

/** Lower-case words with camelCase and letter/digit runs split: "MenOver50" reads "men over 50". */
export const words = memo((v: string): string =>
  stripMarks(v)
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim())

/** Every run of 1 to 4 words: "busy mom over 40" holds "busy mom" and "over 40". */
function grams(w: string): string[] {
  const t = w ? w.split(' ') : []
  const out: string[] = []
  for (let n = 1; n <= 4; n++) for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n).join(' '))
  return out
}

const wordSet = (s: string) => new Set(s.split(',').map(words).filter(Boolean))

/** "n/a", "none", "Não se aplica": a slot left empty, not a value. */
const PLACEHOLDERS = wordSet('na,n a,none,null,nan,tbd,nao se aplica,no aplica,not applicable')
/** A sentence, not a value: long, or many words. */
const isFreeText = (v: string) => v.length > 60 || v.split(/\s+/).length > 8

export const isPlaceholder = (v: string) => {
  const w = words(v)
  return !w || PLACEHOLDERS.has(w)
}

// ── Vocabulary ─────────────────────────────────────────────────────────────

type Cls =
  | 'funnel' | 'format' | 'style' | 'type' | 'quality' | 'overlay' | 'placement' | 'emotion'
  | 'offer' | 'moment' | 'landing' | 'identity' | 'cta' | 'angle' | 'persona' | 'gender' | 'age'
  | 'language' | 'market' | 'product' | 'version' | 'hook' | 'ratio' | 'length' | 'creator'
  | 'date' | 'id' | 'number'

const CLASS_LABEL: Record<Cls, string> = {
  funnel: 'Funnel (ad name)', format: 'Format', style: 'Production style', type: 'Type', quality: 'Quality',
  overlay: 'Overlay', placement: 'Placement', emotion: 'Emotion', offer: 'Offer', moment: 'Moment',
  landing: 'Landing page', identity: 'Identity', cta: 'CTA', angle: 'Angle', persona: 'Persona',
  gender: 'Gender', age: 'Age', language: 'Language', market: 'Market', product: 'Product',
  version: 'Version', hook: 'Hook', ratio: 'Ratio', length: 'Length', creator: 'Creator',
  date: 'Date', id: 'ID', number: 'Number',
}

/** Not a grouping: a field made of these is dropped. */
const NOT_GROUPS: ReadonlySet<Cls> = new Set<Cls>(['date', 'id', 'number'])

/**
 * Whole tokens that say what they are wherever they sit in a name (a family
 * whose positions drift still finds them). Words are compared as `words()`.
 */
const STRONG: Partial<Record<Cls, Set<string>>> = {
  funnel: wordSet('tof,tofu,mof,mofu,bof,bofu,top of funnel,top funnel,middle of funnel,mid funnel,bottom of funnel,bottom funnel,upper funnel,lower funnel,prospecting,prospect,retargeting,retarget,remarketing,rmkt,rtg,awareness,consideration,retention,reactivation,winback,win back,acquisition'),
  type: wordSet('net new,netnew,iteration,iterations'),
  format: wordSet('static,statics,still,stills,image,images,img,imagem,imagen,photo,photos,video,videos,vid,vids,gif,gifs,carousel,carousels,carrousel,carrossel,carrusel,slideshow,dpa,dco,catalog,catalogue,catalogo,catalog ad,dynamic catalog ad,flexible,flex,flexible ad,flexible ads,flexible image,flexible images,flexible video,flexible videos,motion graphic,motion graphics,single image,single video,image carousel,video carousel,estatico,estatico individual,ugc video,ugc static,ugc image,cinemagraph,boomerang,collection ad'),
  style: wordSet('ugc,in house,inhouse,studio,agency,agency 1,agency 2,founder,founder led,creator,creators,influencer,influencers,lifestyle,graphic,graphics,ai,ai generated,cgi,ai cgi,stock,stock footage,meme,memes,talking head,podcast,green screen,greenscreen,packshot,pack shot,mashup,lofi,lo fi,polished,illustration,hand drawn,flat lay,producao interna,video producao interna,video creator,creator video,street interview,broll,b roll,editorial,photoshoot,animation,animated,3d,render,renders'),
  quality: wordSet('high,medium,low'),
  overlay: wordSet('y,n'),
  placement: wordSet('all,feed,feeds,story,stories,reels,all placements,in stream,instream,right column,audience network,explore,ig feed,fb feed,ig stories,ig story,ig reels,fb reels,fb stories,feed story,feed and story,feed stories,feed reels'),
  emotion: wordSet('desire,self actualization,excitement,excitment,safety,saftey,trust,nurture,nurturance,relief,fear,joy,curiosity,belonging,pride,nostalgia,hope,empowerment,reassurance,fomo,comfort,confidence,happiness,gratitude,security,love,anxiety,frustration'),
}
const STRONG_ORDER: Cls[] = ['funnel', 'type', 'format', 'style', 'quality', 'overlay', 'placement', 'emotion']

/** More words per class, for labelling a whole field by its values (any run of words in a value). */
const LOOSE: Partial<Record<Cls, Set<string>>> = {
  funnel: wordSet('cold,warm,hot,ra,rt,acq,mid,conversion,conversions,conv,full funnel,existing customers,new customers,cold traffic,warm traffic'),
  format: wordSet('collection,reel,reels,story,motion,animation,animated,dynamic,mp 4,text only,instant experience,canvas,iab,statico,video ad,image ad,photo ad,still image,stat'),
  style: wordSet('native,product shot,screen recording,voiceover,voice over,ai voiceover,creator talking,talking,phone shot,selfie,in house video'),
  type: wordSet('new,refresh,winner,winners,scale,scaling,remix,variation,variant,relaunch,repurpose,repurposed,past winner,new concept,iterate'),
  offer: wordSet('no offer,offer,offers,sale,discount,promo,promocional,promotion,coupon,cupom,bogo,free shipping,frete,frete gratis,gwp,gift with purchase,bundle,bundles,subscribe and save,subscribe save,subscription,free gift,flash sale,clearance,deal,deals,price drop,gift card,desconto,intro offer,welcome offer,free trial'),
  moment: wordSet('bfcm,black friday,cyber monday,cyber week,holiday,holidays,christmas,xmas,mothers day,mother s day,fathers day,father s day,valentine,valentines,valentine s day,vday,v day,back to school,prime day,memorial day,labor day,labour day,4th of july,july 4th,fourth of july,new year,new years,nye,easter,halloween,thanksgiving,summer sale,spring sale,winter sale,fall sale,launch,evergreen,seasonal,singles day,boxing day,super bowl,world cup,graduation,march madness,spring cleaning'),
  landing: wordSet('pdp,plp,lp,landing page,homepage,home page,hp,collection page,sale page,product page,listicle,advertorial,quiz,shop page,category page,main page,custom landing page'),
  identity: wordSet('whitelisting,whitelist,whitelisted,wl,partnership,partnership ad,partnership ads,partner,spark,spark ad,spark ads,organic post,existing post,dark post,br,og,single profile identity,dynamic profile identity,dual identity,brand page,creator page,boosted'),
  cta: wordSet('shop now,learn more,sign up,order now,buy now,get offer,subscribe,book now,download,apply now,contact us,get started,watch more,send message,call now,get quote,claim offer'),
  angle: wordSet('problem solution,problem x solucao,social proof,testimonial,testimonials,review,reviews,before after,before and after,antes x depois,us vs them,us vs,comparison,versus,vs,founder story,how to,tutorial,education,educational,educativo,benefit,benefits,feature,features,ingredient,ingredients,objection,objections,faq,unboxing,demo,product demo,pain point,pain points,myth,myths,authority,autoridade,expert,statistic,statistics,stats,giveaway,urgency,scarcity,gifting,price anchor,price justification,transformation,routine,aspirational,trend,trending,press,award,awards,mission,origin story,behind the scenes,clickbait,listicle,problem,solution,results,proof,taste test'),
  persona: wordSet('mom,moms,mother,mothers,dad,dads,father,parent,parents,caregiver,caregivers,professional,professionals,seeker,seekers,skeptic,skeptics,giver,givers,gifter,gifters,lover,lovers,enthusiast,enthusiasts,athlete,athletes,runner,runners,gamer,gamers,student,students,senior,seniors,retiree,retirees,women,woman,men,man,female,male,general,gen z,boomer,boomers,millennial,millennials,traveler,travelers,traveller,foodie,bride,brides,homeowner,homeowners,pet owner,dog owner,dog lover,cat owner,nurse,nurses,teacher,teachers,buyer,buyers,purist,purists,optimizer,optimizers,conscious,savvy,hunter,hunters,junkie,junkies,nerd,nerds,warrior,warriors,minded,mama,mamas,mum,mums,empty nester,empty nesters,expecting,newbie,newbies,fan,fans,shopper,shoppers,beginner,beginners,collector,collectors,busy,over 30,over 40,over 50,persona,avatar,newlywed,couple,couples,family,families,kids,teen,teens,grandparent,grandparents'),
  product: wordSet('multi,mutli,multiproduct,multi product,multiple products,all products,multi sku,multipack'),
}

/** Classes matched on the whole value only (two-letter codes and yes/no flags hide inside words). */
const WHOLE: Partial<Record<Cls, Set<string>>> = {
  quality: wordSet('high,medium,low,med,hi,lo,mid'),
  overlay: wordSet('y,n,yes,no'),
  placement: wordSet('all,ig,fb,instagram,facebook,messenger,marketplace,search,threads,advantage placements,adv placements,automatic placements,manual placements'),
  gender: wordSet('male,female,men,women,man,woman,mens,womens,unisex,masculino,feminino'),
  age: wordSet('gen z,genz,millennial,millennials,boomer,boomers,gen x,over 30,over 40,over 50,over 60'),
  language: wordSet('en,eng,english,fr,fra,french,francais,de,deu,ger,german,deutsch,es,esp,spa,spanish,espanol,it,ita,italian,italiano,nl,dutch,pt,por,portuguese,portugues,sv,swedish,da,danish,fi,finnish,pl,polish,ja,japanese,ko,korean,zh,chinese,ar,arabic,tr,turkish'),
  market: wordSet('us,usa,uk,gb,ca,can,au,aus,nz,eu,global,intl,international,row,latam,emea,apac,nordics,dach,mx'),
  ratio: wordSet('multir,multi r,multi ratio,all ratios,square,vertical,horizontal,landscape,portrait'),
}

/** Share of a field's ads a class needs to name the field. */
const MIN_SHARE: Partial<Record<Cls, number>> = {
  quality: 0.8, overlay: 0.8, gender: 0.8, age: 0.8, language: 0.8, market: 0.8, placement: 0.7,
}
/** Tie-break order when two classes reach the same share. */
const LABEL_ORDER: Cls[] = [
  'funnel', 'version', 'ratio', 'length', 'hook', 'creator', 'format', 'style', 'type', 'quality', 'overlay',
  'placement', 'emotion', 'offer', 'moment', 'landing', 'identity', 'cta', 'angle', 'persona', 'gender', 'age',
  'language', 'market',
]

const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|enero|febrero|marzo|mayo|junio|julio|septiembre|octubre|noviembre|diciembre|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre'
const DATE_RES = [
  /^\d{4}[-./_]?\d{1,2}[-./_]?\d{1,2}$/,                                             // 2026-01-05, 20260105
  /^\d{1,2}[-./_]\d{1,2}[-./_](\d{4}|\d{2})$/,                                       // 01.05.26, 5/14/2026
  /^\d{1,2}[./]\d{1,2}$/,                                                             // 10/5, 10.05
  /^\d{6}$/,                                                                          // 010526
  new RegExp(`^(${MONTH})[\\s.'-]?\\d{1,2}(st|nd|rd|th)?([\\s.,'/-]+\\d{2,4})?$`, 'i'),  // Jan5, Jan 5 2026, MAR03.25
  new RegExp(`^(${MONTH})[\\s.,'-]*('?\\d{2}|\\d{4})$`, 'i'),                           // Sep 2026, Sept'26
  new RegExp(`^\\d{1,2}(st|nd|rd|th)?[\\s.'-]?(${MONTH})([\\s.,'/-]?\\d{2,4})?$`, 'i'),  // 5Jan26, 5 Jan 2026
  new RegExp(`^(${MONTH})$`, 'i'),                                                     // July
  /^q[1-4]([\s'-]?\d{2,4})?$/i, /^\d{2,4}[\s-]?q[1-4]$/i,                              // Q4 2026
  /^(wk|week|w)[\s.-]?\d{1,2}([\s.-]\d{2,4})?$/i,                                      // week 41, W12
]
const VERSION_RE = /^(v|ver|vers|version|rev|iter)[\s._-]?\d{1,3}(\.\d{1,2})?[a-z]?$/i
/** "Video 2", "Image 3": the n-th of something, read like a version (not "ad123", an id). */
const INDEX_RE = /^(video|vid|image|img|static|still|creative|variation|var|take|cut)\s?#?\d{1,2}$/i
const HOOK_RE = /^(h|hk)[\s._-]?\d{1,2}$|^hook[\s._-]?(\d{1,2}|[a-f])$/i
const RATIO_RE = /^\d{1,4}(\.\d{1,2})?\s?[x×:]\s?\d{1,4}$/i
const LENGTH_RES = [
  /^\d{1,3}\s?(s|sec|secs|second|seconds|seg)$/i, /^\d{1,2}\s?(min|mins|minute|minutes)$/i,
  /^:\d{2}$/, /^0?\d:\d{2}$/, /^\d{1,3}\s?-\s?\d{1,3}\s?(s|sec|secs|seconds)$/i,
]
const CREATOR_RE = /^@[\p{L}\p{N}_.]{2,}$/u
const OFFER_RE = /\d\s?%|[$€£]\s?\d|\d\s?[$€£]|\b(off|desconto)\b/i
const AGE_RE = /^\d{2}\s?-\s?\d{2}$|^\d{2}\s?\+$/
const LANDING_RE = /(^| )(page|lp|pdp|plp|homepage)$/

/**
 * The 2026 creative-planner id that leads a name: brand (2), week (2), N or I,
 * row (5), ratio code (M, 45, 11, 916, 169), review date (DDMMYY).
 */
const UCID_RE = /^[A-Z\u00C0-\u024F]{2}\d{2}[NI]\d{5}(M|45|11|916|169)\d{6}$/
const UCID_RATIO: Record<string, string> = { M: 'MultiR', '45': '4x5', '11': '1x1', '916': '9x16', '169': '16x9' }

const isDate = (v: string) => {
  const t = stripMarks(v).trim()
  return DATE_RES.some(re => re.test(t))
}

/** Ids and counters: long numbers, letters then 3+ digits, or long tokens heavy in digits. */
function isIdLike(v: string): boolean {
  const s = v.replace(/\s+/g, '')
  if (UCID_RE.test(s)) return true
  if (/^\d{5,}$/.test(s)) return true
  if (/^[A-Za-z]{1,6}[-#_]?\d{3,}[A-Za-z]?$/.test(s)) return true
  if (/^[A-Za-z]{1,4}\d{1,4}[-_]\d{2,}$/.test(s)) return true
  const digits = (s.match(/\d/g) || []).length
  return s.length >= 10 && digits >= 6
}

const exactCache = new Map<string, Cls | null>()
/** What a whole token says it is, or null. */
function exactClass(tok: string): Cls | null {
  const t = tok.trim()
  if (!t) return null
  const hit = exactCache.get(t)
  if (hit !== undefined) return hit
  let c: Cls | null = null
  const w = words(t)
  if (isDate(t)) c = 'date'
  else if (VERSION_RE.test(t) || INDEX_RE.test(t)) c = 'version'
  else if (HOOK_RE.test(t)) c = 'hook'
  else if (RATIO_RE.test(t) || WHOLE.ratio!.has(w)) c = 'ratio'
  else if (LENGTH_RES.some(re => re.test(t))) c = 'length'
  else if (CREATOR_RE.test(t)) c = 'creator'
  else if (/^\d{1,4}$/.test(t)) c = 'number'
  else if (isIdLike(t)) c = 'id'
  else for (const k of STRONG_ORDER) if (STRONG[k]!.has(w)) { c = k; break }
  if (exactCache.size > 50000) exactCache.clear()
  exactCache.set(t, c)
  return c
}

const looseCache = new Map<string, Cls[]>()
/** Every class a value hints at (a field is labelled by the class most of its ads hint at). */
function looseClasses(v: string): Cls[] {
  const t = v.trim()
  const hit = looseCache.get(t)
  if (hit) return hit
  const out = new Set<Cls>()
  const ex = exactClass(t)
  if (ex) out.add(ex)
  if (!ex || !NOT_GROUPS.has(ex)) {
    const w = words(t)
    const g = grams(w)
    for (const [c, set] of Object.entries(STRONG) as Array<[Cls, Set<string>]>) if (g.some(x => set.has(x))) out.add(c)
    for (const [c, set] of Object.entries(LOOSE) as Array<[Cls, Set<string>]>) if (g.some(x => set.has(x))) out.add(c)
    for (const [c, set] of Object.entries(WHOLE) as Array<[Cls, Set<string>]>) if (set.has(w)) out.add(c)
    // Yes/no flags and High/Low count only as the whole value ("Y 4x5" is no overlay flag).
    if (out.has('overlay') && !WHOLE.overlay!.has(w)) out.delete('overlay')
    if (out.has('quality') && !WHOLE.quality!.has(w)) out.delete('quality')
    if (OFFER_RE.test(t)) out.add('offer')
    if (AGE_RE.test(t)) out.add('age')
    if (t.startsWith('@')) out.add('creator')
    if (LANDING_RE.test(w)) out.add('landing')
    if (/\bhook\b/.test(w)) out.add('hook')
  }
  const list = [...out]
  if (looseCache.size > 50000) looseCache.clear()
  looseCache.set(t, list)
  return list
}

/** Share of the ads (value counts) hinting at each class. */
function classShares(counts: Map<string, number>): Map<Cls, number> {
  let total = 0
  const hit = new Map<Cls, number>()
  for (const [v, c] of counts) {
    total += c
    for (const k of looseClasses(v)) hit.set(k, (hit.get(k) || 0) + c)
  }
  for (const [k, n] of hit) hit.set(k, total ? n / total : 0)
  return hit
}

function valueClass(counts: Map<string, number>): Cls | null {
  const s = classShares(counts)
  let best: Cls | null = null
  let bestShare = 0
  for (const c of LABEL_ORDER) {
    const share = s.get(c) || 0
    if (share >= (MIN_SHARE[c] ?? 0.6) && share > bestShare) { best = c; bestShare = share }
  }
  // A column mixing media and production style ("UGC", "Static", "Carousel") is the format.
  if (!best && unionShare(counts, ['format', 'style'], 3) >= 0.6) best = 'format'
  // "Multi" next to product names marks a product list (the planner writes Multi for several products).
  if (!best && (s.get('product') || 0) >= 0.12) best = 'product'
  return best
}

/** Share of the ads whose value, a few words at most, hints at any of these classes. */
function unionShare(counts: Map<string, number>, classes: Cls[], maxWords: number): number {
  let total = 0
  let hit = 0
  for (const [v, c] of counts) {
    total += c
    if (words(v).split(' ').length <= maxWords && looseClasses(v).some(k => classes.includes(k))) hit += c
  }
  return total ? hit / total : 0
}

/** A label from what the values look like, or null. */
export function labelFromValues(values: Map<string, number>): string | null {
  const c = valueClass(values)
  return c && !NOT_GROUPS.has(c) ? CLASS_LABEL[c] : null
}

// ── Keys ───────────────────────────────────────────────────────────────────

/** The 2026 creative planner's name keys (upper case, as the planner writes them). */
const PLANNER_KEYS: Record<string, string> = {
  TY: 'Type', IS: 'Iteration seed', IB: 'Iteration branch', PR: 'Product', CA: 'Category', CO: 'Collection',
  OF: 'Offer', PE: 'Persona', EM: 'Emotion', AN: 'Angle', CN: 'Concept', MO: 'Moment', FP: 'Funnel (ad name)',
  FO: 'Format', TP: 'Template', C1: 'Custom 1', C2: 'Custom 2', C3: 'Custom 3', C4: 'Custom 4',
  PS: 'Production style', QL: 'Quality', OV: 'Overlay', HK: 'Hook', BD: 'Body', CT: 'CTA', RA: 'Ratio',
  PL: 'Placement', HL: 'Headline', BC: 'Body copy', DS: 'Destination',
}
/** Keys written out as words say what the field is. */
const WORD_KEYS: Record<string, string> = {
  funnel: 'Funnel (ad name)', stage: 'Funnel (ad name)', angle: 'Angle', persona: 'Persona', avatar: 'Persona',
  audience: 'Audience', aud: 'Audience', concept: 'Concept', format: 'Format', fmt: 'Format', hook: 'Hook',
  type: 'Type', creator: 'Creator', talent: 'Creator', influencer: 'Creator', offer: 'Offer', promo: 'Offer',
  product: 'Product', prod: 'Product', sku: 'Product', category: 'Category', cat: 'Category',
  collection: 'Collection', emotion: 'Emotion', template: 'Template', moment: 'Moment', season: 'Moment',
  placement: 'Placement', ratio: 'Ratio', cta: 'CTA', landing: 'Landing page', destination: 'Destination',
  editor: 'Editor', designer: 'Designer', version: 'Version', ver: 'Version', theme: 'Theme', lang: 'Language',
  language: 'Language', market: 'Market', geo: 'Market', country: 'Market', gender: 'Gender', age: 'Age',
  length: 'Length', len: 'Length', duration: 'Length', dur: 'Length', campaign: 'Campaign', batch: 'Batch',
  objective: 'Objective', obj: 'Objective', style: 'Production style', headline: 'Headline', body: 'Body',
  quality: 'Quality', overlay: 'Overlay', identity: 'Identity', week: 'Week', date: 'Date',
}
/** Keys that name an id: one value per ad, never a grouping. */
const ID_KEYS = new Set(['id', 'uid', 'ucid', 'adid', 'postid'])
/** Short keys that could mean several things: the values speak first, then these. */
const SHORT_KEYS: Record<string, string> = {
  a: 'Angle', c: 'Creator', f: 'Format', h: 'Hook', o: 'Offer', p: 'Product', t: 'Type', v: 'Version',
  pe: 'Persona', pr: 'Product', an: 'Angle', cn: 'Concept', fp: 'Funnel (ad name)', fo: 'Format', ty: 'Type',
  hk: 'Hook', of: 'Offer', em: 'Emotion', th: 'Theme', lg: 'Language', cm: 'Campaign', ax: 'Angle',
}

function keyInfo(key: string, upper: boolean): { label: string | null; strong: boolean } {
  const K = key.toUpperCase()
  const k = key.toLowerCase()
  if (upper && PLANNER_KEYS[K]) return { label: PLANNER_KEYS[K], strong: true }
  if (k.length >= 3 && WORD_KEYS[k]) return { label: WORD_KEYS[k], strong: true }
  return { label: SHORT_KEYS[k] || null, strong: false }
}

function genericKeyLabel(key: string): string {
  if (/^[A-Za-z]{3,}$/.test(key) && !/^[A-Z]+$/.test(key)) return key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()
  return `Field ${key.toUpperCase()}`
}

const KEY_TOKEN = /^([A-Za-z#][A-Za-z0-9]{0,11}|\d{1,2})\s*[:=]\s*([\s\S]*)$/
const HYPHEN_KEY_TOKEN = /^([A-Za-z#][A-Za-z0-9]{0,3})-([\s\S]*)$/

type Pair = { key: string; value: string }

/** A `KEY:value` / `key=value` token, or null ("10:30" and "9:16" are not keys). */
function keyToken(tok: string): Pair | null {
  const m = KEY_TOKEN.exec(tok.trim())
  if (!m) return null
  const key = m[1]
  const value = m[2].trim()
  if (/^(https?|www|ftp)$/i.test(key)) return null
  if (/^\d+$/.test(key) && /^\d/.test(value)) return null
  return { key, value }
}

const strongKey = (key: string) =>
  (/^[A-Z]{2}$|^C[1-4]$/.test(key) && !!PLANNER_KEYS[key]) || (key.length >= 3 && !!WORD_KEYS[key.toLowerCase()])

// ── Cleaning and splitting ─────────────────────────────────────────────────

/** Words that make "copy" ad copy, not Meta's duplicate suffix ("Long Copy"). */
const COPY_WORDS = /\b(ad|body|dynamic|new|long|short|headline|primary|sales|test|testing|more|less|no|with|the|web)$/i

/** Meta's duplicate suffixes ("- Copy", "- Copy 2", "Copy of", " copy", "(2)") are not tokens. */
export function stripCopySuffix(name: string): string {
  let n = name.trim().replace(/^(copy\s+of\s+)+/i, '').trim()
  for (let i = 0; i < 6; i++) {
    let next = n.replace(/\s+-\s+copy(\s*\d+)?\s*$/i, '').replace(/\s*\(\d{1,2}\)\s*$/, '').trim()
    if (next === n) {
      const m = /^(.*?)[\s_|]+copy(\s*\d+)?\s*$/i.exec(n)
      if (m && m[1].trim() && !COPY_WORDS.test(m[1].trim())) next = m[1].trim()
    }
    if (next === n) break
    n = next
  }
  // A copy suffix someone typed after ("Name - Copy - note").
  return n.replace(/\s+-\s+copy(\s+\d+)?(?=\s+-\s)/gi, '').trim()
}

/** The name without copy suffixes, emoji, links and stray separators at either end. */
export function cleanName(raw: string): string {
  const n = String(raw || '')
    .normalize('NFC')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|[\s_|-])https?-\S*/gi, '$1')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return stripCopySuffix(n).replace(/^[\s_|\-.,;:]+|[\s_|\-.,;:]+$/g, '').trim()
}

type SepId = '|' | ' - ' | '_' | '-' | '/' | '.'
const SPLITTERS: ReadonlyArray<readonly [SepId, RegExp]> = [
  ['|', /\s*\|\s*/],
  [' - ', /\s+-\s+/],
  ['_', /\s*_\s*/],
  ['-', /\s*-\s*/],
  ['/', /\s*\/\s*/],
  ['.', /\s*\.\s*/],
]
const SEP_NAME: Record<SepId, string> = { '|': 'pipe', ' - ': 'dash', _: 'under', '-': 'hyphen', '/': 'slash', '.': 'dot' }
/** A hyphen with a space on at least one side ("glow- serum - BOF"). */
const SPACED_HYPHEN = /\s+-\s*|\s*-\s+/

// Separators inside (parentheses), dates, decimals and "15-30sec" never split a name.
const MASK: Record<string, string> = { '-': '\uE001', _: '\uE002', '|': '\uE003', '/': '\uE004', '.': '\uE005', ' ': '\uE006', ':': '\uE007', '=': '\uE008' }
const UNMASK: Record<string, string> = Object.fromEntries(Object.entries(MASK).map(([k, v]) => [v, k]))
const maskSpan = (s: string) => s.replace(/[-_|/. :=]/g, c => MASK[c])
const unmask = (s: string) => s.replace(/[\uE001-\uE008]/g, c => UNMASK[c])
function protect(s: string): string {
  return s
    .replace(/\([^()]*\)/g, maskSpan)
    .replace(/(?<!\d)\d{4}[-./]\d{1,2}[-./]\d{1,2}(?!\d)/g, maskSpan)
    .replace(/(?<!\d)\d{1,2}[-./]\d{1,2}[-./]\d{2,4}(?!\d)/g, maskSpan)
    .replace(/(?<!\d)\d+\.\d+(?!\d)/g, maskSpan)
    .replace(/(?<!\d)\d{1,3}\s?-\s?\d{1,3}\s?(s|sec|secs|seconds)\b/gi, maskSpan)
}

function splitOn(body: string): { sep: SepId | null; toks: string[] } {
  if (!body) return { sep: null, toks: [] }
  const p = protect(body)
  const tries = SPLITTERS.map(([id, re]) => {
    const toks = p.split(re).map(t => unmask(t).trim())
    return { id, toks, n: toks.filter(Boolean).length }
  })
  let i = tries.findIndex(t => t.n >= 3)
  if (i < 0) i = tries.findIndex(t => t.n >= 2 && t.id !== '.')
  if (i < 0) return { sep: null, toks: [unmask(p).trim()] }
  // A weaker separator that splits into many more tokens is the real one.
  for (let j = i + 1; j < tries.length; j++) {
    if (tries[j].n >= 6 && tries[j].n >= 2 * tries[i].n) { i = j; break }
  }
  return { sep: tries[i].id, toks: tries[i].toks }
}

/** Bracket groups as tokens of their own, then the rest split on its separator. */
function tokenize(name: string): { sep: SepId | null; toks: string[]; tags: number } {
  const tags: string[] = []
  let body = name
  if (body.includes('[')) {
    body = body.replace(/(?:[\s_|-]*\[[^[\]]*\][\s_|-]*)+/g, (run: string, at: number, whole: string) => {
      for (const m of run.matchAll(/\[([^[\]]*)\]/g)) tags.push(m[1].trim())
      if (at === 0 || at + run.length >= whole.length) return ''
      return /\|/.test(run) ? ' | ' : /\s-\s/.test(run) ? ' - ' : /_/.test(run) ? '_' : /-/.test(run) ? '-' : ' '
    }).trim()
  }
  const { sep, toks } = splitOn(body)
  const bare = (t: string) => t.replace(/^\((.*)\)$/, '$1').trim()
  return { sep, toks: [...tags, ...toks.filter((t, i) => t || (i > 0 && i < toks.length - 1)).map(bare)], tags: tags.length }
}

/** The separator most names split on into 3+ tokens, or null (free text). */
export function detectSeparator(names: string[]): { id: string } | null {
  const hits = new Map<string, number>()
  for (const n of names) {
    const { sep, toks } = splitOn(cleanName(n))
    if (sep && toks.filter(Boolean).length >= 3) hits.set(sep, (hits.get(sep) || 0) + 1)
  }
  const best = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]
  return best && best[1] >= Math.max(2, Math.ceil(names.length * 0.2)) ? { id: best[0] } : null
}

// ── Reading one name ───────────────────────────────────────────────────────

type ReadName = {
  id: string
  sep: SepId | null
  /** Plain tokens left after keys (empty strings hold a skipped slot). */
  toks: string[]
  pairs: Pair[]
  tags: number
}

/**
 * KEY:value tokens of a split name. A name is keyed with two or more key
 * tokens, or one whose key is a planner key or a written-out word ("Note: the
 * summer one" stays plain). With a hyphen separator a plain token after a key
 * is glued back onto its value ("AN:Anti-Aging").
 */
function readKeys(sep: SepId | null, toks: string[]): { pairs: Pair[]; plain: string[]; lead: number } {
  const keyed = toks.map(t => (t ? keyToken(t) : null))
  const n = keyed.filter(Boolean).length
  if (!n || (n === 1 && !strongKey(keyed.find(Boolean)!.key))) return { pairs: [], plain: toks, lead: toks.length }
  const pairs: Pair[] = []
  const plain: string[] = []
  const lead = keyed.findIndex(Boolean)
  const glue = (sep === '-' || sep === ' - ') && n >= 0.6 * toks.filter(Boolean).length
  toks.forEach((t, i) => {
    const k = keyed[i]
    if (k) { pairs.push({ ...k }); return }
    const last = pairs[pairs.length - 1]
    if (glue && last && t && !exactClass(t)) { last.value = last.value ? `${last.value}-${t}` : t; return }
    plain.push(t)
  })
  return { pairs, plain, lead }
}

function readName(id: string, name: string): ReadName & { lead: number } {
  const { sep, toks, tags } = tokenize(name)
  const { pairs, plain, lead } = readKeys(sep, toks)
  return { id, sep, toks: plain, pairs, tags, lead }
}

export type KeyedParse = { prefix: string; pairs: Pair[] }

/** The KEY:value pairs of a name and the unkeyed tokens before them, or null when it isn't keyed. */
export function parseKeyed(name: string): KeyedParse | null {
  const r = readName('', cleanName(name))
  if (!r.pairs.length) return null
  const prefix = r.toks.slice(0, r.lead).filter(Boolean).join(r.sep === '|' ? ' | ' : r.sep || ' ')
  return { prefix, pairs: r.pairs.filter(p => p.value) }
}

/** What the first token of a name looks like: names of one convention start alike. */
function kindOf(tok: string | undefined): string {
  const t = (tok || '').trim()
  if (!t) return 'none'
  if (UCID_RE.test(t)) return 'ucid'
  if (isDate(t)) return 'date'
  if (/^\d+$/.test(t) || /^\d{3,}/.test(t)) return 'num'
  if (isIdLike(t)) return 'code'
  return 'word'
}

// ── Raw fields ─────────────────────────────────────────────────────────────

type RawKind = 'keyed' | 'class' | 'positional'
type Raw = {
  key: string
  kind: RawKind
  order: number
  byAd: Map<string, string>
  keyName?: string
  upperVotes?: number
  lowerVotes?: number
  cls?: Cls
  fam?: string
  hint?: Cls
}

class Store {
  fields = new Map<string, Raw>()
  private n = 0
  add(key: string, init: Omit<Raw, 'key' | 'order' | 'byAd'>, adId: string, value: string): Raw | null {
    const v = value.trim()
    if (isPlaceholder(v) || isFreeText(v)) return null
    let f = this.fields.get(key)
    if (!f) {
      f = { ...init, key, order: this.n++, byAd: new Map() }
      this.fields.set(key, f)
    }
    if (!f.byAd.has(adId)) f.byAd.set(adId, v)
    return f
  }
  keyed(adId: string, key: string, value: string) {
    if (ID_KEYS.has(key.toLowerCase())) return
    const f = this.add(`nm:k:${key.toUpperCase()}`, { kind: 'keyed', keyName: key }, adId, value)
    if (!f) return
    const isUpper = /[A-Z]/.test(key) && key === key.toUpperCase()
    f.upperVotes = (f.upperVotes || 0) + (isUpper ? 1 : 0)
    f.lowerVotes = (f.lowerVotes || 0) + (isUpper ? 0 : 1)
  }
  cls(adId: string, c: Cls, value: string) {
    this.add(`nm:c:${c}`, { kind: 'class', cls: c }, adId, value)
  }
}

/** f-TOF, cm-Spring, [k3-img]: hyphen keys, when most names of a family carry three or more. */
function hyphenKeys(sep: SepId | null, items: Array<{ id: string; toks: string[] }>, out: Store) {
  // In hyphen-separated names a hyphen is the separator, never a key joiner.
  if (sep === '-' || sep === ' - ') return
  const perName = items.map(it => {
    const keys = new Map<string, number>()
    it.toks.forEach((t, i) => {
      const m = HYPHEN_KEY_TOKEN.exec(t.trim())
      if (m && !isPlaceholder(t) && !(/\d/.test(m[1]) && /^\d+$/.test(m[2]))) keys.set(m[1].toLowerCase(), i)
    })
    return keys
  })
  const users = perName.filter(k => k.size >= 3).length
  if (!items.length || users < Math.max(2, items.length * 0.5)) return
  const seen = new Map<string, number>()
  for (const k of perName) for (const key of k.keys()) seen.set(key, (seen.get(key) || 0) + 1)
  const accepted = new Set([...seen.entries()].filter(([, n]) => n >= Math.max(2, items.length * 0.3)).map(([k]) => k))
  items.forEach((it, j) => {
    const drop = new Set<number>()
    for (const [key, i] of perName[j]) {
      if (!accepted.has(key)) continue
      const m = HYPHEN_KEY_TOKEN.exec(it.toks[i].trim())!
      out.keyed(it.id, m[1], m[2].trim())
      drop.add(i)
    }
    if (drop.size) it.toks = it.toks.filter((_, i) => !drop.has(i))
  })
}

function modeOf(xs: number[]): { value: number; count: number } {
  const m = new Map<number, number>()
  for (const x of xs) m.set(x, (m.get(x) || 0) + 1)
  let value = 0
  let count = 0
  for (const [v, c] of m) if (c > count) { value = v; count = c }
  return { value, count }
}

/** Classes that share a column in some conventions ("Static", "UGC", "Carousel"). */
const SIBLINGS: Partial<Record<Cls, Cls[]>> = { format: ['format', 'style'], style: ['format', 'style'] }

/**
 * How much better the tokens after an optional token line up with the other
 * names once it is taken out (summed over the next three positions).
 */
function shiftGain(items: Array<{ toks: string[] }>, cls: Array<Array<Cls | null>>, c: Cls, m: number): number {
  const withIt: string[][] = []
  const without: string[][] = []
  items.forEach((it, j) => {
    if (it.toks.length <= m) return
    if (cls[j][m] === c) withIt.push(it.toks)
    else without.push(it.toks)
  })
  if (!withIt.length || without.length < 2) return 0
  // Value mix at one position, and how much two mixes have in common (0 to 1).
  const mix = (rows: string[][], i: number) => {
    const out = new Map<string, number>()
    let n = 0
    for (const r of rows) {
      const t = r[i]
      if (!t || isPlaceholder(t)) continue
      const k = compact(t)
      out.set(k, (out.get(k) || 0) + 1)
      n++
    }
    for (const [k, c] of out) out.set(k, c / n)
    return out
  }
  const common = (a: Map<string, number>, b: Map<string, number>) => {
    let s = 0
    for (const [k, p] of a) s += Math.min(p, b.get(k) || 0)
    return s
  }
  let gain = 0
  for (let k = 1; k <= 3; k++) {
    const after = mix(withIt, m + k)
    gain += common(after, mix(without, m + k - 1)) - common(after, mix(without, m + k))
  }
  return gain
}

const SUB_SEPARATORS: Partial<Record<SepId, RegExp[]>> = {
  '|': [SPACED_HYPHEN, /_/],
  _: [SPACED_HYPHEN],
  ' - ': [/_/],
  '/': [SPACED_HYPHEN],
}

/**
 * One family of names (same separator, same first-token shape): drifting
 * class tokens out, then positions, then nested positions.
 */
function processFamily(fam: string, sep: SepId | null, items: Array<{ id: string; toks: string[] }>, out: Store) {
  hyphenKeys(sep, items, out)
  for (const it of items) {
    for (const t of it.toks) {
      const m = UCID_RE.exec(t.trim())
      if (m) out.cls(it.id, 'ratio', UCID_RATIO[m[1]])
    }
  }
  const lens = items.map(it => it.toks.length)
  if (Math.max(0, ...lens) <= 1) {
    // One-token names: only a token that says what it is ("Catalogue", "Video").
    for (const it of items) {
      const t = it.toks[0] || ''
      const c = exactClass(t)
      if (c && STRONG[c]) out.cls(it.id, c, t)
    }
    return
  }
  const fixed = modeOf(lens).count >= 0.8 * items.length
  const cls = items.map(it => it.toks.map(t => (isPlaceholder(t) ? null : exactClass(t))))

  // Which classes drift out of the positions. A class that fills one column
  // (with its sibling: Static next to UGC) stays. Otherwise it drifts when it
  // is scattered or optional, unless taking it out would misalign the rest of
  // the name (in names that all have the same length it must clearly help).
  const drifting = new Set<Cls>()
  const present = new Set<Cls>()
  for (const row of cls) for (const c of row) if (c) present.add(c)
  for (const c of present) {
    const at: number[] = []
    cls.forEach(row => row.forEach((x, i) => { if (x === c) at.push(i) }))
    const m = modeOf(at)
    if (m.count < 0.6 * at.length) {
      if (!fixed) drifting.add(c)
      continue
    }
    const sib = SIBLINGS[c] || [c]
    let long = 0
    let pure = 0
    cls.forEach((row, j) => {
      if (items[j].toks.length <= m.value) return
      long++
      const x = row[m.value]
      if (x && sib.includes(x)) pure++
    })
    if (pure >= 0.85 * long) continue
    const gain = shiftGain(items, cls, c, m.value)
    if (fixed ? gain >= 0.5 : gain > -0.5) drifting.add(c)
  }
  const rest = items.map((it, j) => it.toks.filter((t, i) => {
    const c = cls[j][i]
    if (!c || !drifting.has(c)) return true
    out.cls(it.id, c, t)
    return false
  }))

  // Positions: left to right, except a variable tail, which may line up from the end.
  const counts = rest.map(r => r.length).sort((a, b) => a - b)
  const p10 = counts[Math.floor((counts.length - 1) * 0.1)]
  const maxC = counts[counts.length - 1]
  const variable = !fixed && p10 < maxC
  const stable = variable ? Math.max(1, p10 - 1) : Infinity
  const posOf = (len: number, i: number, align: 'L' | 'R') => (i < stable || align === 'L' ? `L${i + 1}` : `R${len - i}`)
  const groupScore = (align: 'L' | 'R') => {
    const by = new Map<string, Map<string, number>>()
    rest.forEach(r => r.forEach((t, i) => {
      if (isPlaceholder(t)) return
      const p = posOf(r.length, i, align)
      let m = by.get(p)
      if (!m) { m = new Map(); by.set(p, m) }
      const k = compact(t)
      m.set(k, (m.get(k) || 0) + 1)
    }))
    let s = 0
    for (const m of by.values()) for (const c of m.values()) if (c >= 2) s += c
    return s
  }
  const align: 'L' | 'R' = variable && groupScore('R') > groupScore('L') ? 'R' : 'L'

  const byPos = new Map<string, Array<[string, string]>>()
  rest.forEach((r, j) => r.forEach((t, i) => {
    if (isPlaceholder(t)) return
    const p = posOf(r.length, i, align)
    let list = byPos.get(p)
    if (!list) { list = []; byPos.set(p, list) }
    list.push([items[j].id, t])
  }))

  // A position that holds its own small pattern ("glow - serum - BOF - static")
  // opens into sub-positions.
  const subs = SUB_SEPARATORS[sep as SepId] || []
  const finalPos: Array<[string, Array<[string, string]>]> = []
  for (const [p, list] of byPos) {
    let opened = false
    for (const re of subs) {
      const hits = list.filter(([, t]) => re.test(protect(t))).length
      if (hits < 3 || hits < 0.3 * list.length) continue
      const sub = new Map<string, Array<[string, string]>>()
      for (const [id, t] of list) {
        // A value without the inner separator stays whole, in a slot of its own.
        if (!re.test(protect(t))) {
          let l = sub.get(`${p}.0`)
          if (!l) { l = []; sub.set(`${p}.0`, l) }
          l.push([id, t])
          continue
        }
        protect(t).split(re).map(x => unmask(x).trim()).forEach((x, k) => {
          if (isPlaceholder(x)) return
          const sp = `${p}.${k + 1}`
          let l = sub.get(sp)
          if (!l) { l = []; sub.set(sp, l) }
          l.push([id, x])
        })
      }
      finalPos.push(...sub)
      opened = true
      break
    }
    if (!opened) finalPos.push([p, list])
  }

  // The planner writes Products right after Type ("Net New-Serum-...").
  const typeAt = new Set<number>()
  for (const [p, list] of finalPos) {
    const m = /^L(\d+)$/.exec(p)
    if (!m) continue
    const counts = new Map<string, number>()
    for (const [, t] of list) counts.set(t, (counts.get(t) || 0) + 1)
    if (valueClass(counts) === 'type') typeAt.add(Number(m[1]))
  }
  for (const [p, list] of finalPos) {
    if (items.length >= 5 && new Set(list.map(([, t]) => foldKey(t))).size === 1 && !exactClass(list[0][1])) continue
    const m = /^L(\d+)$/.exec(p)
    const hint: Cls | undefined = m && typeAt.has(Number(m[1]) - 1) ? 'product' : undefined
    for (const [id, t] of list) {
      const f = out.add(`nm:p:${fam}:${p}`, { kind: 'positional', fam }, id, t)
      if (f && hint) f.hint = hint
    }
  }
}

// ── Folding values ─────────────────────────────────────────────────────────

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      rowMin = Math.min(rowMin, cur[j])
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

const digitsOf = memo((v: string) => v.replace(/\D/g, ''))

/** "Statics" and "Static", "Excitment" and "Excitement": one value. Never across digits ("V1", "V2"). */
function nearSpelling(a: string, b: string): boolean {
  if (a.length >= 3 && (a + 's' === b || b + 's' === a)) return true
  if (Math.abs(a.length - b.length) > 2 || digitsOf(a) !== digitsOf(b)) return false
  const len = Math.min(a.length, b.length)
  if (len < 6) return false
  return editDistance(a, b, len >= 12 ? 2 : 1) <= (len >= 12 ? 2 : 1)
}

type Folded = {
  /** compact spelling to the group's display value */
  display: Map<string, string>
  /** display value to ads */
  counts: Map<string, number>
}

/** Short forms and spellings that are the same value. */
const SAME: Record<string, string> = {
  vid: 'video', vids: 'videos', img: 'image', imgs: 'images', pic: 'photo', pics: 'photos', imagem: 'image',
  imagen: 'image', carrousel: 'carousel', carrossel: 'carousel', carrusel: 'carousel', tofu: 'tof', mofu: 'mof',
  bofu: 'bof', ugcs: 'ugc',
}
const foldKey = (v: string) => {
  const k = compact(v) || v.toLowerCase()
  return SAME[k] || k
}

function fold(byAd: Map<string, string>): Folded {
  const groups = new Map<string, { n: number; spell: Map<string, number> }>()
  for (const v of byAd.values()) {
    const k = foldKey(v)
    let g = groups.get(k)
    if (!g) { g = { n: 0, spell: new Map() }; groups.set(k, g) }
    g.n++
    g.spell.set(v, (g.spell.get(v) || 0) + 1)
  }
  const keys = [...groups.keys()].sort((a, b) => groups.get(b)!.n - groups.get(a)!.n)
  const into = new Map<string, string>()
  // Folding typos only matters for a field that could still group (40 values or so).
  if (keys.length <= 150) {
    for (let i = keys.length - 1; i > 0; i--) {
      const small = groups.get(keys[i])!
      for (let j = 0; j < i; j++) {
        if (into.has(keys[j])) continue
        const big = groups.get(keys[j])!
        if (small.n > Math.max(2, big.n * 0.34)) continue
        if (!nearSpelling(keys[i], keys[j])) continue
        into.set(keys[i], keys[j])
        for (const [s, c] of small.spell) big.spell.set(s, (big.spell.get(s) || 0) + c)
        big.n += small.n
        break
      }
    }
  }
  const display = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const k of keys) {
    if (into.has(k)) continue
    const g = groups.get(k)!
    // The spaced spelling reads best ("Busy Mom" over "BusyMom"), then the most
    // common, then a capitalised one ("TOF" over "tof"), then the shortest.
    const spaced = (v: string) => (/\s/.test(v.trim()) ? 1 : 0)
    const capital = (v: string) => (/^\p{Lu}/u.test(v) ? 1 : 0)
    const name = [...g.spell.entries()].sort((a, z) =>
      spaced(z[0]) - spaced(a[0]) || z[1] - a[1] || capital(z[0]) - capital(a[0]) || a[0].length - z[0].length)[0][0]
    display.set(k, name)
    counts.set(name, (counts.get(name) || 0) + g.n)
  }
  for (const [k, to] of into) {
    let t = to
    while (into.has(t)) t = into.get(t)!
    display.set(k, display.get(t)!)
  }
  return { display, counts }
}

const displayOf = (f: Folded, v: string) => f.display.get(foldKey(v)) ?? v

// ── Pooling ────────────────────────────────────────────────────────────────

type Field = {
  /** Folded values present, for comparing fields. */
  vals: Set<string>
  key: string
  kinds: Set<RawKind>
  keys: Set<string>
  fams: Set<string>
  byAd: Map<string, string>
  label: string
  strength: number
  keyName: string | null
  order: number
  folded: Folded
}

/** The label the values give, and how sure it is ("Multi" among names only hints at products). */
function valueLabel(counts: Map<string, number>): { label: string; strength: number } | null {
  const vc = valueClass(counts)
  if (!vc || NOT_GROUPS.has(vc)) return null
  return { label: CLASS_LABEL[vc], strength: vc === 'product' ? 1 : 2 }
}

function labelOf(r: Raw, folded: Folded): { label: string; strength: number } {
  const value = valueLabel(folded.counts)
  if (r.kind === 'keyed') {
    const info = keyInfo(r.keyName || '', (r.upperVotes || 0) >= (r.lowerVotes || 0))
    if (info.strong && info.label) return { label: info.label, strength: 3 }
    if (value && value.strength >= 2) return value
    if (info.label) return { label: info.label, strength: 1 }
    if (value) return value
    return { label: genericKeyLabel(r.keyName || ''), strength: 0.5 }
  }
  if (r.kind === 'class' && r.cls) return { label: CLASS_LABEL[r.cls], strength: 2 }
  if (value && value.strength >= 2) return value
  if (r.hint) return { label: CLASS_LABEL[r.hint], strength: 1.5 }
  return value || { label: 'Name field', strength: 0 }
}

function sharesAds(a: Map<string, string>, b: Map<string, string>): boolean {
  const [s, l] = a.size < b.size ? [a, b] : [b, a]
  for (const k of s.keys()) if (l.has(k)) return true
  return false
}

/** Share of the smaller field's ads whose value the other field also has. */
function overlap(a: Field, b: Field): number {
  const [small, big] = a.byAd.size <= b.byAd.size ? [a, b] : [b, a]
  let shared = 0
  for (const v of small.vals) if (big.vals.has(v)) shared++
  if (shared < Math.min(2, small.vals.size)) return 0
  let hit = 0
  for (const v of small.byAd.values()) if (big.vals.has(foldKey(v))) hit++
  return hit / small.byAd.size
}

function pool(raws: Raw[]): Field[] {
  const rank: Record<RawKind, number> = { keyed: 0, class: 1, positional: 2 }
  const sorted = [...raws].sort((a, b) => rank[a.kind] - rank[b.kind] || b.byAd.size - a.byAd.size || a.order - b.order)
  const out: Field[] = []
  for (const r of sorted) {
    const folded = fold(r.byAd)
    const { label, strength } = labelOf(r, folded)
    const f: Field = {
      vals: new Set([...r.byAd.values()].map(foldKey)),
      key: r.key, kinds: new Set([r.kind]), keys: new Set(r.kind === 'keyed' ? [r.key] : []),
      fams: new Set(r.fam ? [r.fam] : []), byAd: new Map(r.byAd), label, strength,
      keyName: r.kind === 'keyed' ? r.keyName || null : null, order: r.order, folded,
    }
    let best: Field | null = null
    let bestScore = 0
    for (const m of out) {
      if (sharesAds(f.byAd, m.byAd)) continue
      if (r.kind === 'keyed' && f.strength >= 3 && m.strength >= 3 && m.label !== f.label) continue
      if (r.fam && m.fams.has(r.fam)) continue
      const ov = overlap(f, m)
      // One label: the same field, when both are sure of it or some of the values agree.
      const sameLabel = f.label === m.label && f.strength >= 1 && m.strength >= 1 &&
        ((f.strength >= 1.5 && m.strength >= 1.5) || ov >= 0.3)
      if (!sameLabel && ov < 0.6) continue
      const score = ov + (sameLabel ? 0.5 : 0)
      if (score > bestScore) { best = m; bestScore = score }
    }
    if (!best) { out.push(f); continue }
    for (const [id, v] of f.byAd) best.byAd.set(id, v)
    for (const v of f.vals) best.vals.add(v)
    for (const k of f.kinds) best.kinds.add(k)
    for (const k of f.keys) best.keys.add(k)
    for (const k of f.fams) best.fams.add(k)
    if (f.strength > best.strength) { best.label = f.label; best.strength = f.strength }
    best.keyName = best.keyName || f.keyName
    best.folded = fold(best.byAd)
    if (best.strength < 2) {
      const value = valueLabel(best.folded.counts)
      if (value && value.strength > best.strength) { best.label = value.label; best.strength = value.strength }
    }
  }
  return out
}

// ── Keeping, ordering, output ──────────────────────────────────────────────

const MAX_FIELDS = 12
const MAX_VALUES = 40
/** Words left over when a hyphenated value is split ("One-of-a-Kind"). */
const STOPWORDS = wordSet('a,an,the,of,and,or,to,in,on,for,with,by,at,from,x,vs,de,da,do,e,em,para,com,la,le,et,und')

/**
 * True when a field groups ads: not an id, a date or free text. Fields named
 * only by position (or by an unknown key) must cover more ads and must not be
 * one value nearly everywhere.
 */
function groups(f: Field, total: number): boolean {
  const coverage = f.byAd.size
  const generic = f.strength < 1.5
  if (coverage < Math.max(3, Math.ceil(total * (generic ? 0.05 : 0.03)))) return false
  const counts = f.folded.counts
  if (counts.size < 2 || counts.size > MAX_VALUES) return false
  // A few ads per value: 3 on average for a field named only by position, 2.5
  // for a named one; a small field (under 30 ads) at most 3 values per 5 ads.
  if (coverage < 30 ? counts.size > Math.max(3, Math.floor(coverage * 0.6)) : coverage < (generic ? 3 : 2.5) * counts.size) return false
  const sorted = [...counts.values()].sort((a, b) => b - a)
  if (generic && sorted[0] >= 0.85 * coverage) return false
  let repeated = 0
  for (const c of sorted) if (c >= 2) repeated += c
  if (repeated < coverage * 0.5) return false
  if (sorted.slice(0, 10).reduce((a, b) => a + b, 0) < 0.6 * coverage) return false
  if ([...counts.entries()].filter(([v]) => STOPWORDS.has(words(v))).reduce((a, [, c]) => a + c, 0) >= 0.5 * coverage) return false
  const shares = classShares(counts)
  if ((shares.get('date') || 0) >= 0.6 || (shares.get('id') || 0) >= 0.6) return false
  if ((shares.get('number') || 0) >= 0.8 && counts.size > coverage * 0.5) return false
  return !/^(Date|ID|Number)$/.test(f.label)
}

/** Two fields that give every shared ad the same value: keep the bigger. */
function redundant(a: Field, b: Field): boolean {
  let shared = 0
  let agree = 0
  for (const [id, v] of b.byAd) {
    const w = a.byAd.get(id)
    if (w === undefined) continue
    shared++
    const x = foldKey(w)
    const y = foldKey(v)
    if (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))) agree++
  }
  return shared >= 0.8 * b.byAd.size && agree >= 0.85 * shared
}

const LABEL_RANK = [
  'Funnel (ad name)', 'Angle', 'Concept', 'Persona', 'Product', 'Category', 'Collection', 'Offer', 'Format',
  'Production style', 'Type', 'Hook', 'Creator', 'Emotion', 'Moment', 'Template', 'Landing page', 'Placement',
  'Ratio', 'Length', 'Version', 'Quality', 'Overlay', 'Identity', 'CTA', 'Audience', 'Language', 'Market',
  'Gender', 'Age', 'Theme', 'Campaign',
]
const rankOf = (f: Field) => {
  const i = LABEL_RANK.indexOf(f.label)
  if (i >= 0) return i
  return f.strength > 0 ? LABEL_RANK.length : LABEL_RANK.length + 1
}
/** Funnel first, then fields that cover a tenth of the ads (named ones first), then the rest. */
const tierOf = (f: Field, total: number) =>
  f.label.startsWith('Funnel') ? 0 : f.byAd.size >= 0.1 * total ? (f.strength >= 1.5 ? 1 : 2) : 3
/** The label is what the values themselves say ("Format" for Static, Video). */
const backed = (f: Field) => valueLabel(f.folded.counts)?.label === f.label

export function detectNaming(ads: NamedAd[]): AutoNaming {
  const store = new Store()
  const families = new Map<string, { sep: SepId | null; items: Array<{ id: string; toks: string[] }> }>()
  const keyedIds = new Set<string>()
  let positional = 0
  const sepVotes = new Map<string, number>()

  for (const ad of ads) {
    const name = cleanName(ad.name || '')
    if (!name) continue
    const r = readName(ad.id, name)
    for (const p of r.pairs) if (p.value) store.keyed(ad.id, p.key, p.value)
    if (r.pairs.length) keyedIds.add(ad.id)
    const firstPlain = r.toks.slice(r.tags).find(t => t) ?? r.toks.find(t => t)
    const famId = `${r.pairs.length ? 'k' : 'p'}.${r.sep ? SEP_NAME[r.sep] : 'none'}.${kindOf(firstPlain)}${r.tags ? '.tags' : ''}`
    let fam = families.get(famId)
    if (!fam) { fam = { sep: r.sep, items: [] }; families.set(famId, fam) }
    fam.items.push({ id: ad.id, toks: [...r.toks] })
    if (!r.pairs.length && r.toks.filter(Boolean).length >= 2) {
      positional++
      if (r.sep) sepVotes.set(r.sep, (sepVotes.get(r.sep) || 0) + 1)
    }
  }
  for (const [famId, fam] of [...families.entries()].sort((a, b) => b[1].items.length - a[1].items.length)) {
    processFamily(famId, fam.sep, fam.items, store)
  }

  const pooled = pool([...store.fields.values()]).filter(f => groups(f, ads.length))
  pooled.sort((a, b) => b.byAd.size - a.byAd.size || a.order - b.order)
  const kept: Field[] = []
  for (const f of pooled) if (!kept.some(k => redundant(k, f))) kept.push(f)
  const total = ads.length
  kept.sort((a, b) => tierOf(a, total) - tierOf(b, total) || rankOf(a) - rankOf(b) || b.byAd.size - a.byAd.size || a.order - b.order)

  const fields: NamingField[] = []
  const values = new Map<string, Record<string, string>>()
  const shown = kept.slice(0, MAX_FIELDS)
  const labels = new Map<Field, string>()
  const seen = new Map<string, number>()
  let generic = 0
  for (const f of shown) if (f.label === 'Name field') labels.set(f, `Name field ${++generic}`)
  const firstClaim = (f: Field) => (backed(f) ? 1 : 0)
  for (const f of [...shown].sort((a, b) => firstClaim(b) - firstClaim(a) || b.strength - a.strength || b.byAd.size - a.byAd.size)) {
    if (labels.has(f)) continue
    const n = (seen.get(f.label) || 0) + 1
    seen.set(f.label, n)
    labels.set(f, n === 1 ? f.label : f.keyName ? `${f.label} (${f.keyName})` : `${f.label} ${n}`)
  }
  for (const f of shown) {
    const label = labels.get(f)!
    const source: NamingFieldSource = f.kinds.has('keyed') ? (f.kinds.size > 1 ? 'mixed' : 'keyed') : 'positional'
    // Keyed by label, so a chosen field ("Angle") survives a reload or a new date range.
    const key = `nm:${words(label).replace(/ /g, '-')}`
    fields.push({
      key,
      label,
      source,
      coverage: f.byAd.size,
      distinct: f.folded.counts.size,
      examples: [...f.folded.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v),
    })
    for (const [id, v] of f.byAd) {
      let rec = values.get(id)
      if (!rec) { rec = {}; values.set(id, rec) }
      rec[key] = displayOf(f.folded, v)
    }
  }

  const sep = [...sepVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return {
    fields,
    values,
    separator: sep,
    keyedCount: keyedIds.size,
    positionalCount: positional,
    otherCount: ads.length - values.size,
  }
}
