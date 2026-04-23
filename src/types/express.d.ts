import type { Course, Institution } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** Set by Access Hub institution scope middleware (TASK-02). */
      accessHubInstitution?: Institution;
      /** Set by Access Hub course scope middleware after institution is resolved. */
      accessHubCourse?: Course;
      /**
       * Raw request body buffer captured by the express.json verify callback.
       * Required for HMAC-SHA256 body hashing in signed-auth middleware (TASK-12).
       */
      rawBody?: Buffer;
    }
  }
}

export {};
