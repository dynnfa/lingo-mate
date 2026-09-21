import { describe, expect, it } from 'vitest'
import {
  exploreVocabularyExampleContainsTerm,
  isExploreVocabularyTermShape,
  normalizeExploreVocabularyTerm
} from '../normalize-explore-vocabulary'

describe('normalizeExploreVocabularyTerm', () => {
  it('applies NFKC, trim, whitespace folding and lowercasing', () => {
    expect(normalizeExploreVocabularyTerm('  Reliable  ')).toBe('reliable')
    expect(normalizeExploreVocabularyTerm('Ｗｅｌｌ')).toBe('well')
    expect(normalizeExploreVocabularyTerm('a   b')).toBe('a b')
  })

  it('folds curly apostrophes to the ASCII apostrophe', () => {
    expect(normalizeExploreVocabularyTerm('don’t')).toBe("don't")
    expect(normalizeExploreVocabularyTerm('‘hello’')).toBe("'hello'")
  })
})

describe('isExploreVocabularyTermShape', () => {
  it('accepts single words including hyphenated and apostrophe forms', () => {
    expect(isExploreVocabularyTermShape('reliable')).toBe(true)
    expect(isExploreVocabularyTermShape('well-known')).toBe(true)
    expect(isExploreVocabularyTermShape("don't")).toBe(true)
  })

  it('rejects multi-word phrases, digits and punctuation-only entries', () => {
    expect(isExploreVocabularyTermShape('as a result')).toBe(false)
    expect(isExploreVocabularyTermShape('b2b')).toBe(false)
    expect(isExploreVocabularyTermShape('-')).toBe(false)
    expect(isExploreVocabularyTermShape('')).toBe(false)
    expect(isExploreVocabularyTermShape('-well')).toBe(false)
    expect(isExploreVocabularyTermShape('well-')).toBe(false)
    expect(isExploreVocabularyTermShape('well--known')).toBe(false)
    expect(isExploreVocabularyTermShape("rock-'n'-roll")).toBe(false)
    expect(isExploreVocabularyTermShape('hello!')).toBe(false)
  })
})

describe('exploreVocabularyExampleContainsTerm', () => {
  it('matches whole words with case and whitespace tolerance', () => {
    expect(exploreVocabularyExampleContainsTerm('We need a Reliable connection.', 'reliable')).toBe(
      true
    )
    expect(
      exploreVocabularyExampleContainsTerm('Please do not  hesitate to ask.', 'hesitate')
    ).toBe(true)
  })

  it('does not match substrings inside longer words', () => {
    expect(exploreVocabularyExampleContainsTerm('The party was great.', 'art')).toBe(false)
    expect(exploreVocabularyExampleContainsTerm('She learned a lot.', 'learn')).toBe(false)
  })

  it('treats hyphens and apostrophes as in-word characters', () => {
    expect(exploreVocabularyExampleContainsTerm('He is well-known here.', 'known')).toBe(false)
    expect(exploreVocabularyExampleContainsTerm('He is well-known here.', 'well-known')).toBe(true)
    expect(exploreVocabularyExampleContainsTerm('They can’t stop now.', "can't")).toBe(true)
    expect(exploreVocabularyExampleContainsTerm('They cant stop now.', "can't")).toBe(false)
  })

  it('folds curly apostrophes on both sides before matching', () => {
    expect(exploreVocabularyExampleContainsTerm('They can’t stop now.', 'can’t')).toBe(true)
  })

  it('rejects empty terms', () => {
    expect(exploreVocabularyExampleContainsTerm('Anything.', '')).toBe(false)
  })
})
