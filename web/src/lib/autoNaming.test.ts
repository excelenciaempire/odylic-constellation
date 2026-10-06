import { describe, expect, it } from 'vitest'
import {
  cleanName, detectNaming, detectSeparator, labelFromValues, parseKeyed, stripCopySuffix, type NamedAd,
} from './autoNaming'

// Every fixture below is invented: it copies the shape of a naming convention
// seen in real accounts (separators, key styles, optional tokens, typos), never
// the names, brands or ids themselves.

const ads = (names: string[]): NamedAd[] => names.map((name, i) => ({ id: `a${i + 1}`, name }))
type Result = ReturnType<typeof detectNaming>
const labels = (r: Result) => r.fields.map(f => f.label)
const fieldBy = (r: Result, label: string) => r.fields.find(f => f.label === label)
const valueOf = (r: Result, id: string, label: string) => {
  const f = fieldBy(r, label)
  return f ? r.values.get(id)?.[f.key] : undefined
}
/** Ads per value of a field, as the space would group them. */
const groupsOf = (r: Result, label: string) => {
  const f = fieldBy(r, label)
  const out: Record<string, number> = {}
  if (!f) return out
  for (const rec of r.values.values()) if (rec[f.key]) out[rec[f.key]] = (out[rec[f.key]] || 0) + 1
  return out
}

describe('cleanName', () => {
  it('drops copy suffixes, emoji and links', () => {
    expect(cleanName('Hero_UGC_v2 - Copy 2')).toBe('Hero_UGC_v2')
    expect(cleanName('Copy of Copy of Hero_UGC_v2 (2)')).toBe('Hero_UGC_v2')
    expect(cleanName('🚨 Summer Sale | Image | Home Page')).toBe('Summer Sale | Image | Home Page')
    expect(cleanName('AB-Net New-Serum-Static-High-Y-https://example.com/page?x=1')).toBe('AB-Net New-Serum-Static-High-Y')
    expect(cleanName('Hero - Low-N - Copy - creator note')).toBe('Hero - Low-N - creator note')
  })

  it('keeps "copy" that means ad copy', () => {
    expect(cleanName('X12 | Image | Long Copy')).toBe('X12 | Image | Long Copy')
  })
})

describe('stripCopySuffix', () => {
  it('drops Meta duplicate suffixes', () => {
    expect(stripCopySuffix('TOF_Hook_UGC - Copy')).toBe('TOF_Hook_UGC')
    expect(stripCopySuffix('TOF_Hook_UGC - Copy 2 - Copy')).toBe('TOF_Hook_UGC')
    expect(stripCopySuffix('TOF_Hook_UGC copy')).toBe('TOF_Hook_UGC')
    expect(stripCopySuffix('TOF_Hook_UGC (3)')).toBe('TOF_Hook_UGC')
  })
})

describe('parseKeyed', () => {
  it('reads KEY:value names joined by hyphens, values with spaces', () => {
    const k = parseKeyed('FP:MOF-AN:Social Proof-PE:Gift Giver-FO:Static')
    expect(k?.prefix).toBe('')
    expect(k?.pairs).toEqual([
      { key: 'FP', value: 'MOF' },
      { key: 'AN', value: 'Social Proof' },
      { key: 'PE', value: 'Gift Giver' },
      { key: 'FO', value: 'Static' },
    ])
  })

  it('keeps an unkeyed id prefix out of the pairs', () => {
    const k = parseKeyed('QX02N00001M100126-TY:Net New-AN:Microscopic Structure')
    expect(k?.prefix).toBe('QX02N00001M100126')
    expect(k?.pairs).toEqual([
      { key: 'TY', value: 'Net New' },
      { key: 'AN', value: 'Microscopic Structure' },
    ])
  })

  it('lets a value hold the separator', () => {
    expect(parseKeyed('AN:Anti-Aging-FO:Video')?.pairs).toEqual([
      { key: 'AN', value: 'Anti-Aging' },
      { key: 'FO', value: 'Video' },
    ])
  })

  it('reads key=value, lower-case and numbered keys', () => {
    expect(parseKeyed('angle=pain | format=ugc | version=2')?.pairs).toEqual([
      { key: 'angle', value: 'pain' },
      { key: 'format', value: 'ugc' },
      { key: 'version', value: '2' },
    ])
    expect(parseKeyed('20250203_o:glowpack_a:winter_t:static_v:2')?.pairs.map(p => p.key)).toEqual(['o', 'a', 't', 'v'])
    expect(parseKeyed('QQ26-101_TT title_1:General_2:taste_6:VIDEO')?.pairs).toEqual([
      { key: '1', value: 'General' },
      { key: '2', value: 'taste' },
      { key: '6', value: 'VIDEO' },
    ])
  })

  it('leaves plain names alone', () => {
    expect(parseKeyed('TOF_ProblemSolution_BusyMom_UGC_Video_v2')).toBeNull()
    expect(parseKeyed('Summer sale hero 2')).toBeNull()
    expect(parseKeyed('Note: the summer one')).toBeNull()
    expect(parseKeyed('Landing https://example.com/x')).toBeNull()
    expect(parseKeyed('UGC_9:16_v2_10:30')).toBeNull()
  })
})

describe('detectSeparator', () => {
  it('picks the separator most names split on', () => {
    expect(detectSeparator(['A_B_C', 'D_E_F', 'G_H_I'])?.id).toBe('_')
    expect(detectSeparator(['A | B | C', 'D | E | F'])?.id).toBe('|')
    expect(detectSeparator(['Cold - UGC - Hook 1', 'Warm - Static - Hook 2'])?.id).toBe(' - ')
  })

  it('does not split free text on spaces', () => {
    expect(detectSeparator(['Summer sale hero 2', 'Black Friday promo', 'New founder video'])).toBeNull()
  })
})

describe('labelFromValues', () => {
  const m = (vs: string[]) => new Map(vs.map(v => [v, 2]))
  it('names a field by what its values look like', () => {
    expect(labelFromValues(m(['TOF', 'MOF', 'BOF']))).toBe('Funnel (ad name)')
    expect(labelFromValues(m(['Prospecting', 'Retargeting']))).toBe('Funnel (ad name)')
    expect(labelFromValues(m(['UGC', 'Static', 'Carousel']))).toBe('Format')
    expect(labelFromValues(m(['UGC', 'In House', 'Studio']))).toBe('Production style')
    expect(labelFromValues(m(['v1', 'v2', 'V3']))).toBe('Version')
    expect(labelFromValues(m(['9x16', '1x1', '4x5']))).toBe('Ratio')
    expect(labelFromValues(m(['@jane.doe', '@brand']))).toBe('Creator')
    expect(labelFromValues(m(['15s', '30s', '0:45']))).toBe('Length')
    expect(labelFromValues(m(['H1', 'H2', 'Hook 3']))).toBe('Hook')
    expect(labelFromValues(m(['Home Page', 'Sale Page', 'PDP']))).toBe('Landing page')
    expect(labelFromValues(m(['No Offer', '20% Off', 'BOGO']))).toBe('Offer')
    expect(labelFromValues(m(['Net New', 'Iteration']))).toBe('Type')
    expect(labelFromValues(m(['BusyMom', 'Gift Giver', 'MenOver50']))).toBe('Persona')
    expect(labelFromValues(m(['EN', 'FR', 'DE']))).toBe('Language')
    expect(labelFromValues(m(['Orchid', 'Granite']))).toBeNull()
  })
})

describe('detectNaming: the original styles', () => {
  it('turns positional names into labelled fields', () => {
    const r = detectNaming(ads([
      'TOF_ProblemSolution_BusyMom_UGC_Video_v2',
      'TOF_ProblemSolution_Gifter_Studio_Video_v1',
      'MOF_Testimonial_BusyMom_UGC_Video_v1',
      'BOF_Offer_Gifter_Studio_Static_v3',
      'MOF_Testimonial_Gifter_UGC_Static_v2',
      'TOF_ProblemSolution_BusyMom_Studio_Static_v1',
    ]))
    expect(r.separator).toBe('_')
    expect(r.positionalCount).toBe(6)
    expect(labels(r)).toEqual(['Funnel (ad name)', 'Angle', 'Persona', 'Format', 'Production style', 'Version'])
    expect(valueOf(r, 'a1', 'Funnel (ad name)')).toBe('TOF')
    expect(valueOf(r, 'a1', 'Version')).toBe('v2')
    expect(valueOf(r, 'a1', 'Format')).toBe('Video')
    expect(valueOf(r, 'a1', 'Production style')).toBe('UGC')
  })

  it('names keyed fields by their keys and drops the id prefix', () => {
    const r = detectNaming(ads([
      'FP:MOF-AN:Social Proof-PE:Gift Giver-FO:Static',
      'FP:TOF-AN:Social Proof-PE:Busy Mom-FO:Video',
      'FP:BOF-AN:Offer-PE:Gift Giver-FO:Static',
      'FP:TOF-AN:Offer-PE:Busy Mom-FO:Video',
      'QX02N00001M100126-TY:Net New-AN:Microscopic Structure',
      'QX02N00002M100126-TY:Net New-AN:Microscopic Structure',
      'QX02I00003M100226-TY:Iteration-AN:Social Proof',
    ]))
    expect(r.keyedCount).toBe(7)
    expect(labels(r)).toEqual(['Funnel (ad name)', 'Angle', 'Persona', 'Format', 'Type'])
    expect(valueOf(r, 'a1', 'Angle')).toBe('Social Proof')
    expect(valueOf(r, 'a5', 'Type')).toBe('Net New')
    expect(valueOf(r, 'a5', 'Angle')).toBe('Microscopic Structure')
  })

  it('keys fields by label, so a chosen field survives new data', () => {
    const r = detectNaming(ads(['FP:TOF-AN:Offer', 'FP:MOF-AN:Offer', 'FP:TOF-AN:Social Proof', 'FP:BOF-AN:Social Proof']))
    expect(r.fields.map(f => f.key)).toEqual(['nm:funnel-ad-name', 'nm:angle'])
  })

  it('finds nothing in free-text names', () => {
    const r = detectNaming(ads(['Summer sale hero 2', 'Black Friday promo', 'New founder video', 'Summer sale hero 3']))
    expect(r.fields).toEqual([])
    expect(r.otherCount).toBe(4)
  })

  it('skips date and id positions, whatever the date format', () => {
    const r = detectNaming(ads([
      'TOF_UGC_20260105_8812',
      'MOF_Static_01.05.26_8813',
      'TOF_UGC_Jan5_8814',
      'BOF_Static_2026-01-05_8815',
      'MOF_UGC_010526_8816',
      'BOF_Static_5/14/2026_8817',
    ]))
    // UGC and Static share the column: the format, as many accounts write it.
    expect(labels(r)).toEqual(['Funnel (ad name)', 'Format'])
    expect(valueOf(r, 'a2', 'Format')).toBe('Static')
  })

  it('folds case, spacing, plurals and one-letter typos', () => {
    const r = detectNaming(ads([
      'tof_UGC_Excitement_a', 'TOF_ugc_Excitement_b', 'MOF_Static_Excitement_c', 'mof_statics_Excitment_d',
      'TOFU_Static_Desire_e', 'BOF_vid_Desire_f', 'BOF_Video_Desire_g', 'MOF_Video_Desire_h',
    ]))
    expect(groupsOf(r, 'Funnel (ad name)')).toEqual({ TOF: 3, MOF: 3, BOF: 2 })
    expect(groupsOf(r, 'Emotion')).toEqual({ Excitement: 4, Desire: 4 })
    expect(fieldBy(r, 'Format')?.distinct).toBe(3)
  })
})

describe('detectNaming: one account, two conventions', () => {
  it('pools keyed and positional names into the same fields', () => {
    const r = detectNaming(ads([
      'FP:TOF-AN:Social Proof',
      'FP:MOF-AN:Offer',
      'FP:TOF-AN:Offer',
      'TOF_Hook1_UGC',
      'BOF_Hook2_Static',
      'MOF_Hook1_UGC',
      'Summer sale hero 2',
    ]))
    const funnel = fieldBy(r, 'Funnel (ad name)')
    expect(funnel?.source).toBe('mixed')
    expect(funnel?.coverage).toBe(6)
    expect(valueOf(r, 'a1', 'Funnel (ad name)')).toBe('TOF')
    expect(valueOf(r, 'a5', 'Funnel (ad name)')).toBe('BOF')
    // The free-text name follows neither pattern: no values, "(other)" in the space.
    expect(r.values.get('a7')).toBeUndefined()
    expect(r.otherCount).toBe(1)
  })

  it('merges the demo brand: underscore names and planner keys', () => {
    const r = detectNaming(ads([
      'FP:BOF-AN:Offer-PE:Over 40-FO:UGC-TY:Video',
      'FP:MOF-AN:Ingredient-PE:Busy Mom-FO:Graphic-TY:Static',
      'FP:TOF-AN:Social Proof-PE:Glow Seeker-FO:Studio-TY:Static',
      'FP:MOF-AN:Offer-PE:Glow Seeker-FO:Founder-TY:Video - Copy',
      'BOF_Offer_GlowSeeker_Studio_Static_v3 copy',
      'MOF_Offer_BusyMom_UGC_Video_v2',
      'TOF_Ingredient_GlowSeeker_Graphic_Static_v3',
      'MOF_SocialProof_Over40_Founder_Video_v1',
      'TOF_Ingredient_BusyMom_Lifestyle_Static_v1 (2)',
      'Copy of Copy of offer static 2',
    ]))
    expect(labels(r)).toEqual(['Funnel (ad name)', 'Angle', 'Persona', 'Format', 'Type', 'Version'])
    // FO (UGC, Graphic, Founder) and the 4th underscore position are one field,
    // TY (Video, Static) and the 5th one another, named by the planner keys.
    expect(fieldBy(r, 'Format')?.source).toBe('mixed')
    expect(fieldBy(r, 'Format')?.coverage).toBe(9)
    expect(fieldBy(r, 'Type')?.coverage).toBe(9)
    expect(valueOf(r, 'a6', 'Type')).toBe('Video')
    expect(valueOf(r, 'a8', 'Angle')).toBe('Social Proof')
    expect(valueOf(r, 'a8', 'Persona')).toBe('Over 40')
    expect(r.values.get('a10')).toBeUndefined()
  })

  it('pools a pipe convention with a dash convention', () => {
    const r = detectNaming(ads([
      'QX20N00001M010526-Net New-Glow Serum-Static-High-Y',
      'QX20N00002M010526-Net New-Night Cream-Video-High-Y',
      'QX20N00003916010526-Net New-Glow Serum-Video-Medium-Y',
      'QX21I00004M080526-Iteration-Night Cream-Static-High-N',
      'QX21N00005M080526-Net New-Glow Serum-Static-High-Y',
      'X101 | Image | Price Promise | Home Page',
      'X102 | Video | Spring Sale | Sale Page',
      'X103 | Image | Price Promise | Sale Page',
      'X104 | Video | Founder Story | Home Page',
      'X105 | Image | Spring Sale | Home Page',
    ]))
    expect(groupsOf(r, 'Format')).toEqual({ Static: 3, Video: 4, Image: 3 })
    expect(groupsOf(r, 'Landing page')).toEqual({ 'Home Page': 3, 'Sale Page': 2 })
    expect(groupsOf(r, 'Product')).toEqual({ 'Glow Serum': 3, 'Night Cream': 2 })
  })
})

describe('detectNaming: real-world shapes', () => {
  it('reads planner names without keys, where skipped fields shift the rest', () => {
    // UCID, Type, Product, then optional Emotion, free text, optional Funnel,
    // Format, optional Production style, Quality, Overlay, optional Placement.
    const r = detectNaming(ads([
      'QX14N00012M150326-Net New-Glow Serum-Desire-Morning Routine-TOF-Static-High-Y',
      'QX14N00013M150326-Net New-Glow Serum-Desire-Morning Routine-TOF-Static-High-Y - Copy',
      'QX14N00014916150326-Net New-Night Cream-Trust-Before Bed-MOF-Video-UGC-Medium-Y',
      'QX15N00015916220326-Net New-Night Cream-Before Bed-Video-UGC-Medium-N',
      'QX15I00016M220326-Iteration-Multi-Desire-Gift Set Hero-BOF-Static-Studio-High-Y-All',
      'QX15I00017M220326-Iteration-Multi-Gift Set Hero-Static-High-Y',
      'QX16N00018M290326-Net New--Price Anchor-TOF-Static-High-Y',
      'QX16N00019916290326-Net New-Glow Serum-Excitment-Texture Close Up-TOF-Video-In House-Low-Y',
      'QX16N00020916290326-Net New-Glow Serum-Excitement-Texture Close Up-MOF-Video-In House-Low-Y',
      'QX17N00021M050426-Net New-Night Cream-Trust-Skin Barrier-MOF-Static-UGC-High-Y-All',
      'QX17N00022M050426-Net New-Multi-Skin Barrier-BOF-Static-High-Y',
      'QX17I00023916050426-Iteration-Glow Serum-Desire-Morning Routine-TOF-Video-UGC-Medium-Y',
    ]))
    expect(labels(r)).toEqual(expect.arrayContaining([
      'Funnel (ad name)', 'Product', 'Format', 'Production style', 'Type', 'Emotion', 'Ratio', 'Quality', 'Overlay',
    ]))
    expect(groupsOf(r, 'Funnel (ad name)')).toEqual({ TOF: 5, MOF: 3, BOF: 2 })
    expect(groupsOf(r, 'Product')).toEqual({ 'Glow Serum': 5, 'Night Cream': 3, Multi: 3 })
    expect(groupsOf(r, 'Format')).toEqual({ Static: 7, Video: 5 })
    expect(groupsOf(r, 'Quality')).toEqual({ High: 7, Medium: 3, Low: 2 })
    expect(groupsOf(r, 'Overlay')).toEqual({ Y: 11, N: 1 })
    // Excitment is the planner template's spelling: one value with Excitement.
    expect(groupsOf(r, 'Emotion')).toEqual({ Desire: 4, Trust: 2, Excitment: 2 })
    // The id's ratio code: M is several ratios, 916 is 9x16.
    expect(groupsOf(r, 'Ratio')).toEqual({ MultiR: 7, '9x16': 5 })
    expect(valueOf(r, 'a7', 'Product')).toBeUndefined()
  })

  it('opens a pipe position that holds its own pattern', () => {
    const r = detectNaming(ads([
      '512 | BR | Static | morning glow - serum - BOF - static | @glowbrand | (Ends = Never) - Live: 3/2/2025',
      '513 | WL | Video | Ana - serum - MOF - video | @ana.makes | (Ends = Never) - Live: 3/4/2025',
      '514 | BR | Static | stock up - multi pack - TOF - static | @glowbrand | (Ends = Never) - Live: 3/9/2025 - Copy',
      '515 | BR | Video | dry skin - cream - TOF - video | @glowbrand | (Ends = Never) - Live: 3/11/2025',
      '516 | WL | Video | Maya - cream - MOF - video | @maya.daily | (Ends = Never) - Live: 3/12/2025',
      '517 | BR | Static | come back - serum - winback - static | @glowbrand | (Ends = Never) - Live: 3/16/2025',
      '518 | BR | Static | new formula - cream - TOF - static | @glowbrand | (Ends = Never) - Live: 3/19/2025',
      '519 | WL | Video | Ana - multi pack - MOF - video | @ana.makes | (Ends = Never) - Live: 3/22/2025',
    ]))
    expect(groupsOf(r, 'Funnel (ad name)')).toEqual({ TOF: 3, MOF: 3, BOF: 1, winback: 1 })
    expect(groupsOf(r, 'Product')).toEqual({ serum: 3, cream: 3, 'multi pack': 2 })
    expect(groupsOf(r, 'Format')).toEqual({ Static: 4, Video: 4 })
    expect(groupsOf(r, 'Identity')).toEqual({ BR: 5, WL: 3 })
    expect(groupsOf(r, 'Creator')).toEqual({ '@glowbrand': 5, '@ana.makes': 2, '@maya.daily': 1 })
    // The duplicate of Format inside the position is not a second field.
    expect(labels(r).filter(l => l.startsWith('Format'))).toEqual(['Format'])
  })

  it('reads numbered keys inside underscore names', () => {
    const r = detectNaming(ads([
      'QQ26-101_UGC jane balm_1:Runners_2:texture_4:noPromo_5:BERRY_6:VIDEO_S:30_7:studioLight_9:homePage_P01-HOME',
      'QQ26-102_UGC kim balm_1:Parents_2:scent_4:noPromo_5:MULTI_6:VIDEO_S:15_7:phoneUGC_9:homePage_P01-HOME',
      'QQ26-103_Static new scent_1:Runners_2:newScent_4:noPromo_5:BERRY_6:IMAGE_S:00_7:aiRender_9:homePage_P01-HOME',
      'QQ26-104_Static new scent_1:MenOver50_2:texture_4:launchDeal_5:MULTI_6:IMAGE_S:00_7:aiRender_9:quizPage_P07-QUIZ',
      'QQ26-105_UGC lee balm_1:Runners_2:texture_4:noPromo_5:MULTI_6:VIDEO_S:30_7:studioLight_9:homePage_P01-HOME',
      'QQ26-106_Static texture_1:Parents_2:texture_4:noPromo_5:BERRY_6:IMAGE_S:00_7:aiRender_9:quizPage_P07-QUIZ',
      'QQ26-107_UGC ana balm_1:Runners_2:scent_4:noPromo_5:BERRY_6:VIDEO__7:studioLight_9:homePage_P01-HOME',
      'QQ26-108_UGC ana balm_1:Parents_2:texture_4:noPromo_5:MULTI_6:VIDEO_S:45_7:phoneUGC_9:homePage_P01-HOME',
    ]))
    expect(r.keyedCount).toBe(8)
    expect(groupsOf(r, 'Persona')).toEqual({ Runners: 4, Parents: 3, MenOver50: 1 })
    expect(groupsOf(r, 'Format')).toEqual({ VIDEO: 5, IMAGE: 3 })
    expect(groupsOf(r, 'Production style')).toEqual({ studioLight: 3, phoneUGC: 2, aiRender: 3 })
    expect(groupsOf(r, 'Offer')).toEqual({ noPromo: 7, launchDeal: 1 })
    expect(groupsOf(r, 'Landing page')).toEqual({ homePage: 6, quizPage: 2 })
  })

  it('reads single-letter keys and lets values name them', () => {
    const r = detectNaming(ads([
      '20250203_o:glowpack_a:winter_t:static_f:social-proof_v:2',
      '20250204_o:glowpack_a:energy_t:video_f:founder-story_v:1_c:mia',
      '20250117_o:nightpack_a:sleep_t:static_f:social-proof_v:3',
      '20250203_o:glowpack_a:focus_t:video_f:listicle_v:3_c:lena',
      '20250211_o:nightpack_a:calm_t:static_f:listicle_v:1_c:mia',
      '20250214_o:glowpack_a:sleep_t:carousel_f:social-proof_v:1_c:mia',
    ]))
    expect(groupsOf(r, 'Offer')).toEqual({ glowpack: 4, nightpack: 2 })
    // t and f are short keys: their values name them (Static and Video are a
    // format, social proof and listicle an angle).
    expect(groupsOf(r, 'Format')).toEqual({ static: 3, video: 2, carousel: 1 })
    expect(groupsOf(r, 'Angle')).toEqual({ 'social-proof': 3, listicle: 2, 'founder-story': 1 })
    expect(groupsOf(r, 'Creator')).toEqual({ mia: 3, lena: 1 })
    expect(groupsOf(r, 'Version')).toEqual({ '1': 3, '2': 1, '3': 2 })
  })

  it('reads hyphen keys when a family of names is built from them', () => {
    const r = detectNaming(ads([
      'BigClaim_#-3001_Cm-Core_f-Static_pr-Kit_pe-Parent_h-Ask_lg-EN',
      'QuietMorning_#-3002_Cm-Core_f-Video_pr-Kit_pe-Parent_h-Ask_lg-DE',
      'SideBySide_#-3003_Cm-Pulse_f-Static_pr-Kit Plus_pe-Runner_h-Clock_lg-FR',
      'NoteCard_#-3004_Cm-Pulse_f-Video_pr-Kit_pe-Parent_h-Clock_lg-EN',
      'TwistTest_#-3005_Cm-Core_f-Static_pr-Kit Plus_pe-Runner_h-Ask_lg-FR',
      'CreatorCut_#-3006_Cm-Core_f-Video_pr-Kit_pe-Parent_h-Ask_lg-EN',
    ]))
    expect(groupsOf(r, 'Language')).toEqual({ EN: 3, DE: 1, FR: 2 })
    expect(groupsOf(r, 'Persona')).toEqual({ Parent: 4, Runner: 2 })
    expect(groupsOf(r, 'Campaign')).toEqual({ Core: 4, Pulse: 2 })
    expect(groupsOf(r, 'Format')).toEqual({ Static: 3, Video: 3 })
    expect(labels(r).some(l => /^Field #/.test(l))).toBe(false)
  })

  it('reads bracket tags as tokens and tag keys', () => {
    const r = detectNaming(ads([
      '[TOF] [UGC] Hook - Pain Point',
      '[MOF] [Static] Hook - Social Proof',
      '[TOF] [UGC] Hook - Social Proof',
      '[BOF] [Static] Offer - Bundle',
      '[MOF] [UGC] Hook - Pain Point',
      '[BOF] [Static] Offer - Bundle',
    ]))
    expect(groupsOf(r, 'Funnel (ad name)')).toEqual({ TOF: 2, MOF: 2, BOF: 2 })
    expect(groupsOf(r, 'Format')).toEqual({ UGC: 3, Static: 3 })

    const tagged = detectNaming(ads([
      'Silver Hoop 1 | Apr 2024 [k2-1]-[k3-img]-[k4-pr]-[k8-lux]',
      'Silver Hoop 2 | Apr 2024 [k2-1]-[k3-gif]-[k4-pr]-[k8-lux]',
      'Pearl Drop 1 | May 2024 [k2-1]-[k3-img]-[k4-pr]-[k8-min]',
      'Pearl Drop 2 | May 2024 [k2-1]-[k3-col]-[k4-pr]-[k8-lux]',
      'Silver Hoop 3 | Jun 2024 [k2-1]-[k3-img]-[k4-pr]-[k8-min]',
    ]))
    expect(groupsOf(tagged, 'Format')).toEqual({ img: 3, gif: 1, col: 1 })
  })

  it('reads two-token names and the pattern inside the second token', () => {
    const r = detectNaming(ads([
      'Video | Rosa - Morning Walk',
      'Static | Happy Owners - Soft Coat',
      'Video | Rosa - Why We Started',
      'Video | Theo - Treat Time',
      'Static | Bowl Topper',
      'Video | Theo - Calm Evenings',
      'Static | Happy Owners - Fewer Scratches',
      'Video | Rosa - Day One',
      'Carousel | Theo - Park Day',
    ]))
    expect(groupsOf(r, 'Format')).toEqual({ Video: 5, Static: 3, Carousel: 1 })
    expect(groupsOf(r, 'Name field 1')).toEqual({ Rosa: 3, Theo: 3, 'Happy Owners': 2 })
  })

  it('lines up a slug convention with an optional version token and accents', () => {
    const r = detectNaming(ads([
      '03.02.25_ad901_lumo_colageno_video-ugc_energy-boost_authority',
      '04.02.25_ad902_lumo_colageno_imagem_energy-boost_authority',
      '05.02.25_ad903_lumo_zinco_imagem_sleep-better_routine',
      '06.02.25_ad904_lumo_zinco_carrossel_sleep-better_routine',
      '07.02.25_ad905_lumo_colageno_imagem_heart-health_authority',
      '08.02.25_Ad906_V2_Lumo_Colágeno_Vídeo UGC_Energy Boost_authority',
      '09.02.25_ad907_lumo_zinco_video-ugc_heart-health_routine',
    ]))
    // The V2 token does not shift the fields after it; Colágeno is colageno and
    // Vídeo UGC is video-ugc (accents, case and separators fold; the spaced
    // spelling, else the most common one, names the group).
    expect(groupsOf(r, 'Format')).toEqual({ imagem: 3, 'Vídeo UGC': 3, carrossel: 1 })
    expect(groupsOf(r, 'Name field 1')).toEqual({ colageno: 4, zinco: 3 })
    expect(valueOf(r, 'a6', 'Name field 1')).toBe('colageno')
  })

  it('drops ids, sentences and placeholders from Meta post names', () => {
    const r = detectNaming(ads([
      '1000000000001 - IMAGE CAROUSEL - NA - Organic post - Layer it up for the colder months ahead',
      '1000000000002 - VIDEO - NA - Organic post - Five ways to wear the new collection',
      '1000000000003 - IMAGE - NA - Organic post - Made to last',
      '1000000000004 - VIDEO - n/a - Organic post - Close up with a text overlay',
      '1000000000005 - IMAGE - NA - Organic post - On the hand',
      '1000000000006 - VIDEO - NA - Organic post - Stacked',
    ]))
    expect(labels(r)).toEqual(['Format'])
    expect(groupsOf(r, 'Format')).toEqual({ 'IMAGE CAROUSEL': 1, VIDEO: 3, IMAGE: 2 })
  })

  it('reads "Video 2" as the n-th of something, not a format', () => {
    const r = detectNaming(ads([
      'Dana Price - Video 1 - Jan 2025', 'Dana Price - Video 2 - Feb 2025', 'Dana Price - Video 2 - Feb 2025',
      'Lia Moreno - Video 1 - Jan 2025', 'Lia Moreno - Video 3 - Mar 2025', 'Lia Moreno - Video 3 - Mar 2025',
    ]))
    expect(fieldBy(r, 'Format')).toBeUndefined()
    expect(groupsOf(r, 'Version')).toEqual({ 'Video 1': 2, 'Video 2': 2, 'Video 3': 2 })
    expect(groupsOf(r, 'Name field 1')).toEqual({ 'Dana Price': 3, 'Lia Moreno': 3 })
  })

  it('leaves a field out when it does not group', () => {
    // Every position here is one value per ad, or a single repeated value.
    const r = detectNaming(ads([
      'lumo_hero one_alpha', 'lumo_hero two_bravo', 'lumo_hero three_charlie',
      'lumo_hero four_delta', 'lumo_hero five_echo', 'lumo_hero six_foxtrot',
    ]))
    expect(r.fields).toEqual([])
  })
})
