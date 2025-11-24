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

export type QueryProfile = {
  query: string;
  timings: {
    totalMs: number;
    ngramMs: number;
    termStatsMs: number;
    candidateAccumulationMs: number;
    scoringMs: number;
    sortMs: number;
  };
  counts: {
    ngramCount: number;
    uniqueNgramCount: number;
    missingTerms: number;
    postingsVisited: number;
    candidateDocs: number;
    scoredDocs: number;
    resultsReturned: number;
  };
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

  query(
    query: string,
    options?: {
      minQuality?: number;
      profileCollector?: (profile: QueryProfile) => void;
    },
  ): QueryResponse {
    const minQuality = options?.minQuality ?? 0;
    const profileCollector = options?.profileCollector;
    // Short-circuit empty queries.
    const profiling = Boolean(profileCollector);
    const totalStart = profiling ? performance.now() : 0;

    if (query.trim().length === 0) {
      return {
        results: [],
      };
    }

    // 1) Tokenize and normalize query into ngrams.
    const ngramStart = profiling ? performance.now() : 0;
    const ngrams = this.ngrams(query);
    const ngramMs = profiling ? performance.now() - ngramStart : 0;

    // 2) Build term meta for frequency/positions and sort terms by rarity (doc frequency).
    const termStatsStart = profiling ? performance.now() : 0;
    const ngramMeta = calculateTermMeta(ngrams);
    const uniqueQueryNgrams = Object.keys(ngramMeta);

    const { sortedNgrams, docFreqs } =
      this.getSortedNgramsWithCache(uniqueQueryNgrams);
    const termStatsMs = profiling ? performance.now() - termStatsStart : 0;

    // 3) Choose a candidate cap adapted to term rarity so we don’t over-walk large postings.
    const baseMaxCandidates = 160;
    const rarestDocFreq = docFreqs.get(sortedNgrams[0] ?? "") ?? 0;
    const maxCandidates =
      rarestDocFreq > baseMaxCandidates * 2
        ? Math.max(64, Math.floor(baseMaxCandidates * 0.75))
        : baseMaxCandidates;
    const targetCandidates = Math.floor(maxCandidates * 0.9);
    const seedTermCount = Math.min(3, sortedNgrams.length);

    const totalDocs = this.index.corpusStats.totalDocuments;
    const avgDocLength =
      totalDocs > 0 ? this.index.corpusStats.totalTermCount / totalDocs : 0;

    const docScores: Record<string, number> = Object.create(null);

    const candidates = new Set<string>();
    let postingsVisited = 0;
    let missingTerms = 0;

    // Process ngrams in order of rarity, building candidates and partial scores in one pass.
    // Early-stop long postings when the pool is saturated to keep latency low.
    const candidateStart = profiling ? performance.now() : 0;
    const processTerm = (
      ngram: string,
      allowAggressiveUpdates: boolean,
    ): boolean => {
      const termEntry = this.index.postings[ngram];
      if (!termEntry) {
        missingTerms++;
        return false;
      }

      const docFreq = docFreqs.get(ngram)!;
      const cachedPostings = Object.entries(termEntry.postings);
      postingsVisited += cachedPostings.length;

      const updateBudget = 24; // tighter cap on updates when pool is full
      let updatesUsed = 0;

      for (const [docId, docPosting] of cachedPostings) {
        const alreadyCandidate = candidates.has(docId);
        if (alreadyCandidate && candidates.size >= maxCandidates) {
          if (!allowAggressiveUpdates && updatesUsed >= updateBudget) {
            continue; // too many updates when pool is saturated
          }
          updatesUsed++;
        } else if (!alreadyCandidate && candidates.size >= maxCandidates) {
          continue; // pool is full; ignore new docs
        }

        const bm25PartialScore = this.calculateBM25Score(
          docPosting.frequency,
          this.index.docMeta[docId]?.termCount ?? 0,
          avgDocLength,
          docFreq,
          totalDocs,
        );

        docScores[docId] = (docScores[docId] ?? 0) + bm25PartialScore;

        if (!alreadyCandidate) {
          candidates.add(docId);
        }

        if (
          !allowAggressiveUpdates &&
          candidates.size >= maxCandidates &&
          updatesUsed >= updateBudget
        ) {
          break; // stop walking long posting lists once saturated
        }
      }

      return candidates.size >= targetCandidates;
    };

    // Seed with the rarest terms to get high-signal candidates quickly.
    const seedTerms = sortedNgrams.slice(0, seedTermCount);
    for (const ngram of seedTerms) {
      processTerm(ngram, true);
    }

    // Use remaining (less rare) terms only if the pool is still under target.
    if (candidates.size < targetCandidates) {
      const remainingTerms = sortedNgrams.slice(seedTermCount);
      for (const ngram of remainingTerms) {
        const filled = processTerm(ngram, false);
        if (filled) {
          break;
        }
      }
    }

    const candidateAccumulationMs = profiling
      ? performance.now() - candidateStart
      : 0;

    const results: QueryResult[] = [];

    // 4) Score and filter candidates.
    const scoringStart = profiling ? performance.now() : 0;
    for (const docId of candidates) {
      const bm25Score = docScores[docId] || 0;
      if (bm25Score === 0) {
        continue;
      }

      // Final score uses BM25 only (coverage removed for simplicity/perf)
      const finalScore = bm25Score;

      if (finalScore >= minQuality) {
        results.push({ id: docId, quality: finalScore });
      }
    }
    const scoringMs = profiling ? performance.now() - scoringStart : 0;

    // 5) Sort results by quality.
    const sortStart = profiling ? performance.now() : 0;
    const sortedResults = results.sort((a, b) => b.quality - a.quality);
    const sortMs = profiling ? performance.now() - sortStart : 0;

    if (profileCollector) {
      const totalMs = performance.now() - totalStart;
      profileCollector({
        query,
        timings: {
          totalMs,
          ngramMs,
          termStatsMs,
          candidateAccumulationMs,
          scoringMs,
          sortMs,
        },
        counts: {
          ngramCount: ngrams.length,
          uniqueNgramCount: uniqueQueryNgrams.length,
          missingTerms,
          postingsVisited,
          candidateDocs: candidates.size,
          scoredDocs: Object.keys(docScores).length,
          resultsReturned: sortedResults.length,
        },
      });
    }

    return {
      results: sortedResults,
    };
  }
}
