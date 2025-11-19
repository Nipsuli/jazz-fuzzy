import "dotenv/config";
import { cleanEnv, str } from "envalid";
import { startWorker } from "jazz-tools/worker";

import { data as data2 } from "./data2.ts";
import { data as data1 } from "./data.ts";
import { Group } from "jazz-tools";
import { createInvertedIndex } from "./inverted-index.ts";
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
group.addMember("everyone", "reader");

const upsertData = async (
  data: {
    id: string;
    text: string;
  }[],
) => {
  const index = createInvertedIndex(group);

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

  console.log("⏳ Waiting for all co-values to be synced...");
  const syncStart = performance.now();
  await worker.$jazz.waitForAllCoValuesSync({ timeout: 20 * 60 * 1000 });
  console.log(
    `✅ All co-values synced in ${(performance.now() - syncStart).toFixed(2)}ms`,
  );

  console.log(`Id to use in queries: ${index.$jazz.id}`);
};

await upsertData(data1);
await upsertData(data2);

await shutdownWorker();

console.log("Bye!");
process.exit(0);
