import { co, z } from "jazz-tools";
import type { Account, Group, Loaded } from "jazz-tools";
import xxhash from "xxhash-wasm";

const { h64ToString } = await xxhash();

export type Doc = {
  id: string;
  terms: string[];
};

const InvertedIndexDocMeta = co.record(
  // DocId
  z.string(),
  z.object({
    hash: z.string(),
    termCount: z.number(),
    uniqueTerms: z.array(z.string()),
  }),
);

const InvertedIndexPostingData = co.record(
  // DocId
  z.string(),
  z.object({
    frequency: z.number(),
    positions: z.array(z.number()),
  }),
);

const InvertedIndexTermMeta = co.map({
  docCount: z.number(),
  postings: InvertedIndexPostingData,
});

const InvertedIndexCorpusStats = co.map({
  totalDocuments: z.number(),
  totalTermCount: z.number(),
});

export const InvertedIndexData = co.map({
  docMeta: InvertedIndexDocMeta,
  postings: co.record(
    // Term
    z.string(),
    InvertedIndexTermMeta,
  ),
  corpusStats: InvertedIndexCorpusStats,
});

export type LoadedInvertedIndex = Loaded<
  typeof InvertedIndexData,
  {
    docMeta: { $each: true };
    postings: { $each: { postings: { $each: true } } };
    corpusStats: true;
  }
>;

export const calculateTermMeta = (terms: string[]) => {
  const res = {} as Record<string, { frequency: number; positions: number[] }>;

  for (const [i, term] of terms.entries()) {
    if (!res[term]) {
      res[term] = { frequency: 0, positions: [] };
    }
    res[term].frequency++;
    res[term].positions.push(i);
  }

  return res;
};

const calculateDocMeta = (terms: string[]) => {
  const uniqueTerms = [...new Set(terms)];
  return {
    hash: h64ToString(terms.join("\0")),
    termCount: terms.length,
    uniqueTerms: uniqueTerms,
  };
};

const writeTermDocPosting =
  (index: LoadedInvertedIndex) =>
  (docId: string) =>
  ({
    term,
    termMeta,
  }: {
    term: string;
    termMeta: {
      frequency: number;
      positions: number[];
    };
  }) => {
    let termEntry = index.postings[term];
    if (!termEntry) {
      const postings = InvertedIndexPostingData.create(
        {},
        { owner: index.$jazz.owner },
      );
      termEntry = InvertedIndexTermMeta.create(
        { docCount: 0, postings },
        { owner: index.$jazz.owner },
      );
      index.postings.$jazz.set(term, termEntry);
    }

    const wasNew = !termEntry.postings[docId];
    termEntry.postings.$jazz.set(docId, termMeta);

    if (wasNew) {
      termEntry.$jazz.set("docCount", termEntry.docCount + 1);
    }
  };

export const addToInvertedIndex =
  (index: LoadedInvertedIndex) => (doc: Doc) => {
    const docMeta = calculateDocMeta(doc.terms);
    index.docMeta.$jazz.set(doc.id, docMeta);

    // Update corpus statistics
    index.corpusStats.$jazz.set(
      "totalDocuments",
      index.corpusStats.totalDocuments + 1,
    );
    index.corpusStats.$jazz.set(
      "totalTermCount",
      index.corpusStats.totalTermCount + doc.terms.length,
    );

    const meta = calculateTermMeta(doc.terms);
    const writer = writeTermDocPosting(index)(doc.id);
    for (const [term, termMeta] of Object.entries(meta)) {
      writer({ term, termMeta });
    }
  };

export const removeFromInvertedIndex =
  (index: LoadedInvertedIndex) => (docId: string) => {
    const docMeta = index.docMeta[docId];
    if (!docMeta) {
      return;
    }

    // Update corpus statistics
    index.corpusStats.$jazz.set(
      "totalDocuments",
      Math.max(0, index.corpusStats.totalDocuments - 1),
    );
    index.corpusStats.$jazz.set(
      "totalTermCount",
      Math.max(0, index.corpusStats.totalTermCount - docMeta.termCount),
    );

    for (const term of docMeta.uniqueTerms) {
      const termEntry = index.postings[term];
      if (termEntry && termEntry.postings[docId]) {
        termEntry.postings.$jazz.delete(docId);
        termEntry.$jazz.set("docCount", termEntry.docCount - 1);
      }
    }
    index.docMeta.$jazz.delete(docId);
  };

export const upsertToInvertedIndex =
  (index: LoadedInvertedIndex) => (doc: Doc) => {
    const oldDoc = index.docMeta[doc.id];
    if (!oldDoc) {
      addToInvertedIndex(index)(doc);
      return;
    }
    const docMeta = calculateDocMeta(doc.terms);
    if (docMeta.hash === oldDoc.hash) {
      return;
    }

    // Update corpus statistics - adjust term count difference
    const termCountDifference = doc.terms.length - oldDoc.termCount;
    index.corpusStats.$jazz.set(
      "totalTermCount",
      index.corpusStats.totalTermCount + termCountDifference,
    );

    const termsToRemove = oldDoc.uniqueTerms.filter(
      (term) => !docMeta.uniqueTerms.includes(term),
    );

    for (const termToRemove of termsToRemove) {
      const termEntry = index.postings[termToRemove];
      if (termEntry && termEntry.postings[doc.id]) {
        termEntry.postings.$jazz.delete(doc.id);
        termEntry.$jazz.set("docCount", termEntry.docCount - 1);
      }
    }

    index.docMeta.$jazz.set(doc.id, docMeta);
    const meta = calculateTermMeta(doc.terms);
    const writer = writeTermDocPosting(index)(doc.id);
    for (const [term, termMeta] of Object.entries(meta)) {
      writer({ term, termMeta });
    }
  };

export const createInvertedIndex = (owner: Group) => {
  const corpusStats = InvertedIndexCorpusStats.create(
    {
      totalDocuments: 0,
      totalTermCount: 0,
    },
    { owner },
  );

  return InvertedIndexData.create(
    {
      postings: {},
      docMeta: {},
      corpusStats,
    },
    { owner },
  );
};

export const loadInvertedIndex = async (id: string, loadAs?: Account) => {
  const index = await InvertedIndexData.load(id, {
    resolve: {
      docMeta: { $each: true },
      postings: { $each: { postings: { $each: true } } },
      corpusStats: true,
    },
    loadAs,
  });
  if (!index.$isLoaded) {
    throw new Error(`Inverted index ${id} not found`);
  }
  return index;
};
