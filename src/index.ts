import "dotenv/config";
import { cleanEnv, str } from "envalid";
import { startWorker } from "jazz-tools/worker";

import { data, queries } from "./data.ts";
import { Group } from "jazz-tools";
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
const group = Group.create({ owner: worker });

const index = InvertedIndexData.create(
  { postings: {}, meta: {} },
  { owner: group },
);

const fuzzyIndex = new JazzFuzzyIndex(index);

// Performance tracking for upserts
console.log("🚀 Starting upsert performance test...");
const upsertTimes: number[] = [];

for (const d of data) {
  const start = performance.now();
  fuzzyIndex.upsert(d);
  const end = performance.now();
  upsertTimes.push(end - start);
}

// Upsert performance summary
const avgUpsertTime =
  upsertTimes.reduce((sum, time) => sum + time, 0) / upsertTimes.length;
const minUpsertTime = Math.min(...upsertTimes);
const maxUpsertTime = Math.max(...upsertTimes);
const totalUpsertTime = upsertTimes.reduce((sum, time) => sum + time, 0);

console.log("📊 Upsert Performance Summary");
console.log("=".repeat(40));
console.log(`Total documents:   ${data.length}`);
console.log(`Total time:        ${totalUpsertTime.toFixed(2)}ms`);
console.log(`Average time:      ${avgUpsertTime.toFixed(2)}ms per doc`);
console.log(`Min time:          ${minUpsertTime.toFixed(2)}ms`);
console.log(`Max time:          ${maxUpsertTime.toFixed(2)}ms`);
console.log(
  `Throughput:        ${(data.length / (totalUpsertTime / 1000)).toFixed(2)} docs/sec`,
);
console.log("");

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
}

// Evaluate all queries with performance tracking
const evaluations: QueryEvaluation[] = [];
const queryTimes: number[] = [];
const topK = 5; // Number of results to consider

console.log("🔍 Fuzzy Search Evaluation Results");
console.log("=".repeat(60));

for (const query of queries) {
  const queryStart = performance.now();
  const res = fuzzyIndex.query(query.query, 0.05);
  const queryEnd = performance.now();
  const queryTime = queryEnd - queryStart;
  queryTimes.push(queryTime);
  const actualIds = res.slice(0, topK).map((r) => r.id);
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
  };

  evaluations.push(evaluation);

  // Display individual query results
  const status = f1 > 0.8 ? "✅" : f1 > 0.5 ? "⚠️" : "❌";
  console.log(
    `\n${status} Query: "${query.query}" (${queryTime.toFixed(2)}ms)`,
  );
  console.log(`   Expected: [${expectedIds.join(", ")}]`);
  console.log(`   Got:      [${actualIds.join(", ")}]`);
  console.log(
    `   Metrics:  P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1.toFixed(2)} Top-1=${topKAccuracy ? "✓" : "✗"}`,
  );

  if (f1 < 0.5) {
    console.log(
      `   📝 Results: ${res
        .slice(0, 3)
        .map(
          (r) => `"${data.find((d) => d.id === r.id)?.text.slice(0, 50)}..."`,
        )
        .join(" | ")}`,
    );
  }
}

// Query performance summary
const avgQueryTime =
  queryTimes.reduce((sum, time) => sum + time, 0) / queryTimes.length;
const minQueryTime = Math.min(...queryTimes);
const maxQueryTime = Math.max(...queryTimes);
const totalQueryTime = queryTimes.reduce((sum, time) => sum + time, 0);

console.log("\n" + "=".repeat(60));
console.log("⚡ Query Performance Summary");
console.log("=".repeat(60));
console.log(`Total queries:     ${queries.length}`);
console.log(`Total time:        ${totalQueryTime.toFixed(2)}ms`);
console.log(`Average time:      ${avgQueryTime.toFixed(2)}ms per query`);
console.log(`Min time:          ${minQueryTime.toFixed(2)}ms`);
console.log(`Max time:          ${maxQueryTime.toFixed(2)}ms`);
console.log(
  `Throughput:        ${(queries.length / (totalQueryTime / 1000)).toFixed(2)} queries/sec`,
);

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
