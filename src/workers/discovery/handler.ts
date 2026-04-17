import { Institution } from '@prisma/client';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import prisma from '../../db/client';
import { DiscoveryJob, discoveryQueue } from '../../queue';
import { SourceRegistry } from '../../services/sources/SourceRegistry';
import { ISourceClient } from '../../services/sources/ISourceClient';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const sfn = new SFNClient({ region: config.aws.region });

// ---------------------------------------------------------------------------
// Entry point — routes by message type.
// ---------------------------------------------------------------------------

export async function handleDiscoveryJob(job: DiscoveryJob): Promise<void> {
  if (job.type === 'tick') {
    return runTick();
  }
  return discoverInstitution(job.institutionId, job.force);
}

// ---------------------------------------------------------------------------
// Tick — every 15 min (EventBridge). Checks which institutions are due.
// ---------------------------------------------------------------------------

async function runTick(): Promise<void> {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const institutions = await prisma.institution.findMany({
    where: { syncEnabled: true },
  });

  const due = institutions.filter((inst) => {
    const [h, m] = inst.syncTime.split(':').map(Number);
    const scheduledMinutes = h * 60 + m;
    const diff = currentMinutes - scheduledMinutes;
    if (diff < 0 || diff >= 15) return false;
    if (inst.lastSyncedAt && inst.lastSyncedAt >= todayStart) return false;
    return true;
  });

  if (due.length === 0) {
    logger.info('Tick: no institutions due');
    return;
  }

  for (const inst of due) {
    await discoveryQueue.send({ type: 'discover', institutionId: inst.id });
  }

  logger.info('Tick: institutions enqueued', { count: due.length });
}

// ---------------------------------------------------------------------------
// Institution discover — list courses, start one Step Functions execution per course.
// ---------------------------------------------------------------------------

async function discoverInstitution(institutionId: string, force?: boolean): Promise<void> {
  const institution = await prisma.institution.findUniqueOrThrow({
    where: { id: institutionId },
  });
  const sourceClient = SourceRegistry.getClient(institution);

  const discoveredCourses = await upsertCoursesFromCanvas(institution, sourceClient);

  // Start one SFN execution per active course. Each execution runs:
  //   discover-files → Map(upload-file) → batch-publish
  for (const c of discoveredCourses) {
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: config.aws.courseWorkflowArn,
      name: `${institutionId}-${c.externalId}-${Date.now()}`,
      input: JSON.stringify({
        institutionId,
        canvasCourseId: c.externalId,
        force: force ?? false,
      }),
    }));
  }

  await prisma.institution.update({
    where: { id: institution.id },
    data: { lastSyncedAt: new Date() },
  });

  logger.info('Discovery: SFN executions started', {
    institutionId,
    courses: discoveredCourses.length,
  });
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function upsertCoursesFromCanvas(institution: Institution, sourceClient: ISourceClient) {
  const discovered = await sourceClient.getCourses();
  for (const dc of discovered) {
    await prisma.course.upsert({
      where: {
        institutionId_canvasCourseId: {
          institutionId: institution.id,
          canvasCourseId: dc.externalId,
        },
      },
      create: {
        institutionId: institution.id,
        canvasCourseId: dc.externalId,
        canvasTermId: dc.termId,
        name: dc.name,
        courseCode: dc.courseCode,
      },
      update: {
        name: dc.name,
        courseCode: dc.courseCode,
        canvasTermId: dc.termId,
      },
    });
  }
  return discovered;
}
