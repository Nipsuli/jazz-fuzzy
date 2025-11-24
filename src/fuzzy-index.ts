import {
  Config,
  NgramComputer,
  NgramNormalizer,
} from "@m31coding/fuzzy-search";
import type { LoadedInvertedIndex } from "./inverted-index.ts";
import {
  calculateTermMeta,
  removeFromInvertedIndex,
  upsertToInvertedIndex,
} from "./inverted-index.ts";

export type QueryResult = {
  id: string;
  quality: number;
};

export type QueryResponse = {
  results: QueryResult[];
};

type DocumentFrequencies = Map<string, number>;

export class JazzFuzzyIndex {
  private index: LoadedInvertedIndex;
  private config: Config;
  private ngramComputer: NgramComputer;
  private ngramNormalizer: NgramNormalizer;

  constructor(invertedIndex: LoadedInvertedIndex) {
    this.index = invertedIndex;
    this.config = Config.createDefaultConfig();
    if (!this.config.fuzzySearchConfig) {
      throw new Error("Fuzzy search config is missing");
    }
    this.ngramComputer = new NgramComputer(
      this.config.fuzzySearchConfig.ngramN,
      this.config.fuzzySearchConfig.transformNgram,
    );

    this.ngramNormalizer = new NgramNormalizer(
      this.config.fuzzySearchConfig.paddingLeft,
      this.config.fuzzySearchConfig.paddingRight,
      this.config.fuzzySearchConfig.paddingMiddle,
    );
  }

  private ngrams(term: string) {
    const ngrams = this.ngramComputer.computeNgrams(term);
    return this.ngramNormalizer.normalizeBulk(ngrams).strings;
  }

  remove(docId: string) {
    removeFromInvertedIndex(this.index)(docId);
  }

  upsert(doc: { id: string; text: string }) {
    if (doc.text.trim().length === 0) {
      return;
    }
    const ngrams = this.ngrams(doc.text);
    upsertToInvertedIndex(this.index)({ id: doc.id, terms: ngrams });
  }

  private getSortedNgramsWithCache(uniqueQueryNgrams: string[]): {
    sortedNgrams: string[];
    docFreqs: DocumentFrequencies;
  } {
    const docFreqs = new Map<string, number>();
    const ngramSizes: Array<{ ngram: string; size: number }> = [];

    // Single pass to collect both sorting data and document frequencies
    for (const ngram of uniqueQueryNgrams) {
      const termEntry = this.index.postings[ngram];
      const docCount = termEntry ? termEntry.docCount : 0;
      docFreqs.set(ngram, docCount);
      ngramSizes.push({ ngram, size: docCount });
    }

    // Sort by document count (rarest first)
    const sortedNgrams = ngramSizes
      .sort((a, b) => a.size - b.size)
      .map((item) => item.ngram);

    return { sortedNgrams, docFreqs };
  }

  private calculateBM25Score(
    termFreq: number,
    docLength: number,
    avgDocLength: number,
    docFreq: number,
    totalDocs: number,
  ): number {
    const k1 = 1.2; // Term frequency saturation parameter
    const b = 0.75; // Length normalization parameter

    const idf = Math.log((totalDocs - docFreq + 0.5) / (docFreq + 0.5));
    const tf =
      (termFreq * (k1 + 1)) /
      (termFreq + k1 * (1 - b + b * (docLength / avgDocLength)));

    return idf * tf;
  }

  query(query: string, minQuality = 0): QueryResponse {
    if (query.trim().length === 0) {
      return {
        results: [],
      };
    }

    const ngrams = this.ngrams(query);

    const ngramMeta = calculateTermMeta(ngrams);
    const uniqueQueryNgrams = Object.keys(ngramMeta);

    const { sortedNgrams, docFreqs } =
      this.getSortedNgramsWithCache(uniqueQueryNgrams);

    // TODO: make the candidate size dynamic
    const maxCandidates = 200; // Target candidate pool size
    const totalDocs = this.index.corpusStats.totalDocuments;
    const avgDocLength =
      totalDocs > 0 ? this.index.corpusStats.totalTermCount / totalDocs : 0;
    const numQueryNgrams = uniqueQueryNgrams.length;

    const docScores = new Map<string, number>();
    const docCoverage = new Map<string, number>();

    const candidates = new Set<string>();

    // Process ngrams in order of rarity, building candidates and partial scores in one pass
    for (const ngram of sortedNgrams) {
      const termEntry = this.index.postings[ngram];
      if (!termEntry) {
        continue;
      }

      const docFreq = docFreqs.get(ngram)!;

      for (const docId in termEntry.postings) {
        const alreadyCandidate = candidates.has(docId);
        if (!alreadyCandidate && candidates.size >= maxCandidates) {
          continue; // pool is full; ignore new docs
        }

        const docPosting = termEntry.postings[docId]!;
        const docMeta = this.index.docMeta[docId]!;

        const bm25PartialScore = this.calculateBM25Score(
          docPosting.frequency,
          docMeta.termCount,
          avgDocLength,
          docFreq,
          totalDocs,
        );

        docScores.set(docId, (docScores.get(docId) ?? 0) + bm25PartialScore);
        docCoverage.set(docId, (docCoverage.get(docId) ?? 0) + 1);

        if (!alreadyCandidate) {
          candidates.add(docId);
        }
      }
    }

    const results: QueryResult[] = [];

    for (const docId of candidates) {
      const bm25Score = docScores.get(docId) || 0;
      if (bm25Score === 0) {
        continue;
      }

      const coverage = (docCoverage.get(docId) || 0) / numQueryNgrams;
      const coverageScore = Math.sqrt(coverage); // Diminishing returns for coverage

      // Combined score with weights (TODO: make configurable)
      const finalScore = bm25Score * 0.85 + coverageScore * 0.15;

      if (finalScore >= minQuality) {
        results.push({ id: docId, quality: finalScore });
      }
    }

    const sortedResults = results.sort((a, b) => b.quality - a.quality);

    return {
      results: sortedResults,
    };
  }
}
