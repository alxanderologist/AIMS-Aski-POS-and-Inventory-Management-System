/**
 * Removes the FIRST-generation AMPC transactions (no branch tag in the
 * transactionNo) that were superseded by the multi-branch import.
 *
 * Old naming: AMPC-0-142991
 * New naming: AMPC-PRINTING-0-142991 / AMPC-COOP-0-142991 / etc.
 *
 * Anything matching the old pattern is now duplicated by a newer row and
 * inflates the forecast.
 */
require('dotenv').config();
const { prisma } = require('./models/Product');

async function main() {
  const legacy = await prisma.transaction.findMany({
    where: {
      AND: [
        { transactionNo: { startsWith: 'AMPC-' } },
        { NOT: { transactionNo: { startsWith: 'AMPC-PRINTING-' } } },
        { NOT: { transactionNo: { startsWith: 'AMPC-COOP-' } } },
        { NOT: { transactionNo: { startsWith: 'AMPC-JAZZEAT-' } } },
        { NOT: { transactionNo: { startsWith: 'AMPC-COKETAL-' } } },
        { NOT: { transactionNo: { startsWith: 'AMPC-BIGASAN-' } } },
        { NOT: { transactionNo: { startsWith: 'AMPC-WHT-' } } },
      ],
    },
    select: { id: true },
  });
  console.log('legacy AMPC rows to prune:', legacy.length);
  const chunkSize = 500;
  let done = 0;
  for (let i = 0; i < legacy.length; i += chunkSize) {
    const ids = legacy.slice(i, i + chunkSize).map((r) => r.id);
    const r = await prisma.transaction.deleteMany({ where: { id: { in: ids } } });
    done += r.count;
    console.log(`  pruned ${done}/${legacy.length}`);
  }
  console.log('legacy cleanup done');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
