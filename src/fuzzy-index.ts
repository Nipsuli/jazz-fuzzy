import {
  Config,
  NgramComputer,
  NgramNormalizer,
  QualityComputer,
} from "@m31coding/fuzzy-search";
import type { LoadedInvertedIndex } from "./inverted-index.ts";
import {
  calculateTermMeta,
  removeFromInvertedIndex,
  upsertToInvertedIndex,
} from "./inverted-index.ts";

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

  query(query: string, minQuality = 0) {
    // Logic modified from @m31coding/fuzzy-search
    const results = [] as { id: string; quality: number }[];
    if (query.trim().length === 0) {
      return results;
    }
    const ngrams = this.ngrams(query);
    const ngramMeta = calculateTermMeta(ngrams);
    const ngramsLength = ngrams.length;

    const matchingTermsMap = {} as Record<string, number>;

    for (const [ngram, meta] of Object.entries(ngramMeta)) {
      const postings = this.index.postings[ngram];
      if (postings) {
        for (const [docId, posting] of Object.entries(postings)) {
          matchingTermsMap[docId] ??= 0;
          matchingTermsMap[docId] += Math.min(
            meta.frequency,
            posting.frequency,
          );
        }
      }
    }

    for (const [docId, docFreq] of Object.entries(matchingTermsMap)) {
      const quality = QualityComputer.ComputeOverlapMaxCoefficient(
        ngramsLength,
        this.index.meta[docId]?.termCount ?? 0,
        docFreq,
      );
      if (quality >= minQuality) {
        results.push({ id: docId, quality });
      }
    }

    const res = results.sort((a, b) => b.quality - a.quality);
    return res;
  }
}
