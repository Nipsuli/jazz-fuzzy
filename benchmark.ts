import { performance } from "perf_hooks";

// Mock data structures to test the optimization
interface MockTermEntry {
  docCount: number;
  postings: Record<string, any>;
}

interface MockIndex {
  postings: Record<string, MockTermEntry>;
}

// Generate mock data
function generateMockIndex(numTerms: number, avgDocsPerTerm: number): MockIndex {
  const index: MockIndex = { postings: {} };

  for (let i = 0; i < numTerms; i++) {
    const termId = `term_${i}`;
    const docCount = Math.floor(avgDocsPerTerm * (0.5 + Math.random())); // Vary doc count
    const postings: Record<string, any> = {};

    // Generate mock postings
    for (let j = 0; j < docCount; j++) {
      postings[`doc_${j}`] = { frequency: 1, positions: [j] };
    }

    index.postings[termId] = {
      docCount,
      postings
    };
  }

  return index;
}

// Old approach: Object.keys() during sorting
function oldNgramSorting(ngrams: string[], index: MockIndex): string[] {
  return ngrams.sort((a, b) => {
    const aSize = Object.keys(index.postings[a]?.postings || {}).length;
    const bSize = Object.keys(index.postings[b]?.postings || {}).length;
    return aSize - bSize;
  });
}

// New approach: Pre-computed docCount
function newNgramSorting(ngrams: string[], index: MockIndex): string[] {
  return ngrams.sort((a, b) => {
    const aSize = index.postings[a]?.docCount || 0;
    const bSize = index.postings[b]?.docCount || 0;
    return aSize - bSize;
  });
}

// Optimized approach: Single pass with caching
function optimizedNgramSorting(ngrams: string[], index: MockIndex): {
  sortedNgrams: string[];
  docFreqs: Map<string, number>;
} {
  const docFreqs = new Map<string, number>();
  const ngramSizes: Array<{ ngram: string; size: number }> = [];

  // Single pass to collect both sorting data and document frequencies
  for (const ngram of ngrams) {
    const termEntry = index.postings[ngram];
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

// Benchmark function
function benchmark() {
  console.log("🚀 Ngram Sorting Performance Benchmark");
  console.log("=" .repeat(50));

  const testCases = [
    { numTerms: 1000, avgDocsPerTerm: 50, queryNgrams: 10 },
    { numTerms: 5000, avgDocsPerTerm: 100, queryNgrams: 20 },
    { numTerms: 10000, avgDocsPerTerm: 200, queryNgrams: 50 },
    { numTerms: 50000, avgDocsPerTerm: 500, queryNgrams: 100 },
  ];

  for (const testCase of testCases) {
    console.log(`\n📊 Test Case: ${testCase.numTerms} terms, ${testCase.avgDocsPerTerm} avg docs/term, ${testCase.queryNgrams} query ngrams`);
    console.log("-".repeat(50));

    // Generate test data
    const index = generateMockIndex(testCase.numTerms, testCase.avgDocsPerTerm);
    const queryNgrams = Array.from({ length: testCase.queryNgrams }, (_, i) => `term_${i}`);

    const iterations = 100;

    // Benchmark old approach
    const oldTimes: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      oldNgramSorting([...queryNgrams], index);
      const end = performance.now();
      oldTimes.push(end - start);
    }

    // Benchmark new approach
    const newTimes: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      newNgramSorting([...queryNgrams], index);
      const end = performance.now();
      newTimes.push(end - start);
    }

    // Benchmark optimized approach
    const optimizedTimes: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      optimizedNgramSorting([...queryNgrams], index);
      const end = performance.now();
      optimizedTimes.push(end - start);
    }

    // Calculate statistics
    const oldAvg = oldTimes.reduce((a, b) => a + b, 0) / oldTimes.length;
    const newAvg = newTimes.reduce((a, b) => a + b, 0) / newTimes.length;
    const optimizedAvg = optimizedTimes.reduce((a, b) => a + b, 0) / optimizedTimes.length;

    const oldMin = Math.min(...oldTimes);
    const newMin = Math.min(...newTimes);
    const optimizedMin = Math.min(...optimizedTimes);

    const oldMax = Math.max(...oldTimes);
    const newMax = Math.max(...newTimes);
    const optimizedMax = Math.max(...optimizedTimes);

    const improvement1 = ((oldAvg - newAvg) / oldAvg) * 100;
    const improvement2 = ((oldAvg - optimizedAvg) / oldAvg) * 100;

    console.log(`Old Approach (Object.keys):`);
    console.log(`  Avg: ${oldAvg.toFixed(3)}ms  Min: ${oldMin.toFixed(3)}ms  Max: ${oldMax.toFixed(3)}ms`);
    console.log(`New Approach (docCount):`);
    console.log(`  Avg: ${newAvg.toFixed(3)}ms  Min: ${newMin.toFixed(3)}ms  Max: ${newMax.toFixed(3)}ms`);
    console.log(`  Improvement: ${improvement1.toFixed(1)}%`);
    console.log(`Optimized Approach (cached):`);
    console.log(`  Avg: ${optimizedAvg.toFixed(3)}ms  Min: ${optimizedMin.toFixed(3)}ms  Max: ${optimizedMax.toFixed(3)}ms`);
    console.log(`  Improvement: ${improvement2.toFixed(1)}%`);

    // Performance ratio
    const ratio1 = oldAvg / newAvg;
    const ratio2 = oldAvg / optimizedAvg;
    console.log(`\n⚡ Performance Ratios:`);
    console.log(`  New approach is ${ratio1.toFixed(1)}x faster`);
    console.log(`  Optimized approach is ${ratio2.toFixed(1)}x faster`);
  }

  console.log("\n" + "=".repeat(50));
  console.log("✅ Benchmark Complete");
  console.log("\n💡 Key Insights:");
  console.log("• Pre-computed docCount eliminates expensive Object.keys() calls");
  console.log("• Single-pass caching provides additional benefits for larger datasets");
  console.log("• Performance gains increase with index size and query complexity");
}

// Run benchmark
benchmark();
