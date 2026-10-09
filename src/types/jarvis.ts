export type PhoneActionSafety = 'safe' | 'sensitive' | 'destructive' | 'unknown'

export interface WebQueryResult {
  title: string
  summary: string
  url: string
  source: 'Wikipedia' | 'Wikidata'
  confirmedWeb: boolean
  rawContent?: string
}
