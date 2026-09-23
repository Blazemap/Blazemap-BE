import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import type { Actor } from '../../types/index.js';
import { publicationDto, publicationSelect } from '../admin/information.service.js';
import { reportCardDto, reportCardInclude } from './reports.service.js';
import { AppError } from '../../utils/index.js';

const feedQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(10).default(10) });

export async function listCitizenFeed(actor: Actor, query: unknown, client: PrismaClient = db()) {
  if (actor.role !== 'USER') throw new AppError('Citizen access required', 403, 'FORBIDDEN');
  const { page, pageSize } = feedQuerySchema.parse(query);
  const offset = (page - 1) * pageSize;
  const take = offset + pageSize;
  const now = new Date();
  const ownWhere: Prisma.TrReportWhereInput = { reporterId: actor.id };
  const publicationWhere: Prisma.TrPublicInformationWhereInput = {
    status: 'PUBLISHED',
    type: { not: 'WARNING' },
    caseId: { not: null },
    case: { is: { verificationStatus: 'CONFIRMED_FIRE' } },
    privacyReview: { not: null },
    publishedAt: { lte: now },
    AND: [
      { OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
      { publicCaseSnapshot: { path: ['verificationStatus'], equals: 'CONFIRMED_FIRE' } },
    ],
    NOT: [
      { report: { is: { reporterId: actor.id } } },
      { case: { is: { reports: { some: { reporterId: actor.id } } } } },
    ],
  };
  const [reports, reportTotal, publications, publicationTotal] = await client.$transaction([
    client.trReport.findMany({ where: ownWhere, include: reportCardInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take }),
    client.trReport.count({ where: ownWhere }),
    client.trPublicInformation.findMany({ where: publicationWhere, select: publicationSelect(now, true), orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take }),
    client.trPublicInformation.count({ where: publicationWhere }),
  ]);
  const merged = [
    ...reports.map(report => ({ kind: 'OWN_REPORT' as const, occurredAt: report.createdAt, ...reportCardDto(report) })),
    ...publications.map(publication => ({ kind: 'PUBLICATION' as const, occurredAt: publication.publishedAt!, ...publicationDto(publication) })),
  ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id));
  return { data: merged.slice(offset, offset + pageSize), meta: { total: reportTotal + publicationTotal, page, pageSize } };
}
