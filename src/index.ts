import "dotenv/config";
import { cleanEnv, str } from "envalid";
import { startWorker } from "jazz-tools/worker";

import { queries as queries2, data as data2 } from "./data2.ts";
import { queries as queries1, data as data1 } from "./data.ts";
import { InvertedIndexData } from "./inverted-index.ts";
import { JazzFuzzyIndex } from "./fuzzy-index.ts";

const env = cleanEnv(process.env, {
  JAZZ_API_KEY: str(),
  JAZZ_WORKER_ACCOUNT: str(),
  JAZZ_WORKER_SECRET: str(),
});

const { worker, shutdownWorker } = await startWorker({
  syncServer: `wss://cloud.jazz.tools/?key=${env.JAZZ_API_KEY}`,
  accountID: env.JAZZ_WORKER_ACCOUNT,
  accountSecret: env.JAZZ_WORKER_SECRET,
  asActiveAccount: false,
});

const datasets = [
  { indexId: "co_zZ5jeWg9CKFHxuRmu8jcWSqVWrJ", queries: queries1, data: data1 },
  { indexId: "co_znokVBDCP1xwiaT4dkXwGJnNNVF", queries: queries2, data: data2 },
];

const runData = datasets[0];
if (!runData) {
  throw new Error("No run data provided");
}

console.log("Loading index...");

const index = await InvertedIndexData.load(runData.indexId, {
  resolve: {
    meta: {
      $each: true,
    },
    postings: {
      $each: {
        $each: true,
      },
    },
  },
  loadAs: worker,
});

if (!index.$isLoaded) {
  throw new Error("Index not loaded");
}

console.log("Index loaded");

const fuzzyIndex = new JazzFuzzyIndex(index);

const queries = runData.queries;
const data = runData.data;

// Evaluation metrics interface
interface QueryEvaluation {
  query: string;
  expected: string[];
  actual: string[];
  precision: number;
  recall: number;
  f1: number;
  topKAccuracy: number;
  exactMatch: boolean;
  timings: {
    ngramCreation: number;
    ngramMeta: number;
    ngramSorting: number;
    candidateExpansion: number;
    qualityComputation: number;
    sorting: number;
    total: number;
  };
  candidateSize: number;
}

// Evaluate all queries with performance tracking
const evaluations: QueryEvaluation[] = [];
const topK = 5; // Number of results to consider

console.log("🔍 Fuzzy Search Evaluation Results");
console.log("=".repeat(60));

for (const query of queries) {
  const response = fuzzyIndex.query(query.query, 0.01);
  const actualIds = response.results.slice(0, topK).map((r) => r.id);
  const expectedIds = query.expectedMatches as unknown as string[];

  // Calculate metrics
  const relevantRetrieved = actualIds.filter((id) => expectedIds.includes(id));
  const precision =
    actualIds.length > 0 ? relevantRetrieved.length / actualIds.length : 0;
  const recall =
    expectedIds.length > 0 ? relevantRetrieved.length / expectedIds.length : 0;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;
  const topKAccuracy =
    actualIds.length > 0 && actualIds[0] && expectedIds.includes(actualIds[0])
      ? 1
      : 0;
  const exactMatch =
    actualIds.length === expectedIds.length &&
    expectedIds.every((id) => actualIds.includes(id)) &&
    actualIds.every((id) => expectedIds.includes(id));

  const evaluation: QueryEvaluation = {
    query: query.query,
    expected: expectedIds,
    actual: actualIds,
    precision,
    recall,
    f1,
    topKAccuracy,
    exactMatch,
    timings: response.meta.timings,
    candidateSize: response.meta.candidateSize,
  };

  evaluations.push(evaluation);

  // Display individual query results
  const status = f1 > 0.8 ? "✅" : f1 > 0.5 ? "⚠️" : "❌";
  console.log(
    `\n${status} Query: "${query.query}" (${response.meta.timings.total.toFixed(2)}ms)`,
  );
  console.log(`   Expected: [${expectedIds.join(", ")}]`);
  console.log(`   Got:      [${actualIds.join(", ")}]`);
  console.log(
    `   Metrics:  P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1.toFixed(2)} Top-1=${topKAccuracy ? "✓" : "✗"}`,
  );
  console.log(
    `   Timing:   NC=${response.meta.timings.ngramCreation.toFixed(1)}ms NM=${response.meta.timings.ngramMeta.toFixed(1)}ms NS=${response.meta.timings.ngramSorting.toFixed(1)}ms C=${response.meta.timings.candidateExpansion.toFixed(1)}ms Q=${response.meta.timings.qualityComputation.toFixed(1)}ms S=${response.meta.timings.sorting.toFixed(1)}ms`,
  );
  console.log(`   Candidates: ${response.meta.candidateSize}`);

  if (f1 < 0.5) {
    console.log(
      `   📝 Results: ${response.results
        .slice(0, 3)
        .map(
          (r) => `"${data.find((d) => d.id === r.id)?.text.slice(0, 50)}..."`,
        )
        .join(" | ")}`,
    );
  }
}

// Query performance summary
const totalTimes = evaluations.map((e) => e.timings.total);
const ngramCreationTimes = evaluations.map((e) => e.timings.ngramCreation);
const ngramMetaTimes = evaluations.map((e) => e.timings.ngramMeta);
const ngramSortingTimes = evaluations.map((e) => e.timings.ngramSorting);
const candidateTimes = evaluations.map((e) => e.timings.candidateExpansion);
const qualityTimes = evaluations.map((e) => e.timings.qualityComputation);
const sortTimes = evaluations.map((e) => e.timings.sorting);
const candidateSizes = evaluations.map((e) => e.candidateSize);

const avgTotalTime =
  totalTimes.reduce((sum, time) => sum + time, 0) / totalTimes.length;
const avgNgramCreationTime =
  ngramCreationTimes.reduce((sum, time) => sum + time, 0) /
  ngramCreationTimes.length;
const avgNgramMetaTime =
  ngramMetaTimes.reduce((sum, time) => sum + time, 0) / ngramMetaTimes.length;
const avgNgramSortingTime =
  ngramSortingTimes.reduce((sum, time) => sum + time, 0) /
  ngramSortingTimes.length;
const avgCandidateTime =
  candidateTimes.reduce((sum, time) => sum + time, 0) / candidateTimes.length;
const avgQualityTime =
  qualityTimes.reduce((sum, time) => sum + time, 0) / qualityTimes.length;
const avgSortTime =
  sortTimes.reduce((sum, time) => sum + time, 0) / sortTimes.length;
const avgCandidateSize =
  candidateSizes.reduce((sum, size) => sum + size, 0) / candidateSizes.length;

const minTotalTime = Math.min(...totalTimes);
const maxTotalTime = Math.max(...totalTimes);
const totalQueryTime = totalTimes.reduce((sum, time) => sum + time, 0);

console.log("\n" + "=".repeat(60));
console.log("⚡ Query Performance Summary");
console.log("=".repeat(60));
console.log(`Total queries:     ${queries.length}`);
console.log(`Total time:        ${totalQueryTime.toFixed(2)}ms`);
console.log(`Average time:      ${avgTotalTime.toFixed(2)}ms per query`);
console.log(`Min time:          ${minTotalTime.toFixed(2)}ms`);
console.log(`Max time:          ${maxTotalTime.toFixed(2)}ms`);
console.log(
  `Throughput:        ${(queries.length / (totalQueryTime / 1000)).toFixed(2)} queries/sec`,
);

console.log("\n📊 Detailed Timing Breakdown");
const avgTotalNgramTime =
  avgNgramCreationTime + avgNgramMetaTime + avgNgramSortingTime;
console.log(
  `Total ngram time:  ${avgTotalNgramTime.toFixed(2)}ms (${((avgTotalNgramTime / avgTotalTime) * 100).toFixed(1)}%)`,
);
console.log(
  `  - Creation:      ${avgNgramCreationTime.toFixed(2)}ms (${((avgNgramCreationTime / avgTotalTime) * 100).toFixed(1)}%)`,
);
console.log(
  `  - Meta calc:     ${avgNgramMetaTime.toFixed(2)}ms (${((avgNgramMetaTime / avgTotalTime) * 100).toFixed(1)}%)`,
);
console.log(
  `  - Sorting:       ${avgNgramSortingTime.toFixed(2)}ms (${((avgNgramSortingTime / avgTotalTime) * 100).toFixed(1)}%)`,
);
console.log(
  `Candidate expansion: ${avgCandidateTime.toFixed(2)}ms (${((avgCandidateTime / avgTotalTime) * 100).toFixed(1)}%)`,
);
console.log(
  `Quality computation: ${avgQualityTime.toFixed(2)}ms (${((avgQualityTime / avgTotalTime) * 100).toFixed(1)}%)`,
);
console.log(
  `Result sorting:    ${avgSortTime.toFixed(2)}ms (${((avgSortTime / avgTotalTime) * 100).toFixed(1)}%)`,
);
console.log(`Avg candidate size: ${avgCandidateSize.toFixed(0)} documents`);

// Calculate percentiles for timing analysis
const calculatePercentile = (arr: number[], percentile: number): number => {
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[index] || 0;
};

console.log("\n📈 Timing Distribution Analysis");
const p50Total = calculatePercentile(totalTimes, 50);
const p95Total = calculatePercentile(totalTimes, 95);
const p99Total = calculatePercentile(totalTimes, 99);

console.log(`Total time P50:    ${p50Total.toFixed(2)}ms`);
console.log(`Total time P95:    ${p95Total.toFixed(2)}ms`);
console.log(`Total time P99:    ${p99Total.toFixed(2)}ms`);

// Find bottlenecks
const slowestQueries = evaluations
  .sort((a, b) => b.timings.total - a.timings.total)
  .slice(0, 3);

console.log("\n🐌 Slowest Queries:");
slowestQueries.forEach((e, i) => {
  console.log(`  ${i + 1}. "${e.query}" (${e.timings.total.toFixed(2)}ms)`);
  console.log(
    `     NC:${e.timings.ngramCreation.toFixed(1)}ms NM:${e.timings.ngramMeta.toFixed(1)}ms NS:${e.timings.ngramSorting.toFixed(1)}ms C:${e.timings.candidateExpansion.toFixed(1)}ms Q:${e.timings.qualityComputation.toFixed(1)}ms S:${e.timings.sorting.toFixed(1)}ms`,
  );
  console.log(`     Candidates: ${e.candidateSize}`);
});

// Candidate size distribution
const minCandidateSize = Math.min(...candidateSizes);
const maxCandidateSize = Math.max(...candidateSizes);
const p50CandidateSize = calculatePercentile(candidateSizes, 50);
const p95CandidateSize = calculatePercentile(candidateSizes, 95);

console.log("\n📊 Candidate Size Distribution:");
console.log(`Min candidates:    ${minCandidateSize}`);
console.log(`P50 candidates:    ${p50CandidateSize}`);
console.log(`P95 candidates:    ${p95CandidateSize}`);
console.log(`Max candidates:    ${maxCandidateSize}`);

// Summary statistics
console.log("\n" + "=".repeat(60));
console.log("📊 Overall Performance Summary");
console.log("=".repeat(60));

const avgPrecision =
  evaluations.reduce((sum, e) => sum + e.precision, 0) / evaluations.length;
const avgRecall =
  evaluations.reduce((sum, e) => sum + e.recall, 0) / evaluations.length;
const avgF1 =
  evaluations.reduce((sum, e) => sum + e.f1, 0) / evaluations.length;
const avgTopKAccuracy =
  evaluations.reduce((sum, e) => sum + e.topKAccuracy, 0) / evaluations.length;
const exactMatches = evaluations.filter((e) => e.exactMatch).length;
const perfectQueries = evaluations.filter((e) => e.f1 === 1.0).length;
const goodQueries = evaluations.filter((e) => e.f1 > 0.8).length;
const poorQueries = evaluations.filter((e) => e.f1 < 0.5).length;

console.log(`Total Queries:     ${evaluations.length}`);
console.log(
  `Perfect Matches:   ${perfectQueries} (${((perfectQueries / evaluations.length) * 100).toFixed(1)}%)`,
);
console.log(
  `Good Performance:  ${goodQueries} (${((goodQueries / evaluations.length) * 100).toFixed(1)}%)`,
);
console.log(
  `Poor Performance:  ${poorQueries} (${((poorQueries / evaluations.length) * 100).toFixed(1)}%)`,
);
console.log(
  `Exact Matches:     ${exactMatches} (${((exactMatches / evaluations.length) * 100).toFixed(1)}%)`,
);
console.log("");
console.log(`Average Precision: ${avgPrecision.toFixed(3)}`);
console.log(`Average Recall:    ${avgRecall.toFixed(3)}`);
console.log(`Average F1 Score:  ${avgF1.toFixed(3)}`);
console.log(
  `Top-1 Accuracy:    ${avgTopKAccuracy.toFixed(3)} (${(avgTopKAccuracy * 100).toFixed(1)}%)`,
);

// Show worst performing queries
const worstQueries = evaluations
  .filter((e) => e.f1 < 0.8)
  .sort((a, b) => a.f1 - b.f1)
  .slice(0, 5);

if (worstQueries.length > 0) {
  console.log("\n🔍 Queries needing improvement:");
  worstQueries.forEach((e) => {
    console.log(`   "${e.query}" (F1: ${e.f1.toFixed(2)})`);
  });
}

console.log("\n" + "=".repeat(60));

shutdownWorker();
