import { co, z } from "jazz-tools";
import type { Loaded } from "jazz-tools";
import xxhash from "xxhash-wasm";

const { h64ToString } = await xxhash();

export type Doc = {
  id: string;
  terms: string[];
};

const InvertedIndexMeta = co.record(
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

export const InvertedIndexData = co.map({
  meta: InvertedIndexMeta,
  postings: co.record(
    // Term
    z.string(),
    InvertedIndexPostingData,
  ),
});

export type LoadedInvertedIndex = Loaded<
  typeof InvertedIndexData,
  { meta: { $each: true }; postings: { $each: true } }
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
    let termPosting = index.postings[term];
    if (!termPosting) {
      termPosting = InvertedIndexPostingData.create(
        {},
        { owner: index.$jazz.owner },
      );
      index.postings.$jazz.set(term, termPosting);
    }
    termPosting.$jazz.set(docId, termMeta);
  };

export const addToInvertedIndex =
  (index: LoadedInvertedIndex) => (doc: Doc) => {
    index.meta.$jazz.set(doc.id, calculateDocMeta(doc.terms));
    const meta = calculateTermMeta(doc.terms);
    const writer = writeTermDocPosting(index)(doc.id);
    for (const [term, termMeta] of Object.entries(meta)) {
      writer({ term, termMeta });
    }
  };

export const removeFromInvertedIndex =
  (index: LoadedInvertedIndex) => (docId: string) => {
    const docMeta = index.meta[docId];
    if (!docMeta) {
      return;
    }

    for (const term of docMeta.uniqueTerms) {
      const posting = index.postings[term];
      if (posting) {
        posting.$jazz.delete(docId);
      }
    }
    index.meta.$jazz.delete(docId);
  };

export const upsertToInvertedIndex =
  (index: LoadedInvertedIndex) => (doc: Doc) => {
    const oldDoc = index.meta[doc.id];
    if (!oldDoc) {
      addToInvertedIndex(index)(doc);
      return;
    }
    const docMeta = calculateDocMeta(doc.terms);
    if (docMeta.hash === oldDoc.hash) {
      return;
    }

    const termsToRemove = oldDoc.uniqueTerms.filter(
      (term) => !docMeta.uniqueTerms.includes(term),
    );

    for (const termToRemove of termsToRemove) {
      const posting = index.postings[termToRemove];
      if (posting) {
        posting.$jazz.delete(doc.id);
      }
    }

    index.meta.$jazz.set(doc.id, docMeta);
    const meta = calculateTermMeta(doc.terms);
    const writer = writeTermDocPosting(index)(doc.id);
    for (const [term, termMeta] of Object.entries(meta)) {
      writer({ term, termMeta });
    }
  };
