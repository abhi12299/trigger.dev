import type { WorkflowRun, WorkflowRunStep } from ".prisma/client";
import type {
  CustomEventSchema,
  ErrorSchema,
  LogMessageSchema,
} from "@trigger.dev/common-schemas";
import { ulid } from "ulid";
import type { z } from "zod";
import { prisma } from "~/db.server";
import { IngestEvent } from "~/services/events/ingest.server";
import { createStepOnce } from "./workflowRunStep.server";

type WorkflowRunStatus = WorkflowRun["status"];
export type { WorkflowRun, WorkflowRunStep, WorkflowRunStatus };

export async function findWorklowRunById(id: string) {
  return prisma.workflowRun.findUnique({
    where: { id },
    include: {
      event: true,
      environment: true,
    },
  });
}

export async function startWorkflowRun(id: string, apiKey: string) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  if (
    workflowRun.status !== "PENDING" &&
    workflowRun.status !== "INTERRUPTED"
  ) {
    return;
  }

  if (workflowRun.status === "INTERRUPTED") {
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: "RUNNING",
        attemptCount: { increment: 1 },
      },
    });
  } else {
    await prisma.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });
  }
}

export async function failWorkflowRun(
  id: string,
  error: z.infer<typeof ErrorSchema>,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(id, apiKey);

  if (workflowRun.status !== "RUNNING") {
    return;
  }

  await prisma.workflowRun.update({
    where: { id: workflowRun.id },
    data: {
      status: "ERROR",
      error,
      finishedAt: new Date(),
    },
  });
}

export async function completeWorkflowRun(
  output: string,
  runId: string,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(runId, apiKey);

  if (workflowRun.status !== "RUNNING") {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.workflowRun.update({
      where: { id: workflowRun.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
      },
    });

    await tx.workflowRunStep.upsert({
      where: {
        runId_idempotencyKey: {
          runId,
          idempotencyKey: "output",
        },
      },
      create: {
        runId,
        idempotencyKey: "output",
        type: "OUTPUT",
        output: JSON.parse(output),
        context: {},
        startedAt: new Date(),
        finishedAt: new Date(),
      },
      update: {},
    });
  });
}

export async function triggerEventInRun(
  key: string,
  event: z.infer<typeof CustomEventSchema>,
  runId: string,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(runId, apiKey);

  const step = await createStepOnce(runId, key, {
    type: "CUSTOM_EVENT",
    input: event,
    context: {},
    startedAt: new Date(),
    finishedAt: new Date(),
  });

  if (step.status === "EXISTING") {
    return;
  }

  const ingestService = new IngestEvent();

  await ingestService.call(
    {
      id: ulid(),
      name: event.name,
      type: "CUSTOM_EVENT",
      service: "trigger",
      payload: event.payload,
      context: event.context,
      apiKey: workflowRun.environment.apiKey,
    },
    workflowRun.environment.organization
  );
}

export async function logMessageInRun(
  key: string,
  log: z.infer<typeof LogMessageSchema>,
  runId: string,
  apiKey: string
) {
  const workflowRun = await findWorkflowRunScopedToApiKey(runId, apiKey);

  return createStepOnce(workflowRun.id, key, {
    type: "LOG_MESSAGE",
    input: log,
    context: {},
    status: "SUCCESS",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
}

async function findWorkflowRunScopedToApiKey(id: string, apiKey: string) {
  const workflowRun = await prisma.workflowRun.findFirst({
    where: { id },
    include: {
      environment: {
        include: { organization: true },
      },
    },
  });

  if (!workflowRun || workflowRun.environment.apiKey !== apiKey) {
    throw new Error("Invalid workflow run");
  }

  return workflowRun;
}

export async function getMostRecentWorkflowRun({
  workflowSlug,
}: {
  workflowSlug: string;
}) {
  return prisma.workflowRun.findFirst({
    where: {
      workflow: {
        slug: workflowSlug,
      },
    },
    include: {
      event: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}
