import { Prisma } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(0).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('MIGRATION_TIMER');
  await migrateFileMetadata(req, res);
  console.timeEnd('MIGRATION_TIMER');
  res.status(200).json({ finished: true });
});

async function migrateFileMetadata(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          SELECT MIN(id), MAX(id)
          FROM "ModelFile"
          WHERE "createdAt" > ${params.after};
        `;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Image";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        UPDATE "ModelFile" SET "headerData" =
          CASE
            WHEN jsonb_typeof("headerData"->'__metadata__') = 'undefined' THEN null
            ELSE
              jsonb_set(
                ("headerData"->'__metadata__')::jsonb,
                '{ss_tag_frequency}',
                ("headerData"->'__metadata__'->>'ss_tag_frequency')::jsonb
              )
          END
        WHERE "headerData" IS NOT NULL
        AND id BETWEEN ${start} AND ${end};
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated ${start} - ${end}`);
    },
  });
}
