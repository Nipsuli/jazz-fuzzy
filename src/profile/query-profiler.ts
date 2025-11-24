import "dotenv/config";
import { performance } from "node:perf_hooks";
import { cleanEnv, str } from "envalid";
import { startWorker } from "jazz-tools/worker";

import { queries as queries1 } from "../data.ts";
import { queries as queries2 } from "../data2.ts";
import { JazzFuzzyIndex } from "../fuzzy-index.ts";
import type { QueryProfile } from "../fuzzy-index.ts";
import { loadInvertedIndex } from "../inverted-index.ts";

type Dataset = {
  name: string;
  indexId: string;
  queries: { query: string; expectedMatches: string[] }[];
};

const datasets: Dataset[] = [
  {
    name: "data1",
    indexId: "co_zFv8ZX35NZhdBidZ1zaDdmJFAjH",
    queries: queries1,
  },
  {
    name: "data2",
    indexId: "co_z5FcAqVoGBraAVjd1oExsxCiTSK",
    queries: queries2,
  },
];

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
};

const pickDataset = (): Dataset => {
  const envChoice = process.env.JAZZ_PROFILE_DATASET;
  if (!envChoice) return datasets[1]!;
  const chosen = datasets.find((d) => d.name === envChoice);
  if (!chosen) {
    throw new Error(
      `Unknown dataset "${envChoice}". Valid options: ${datasets
        .map((d) => d.name)
        .join(", ")}`,
    );
  }
  return chosen;
};

const run = async () => {
  const env = cleanEnv(process.env, {
    JAZZ_API_KEY: str(),
    JAZZ_WORKER_ACCOUNT: str(),
    JAZZ_WORKER_SECRET: str(),
  });

  const dataset = pickDataset();
  const iterations = Number(process.env.JAZZ_PROFILE_RUNS ?? "3");

  console.log(`Profiling dataset: ${dataset.name} (id: ${dataset.indexId})`);
  console.log(`Iterations: ${iterations}`);

  const { worker, shutdownWorker } = await startWorker({
    syncServer: `wss://cloud.jazz.tools/?key=${env.JAZZ_API_KEY}`,
    accountID: env.JAZZ_WORKER_ACCOUNT,
    accountSecret: env.JAZZ_WORKER_SECRET,
    asActiveAccount: false,
  });

  try {
    const index = await loadInvertedIndex(dataset.indexId, worker);
    const fuzzyIndex = new JazzFuzzyIndex(index);

    const profiles: QueryProfile[] = [];
    const wallTimes: number[] = [];

    for (let i = 0; i < iterations; i++) {
      for (const query of dataset.queries) {
        const wallStart = performance.now();
        fuzzyIndex.query(query.query, 0.01, (profile) => profiles.push(profile));
        wallTimes.push(performance.now() - wallStart);
      }
    }

    if (profiles.length === 0) {
      console.log("No profiles captured");
      return;
    }

    const average = (arr: number[]) =>
      arr.reduce((sum, n) => sum + n, 0) / arr.length;

    const totals = profiles.map((p) => p.timings.totalMs);
    const avgTimings = profiles.reduce(
      (acc, p) => {
        acc.total += p.timings.totalMs;
        acc.ngram += p.timings.ngramMs;
        acc.termStats += p.timings.termStatsMs;
        acc.candidates += p.timings.candidateAccumulationMs;
        acc.scoring += p.timings.scoringMs;
        acc.sort += p.timings.sortMs;
        return acc;
      },
      {
        total: 0,
        ngram: 0,
        termStats: 0,
        candidates: 0,
        scoring: 0,
        sort: 0,
      },
    );

    const avgCounts = profiles.reduce(
      (acc, p) => {
        acc.ngramCount += p.counts.ngramCount;
        acc.uniqueNgramCount += p.counts.uniqueNgramCount;
        acc.missingTerms += p.counts.missingTerms;
        acc.postingsVisited += p.counts.postingsVisited;
        acc.candidateDocs += p.counts.candidateDocs;
        acc.scoredDocs += p.counts.scoredDocs;
        acc.resultsReturned += p.counts.resultsReturned;
        return acc;
      },
      {
        ngramCount: 0,
        uniqueNgramCount: 0,
        missingTerms: 0,
        postingsVisited: 0,
        candidateDocs: 0,
        scoredDocs: 0,
        resultsReturned: 0,
      },
    );

    const averagedTimings = {
      total: avgTimings.total / profiles.length,
      ngram: avgTimings.ngram / profiles.length,
      termStats: avgTimings.termStats / profiles.length,
      candidates: avgTimings.candidates / profiles.length,
      scoring: avgTimings.scoring / profiles.length,
      sort: avgTimings.sort / profiles.length,
    };

    const averagedCounts = {
      ngramCount: avgCounts.ngramCount / profiles.length,
      uniqueNgramCount: avgCounts.uniqueNgramCount / profiles.length,
      missingTerms: avgCounts.missingTerms / profiles.length,
      postingsVisited: avgCounts.postingsVisited / profiles.length,
      candidateDocs: avgCounts.candidateDocs / profiles.length,
      scoredDocs: avgCounts.scoredDocs / profiles.length,
      resultsReturned: avgCounts.resultsReturned / profiles.length,
    };

    console.log("\n=== Query Wall Time Summary ===");
    console.log(`Runs:         ${profiles.length}`);
    console.log(`Avg wall ms:  ${average(wallTimes).toFixed(2)}`);
    console.log(`P50 wall ms:  ${percentile(wallTimes, 50).toFixed(2)}`);
    console.log(`P95 wall ms:  ${percentile(wallTimes, 95).toFixed(2)}`);
    console.log(`Max wall ms:  ${Math.max(...wallTimes).toFixed(2)}`);

    console.log("\n=== Average Phase Breakdown (ms) ===");
    console.log(
      `Total ${averagedTimings.total.toFixed(2)} | ngrams ${averagedTimings.ngram.toFixed(2)}, termStats ${averagedTimings.termStats.toFixed(2)}, candidates ${averagedTimings.candidates.toFixed(2)}, scoring ${averagedTimings.scoring.toFixed(2)}, sort ${averagedTimings.sort.toFixed(2)}`,
    );

    console.log("\n=== Average Counters ===");
    console.log(
      `ngrams ${averagedCounts.ngramCount.toFixed(1)}, unique ${averagedCounts.uniqueNgramCount.toFixed(1)}, missing ${averagedCounts.missingTerms.toFixed(1)}, postingsVisited ${averagedCounts.postingsVisited.toFixed(1)}, candidates ${averagedCounts.candidateDocs.toFixed(1)}, scored ${averagedCounts.scoredDocs.toFixed(1)}, results ${averagedCounts.resultsReturned.toFixed(1)}`,
    );

    const topSlow = [...profiles]
      .sort((a, b) => b.timings.totalMs - a.timings.totalMs)
      .slice(0, 5);

    console.log("\n=== Slowest Queries ===");
    topSlow.forEach((p, idx) => {
      console.log(
        `${idx + 1}. "${p.query}" -> ${p.timings.totalMs.toFixed(2)}ms (candidates ${p.counts.candidateDocs}, postings ${p.counts.postingsVisited})`,
      );
    });
  } finally {
    await shutdownWorker();
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
