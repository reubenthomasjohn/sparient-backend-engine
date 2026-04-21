import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import prisma from '../../db/client';
import { DiscoveryJob } from '../../queue';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const sfn = new SFNClient({ region: config.aws.region });

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleDiscoveryJob(job: DiscoveryJob): Promise<void> {
  if (job.type === 'tick') {
    return runTick();
  }
  return startInstitutionWorkflow(job.institutionId, job.force);
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
    await startInstitutionWorkflow(inst.id);
  }

  logger.info('Tick: institutions enqueued', { count: due.length });
}

// ---------------------------------------------------------------------------
// Start one SFN execution per institution. The SFN handles everything:
// discover-courses → Map(courses) → discover-files → Map(uploads) → batch
// ---------------------------------------------------------------------------

async function startInstitutionWorkflow(institutionId: string, force?: boolean): Promise<void> {
  await prisma.institution.findUniqueOrThrow({ where: { id: institutionId } });

  if (!config.aws.courseWorkflowArn) {
    logger.warn('Discovery: COURSE_WORKFLOW_ARN not set, skipping SFN start');
    return;
  }

  await sfn.send(new StartExecutionCommand({
    stateMachineArn: config.aws.courseWorkflowArn,
    name: `${institutionId}-${Date.now()}`,
    input: JSON.stringify({
      institutionId,
      force: force ?? false,
      singleCourseId: null, // null = all courses. SFN requires this key to exist.
    }),
  }));

  await prisma.institution.update({
    where: { id: institutionId },
    data: { lastSyncedAt: new Date() },
  });

  logger.info('Discovery: SFN execution started', { institutionId, force });
}
