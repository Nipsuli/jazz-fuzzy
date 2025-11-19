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

export type QueryMeta = {
  candidateSize: number;
  timings: {
    ngramCreation: number;
    ngramMeta: number;
    ngramSorting: number;
    candidateExpansion: number;
    qualityComputation: number;
    sorting: number;
    total: number;
  };
};

export type QueryResponse = {
  results: QueryResult[];
  meta: QueryMeta;
};

type NgramMeta = {
  frequency: number;
  positions: number[];
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

  private calculateRelativePositionScore(
    queryPositions: number[],
    docPositions: number[],
    queryLength: number,
    _docLength: number,
  ): number {
    const firstQueryPosition = queryPositions[0];
    if (!firstQueryPosition || docPositions.length === 0) {
      return 0;
    }

    let bestScore = 0;

    // For each possible starting position in the document
    for (const startDocPos of docPositions) {
      let currentScore = 0;
      let consecutiveBonus = 0;
      let lastExpectedPos = startDocPos - 1;

      // Check how well query order is preserved starting from this position
      for (const queryPos of queryPositions) {
        const expectedDocPos = startDocPos + (queryPos - firstQueryPosition);

        // Find closest actual position to expected position
        let closestDistance = Infinity;
        for (const docPos of docPositions) {
          const distance = Math.abs(docPos - expectedDocPos);
          if (distance < closestDistance) {
            closestDistance = distance;
          }
        }

        // Score based on how close we are to expected position
        if (closestDistance <= 3) {
          // Within 3 positions is good
          const positionScore = 1 / (1 + closestDistance * 0.5);
          currentScore += positionScore;

          // Consecutive bonus if this position follows the previous one
          const actualPos = expectedDocPos; // Simplified for now
          if (actualPos === lastExpectedPos + 1) {
            consecutiveBonus += 0.5;
          }
          lastExpectedPos = actualPos;
        }
      }

      currentScore += consecutiveBonus;
      bestScore = Math.max(bestScore, currentScore);
    }

    // Normalize by query length
    return bestScore / queryLength;
  }

  private calculateDocumentScore(
    docId: string,
    matchedNgrams: Map<string, number>,
    ngramMeta: Record<string, NgramMeta>,
    queryLength: number,
    docFreqs: DocumentFrequencies,
    totalDocs: number,
    avgDocLength: number,
  ): number {
    const docMeta = this.index.meta[docId];
    if (!docMeta) {
      return 0;
    }

    let bm25Score = 0;
    let positionScore = 0;
    let rarityBonus = 0;
    const matchedQueryNgrams = new Set<string>();

    // Calculate BM25 + position scores for each matched ngram
    for (const [ngram, termFreq] of matchedNgrams) {
      if (termFreq === 0) {
        continue;
      }

      matchedQueryNgrams.add(ngram);
      const docFreq = docFreqs.get(ngram) || 1;

      // BM25 component
      bm25Score += this.calculateBM25Score(
        termFreq,
        docMeta.termCount,
        avgDocLength,
        docFreq,
        totalDocs,
      );

      // Position component using relative positioning
      const queryMeta = ngramMeta[ngram];
      const termEntry = this.index.postings[ngram];
      const docPosting = termEntry?.postings?.[docId];
      if (queryMeta && docPosting) {
        positionScore += this.calculateRelativePositionScore(
          queryMeta.positions,
          docPosting.positions,
          queryLength,
          docMeta.termCount,
        );
      }

      // Rarity bonus - rare ngrams get extra weight
      if (docFreq < totalDocs * 0.01) {
        // Less than 1% of docs
        rarityBonus += 0.2;
      }
    }

    // Query coverage component
    const coverage = matchedQueryNgrams.size / Object.keys(ngramMeta).length;
    const coverageScore = Math.pow(coverage, 0.5); // Square root for diminishing returns

    // Combined score with weights
    const finalScore =
      bm25Score * 0.6 + // Main relevance (60%)
      positionScore * 0.2 + // Position bonus (20%)
      coverageScore * 0.15 + // Coverage bonus (15%)
      rarityBonus * 0.05; // Rarity bonus (5%)

    return finalScore;
  }

  query(query: string, minQuality = 0): QueryResponse {
    const queryStart = performance.now();
    const results = [] as QueryResult[];

    if (query.trim().length === 0) {
      return {
        results,
        meta: {
          candidateSize: 0,
          timings: {
            ngramCreation: 0,
            ngramMeta: 0,
            ngramSorting: 0,
            candidateExpansion: 0,
            qualityComputation: 0,
            sorting: 0,
            total: 0,
          },
        },
      };
    }

    const ngramCreationStart = performance.now();
    const ngrams = this.ngrams(query);
    const ngramCreationEnd = performance.now();
    const ngramCreationTime = ngramCreationEnd - ngramCreationStart;

    const ngramMetaStart = performance.now();
    const ngramMeta = calculateTermMeta(ngrams);
    const queryNgramsLength = ngrams.length;
    const uniqueQueryNgrams = Object.keys(ngramMeta);
    const ngramMetaEnd = performance.now();
    const ngramMetaTime = ngramMetaEnd - ngramMetaStart;

    const ngramSortingStart = performance.now();
    const { sortedNgrams, docFreqs } =
      this.getSortedNgramsWithCache(uniqueQueryNgrams);
    const ngramSortingEnd = performance.now();
    const ngramSortingTime = ngramSortingEnd - ngramSortingStart;

    const candidateSet = new Set<string>();
    // TODO: make the candidate size dynamic
    const maxCandidates = 200; // Target candidate pool size

    const candidateStart = performance.now();

    // Process ngrams in order of rarity, expanding candidate set until we hit target size
    for (const ngram of sortedNgrams) {
      const termEntry = this.index.postings[ngram];
      if (!termEntry || !termEntry.postings) {
        // Ngram not found - skip this ngram
        continue;
      }
      for (const docId of Object.keys(termEntry.postings)) {
        candidateSet.add(docId);
      }
      if (candidateSet.size >= maxCandidates) {
        break;
      }
    }

    const candidateEnd = performance.now();
    const candidateTime = candidateEnd - candidateStart;
    const finalCandidateSize = candidateSet.size;

    // Calculate comprehensive scores
    const qualityStart = performance.now();
    const totalDocs = Object.keys(this.index.meta).length;
    const avgDocLength =
      Object.values(this.index.meta).reduce(
        (sum, doc) => sum + doc.termCount,
        0,
      ) / totalDocs;

    for (const docId of candidateSet) {
      const matchedNgrams = new Map<string, number>();

      // Collect matched ngrams for this document
      for (const ngram of uniqueQueryNgrams) {
        const termEntry = this.index.postings[ngram];
        const posting = termEntry?.postings?.[docId];
        matchedNgrams.set(ngram, posting?.frequency || 0);
      }

      const score = this.calculateDocumentScore(
        docId,
        matchedNgrams,
        ngramMeta,
        queryNgramsLength,
        docFreqs,
        totalDocs,
        avgDocLength,
      );

      if (score >= minQuality) {
        results.push({ id: docId, quality: score });
      }
    }

    const qualityEnd = performance.now();
    const qualityTime = qualityEnd - qualityStart;

    const sortStart = performance.now();
    const sortedResults = results.sort((a, b) => b.quality - a.quality);
    const sortEnd = performance.now();
    const sortTime = sortEnd - sortStart;

    const queryEnd = performance.now();
    const totalTime = queryEnd - queryStart;

    return {
      results: sortedResults,
      meta: {
        candidateSize: finalCandidateSize,
        timings: {
          ngramCreation: ngramCreationTime,
          ngramMeta: ngramMetaTime,
          ngramSorting: ngramSortingTime,
          candidateExpansion: candidateTime,
          qualityComputation: qualityTime,
          sorting: sortTime,
          total: totalTime,
        },
      },
    };
  }
}
