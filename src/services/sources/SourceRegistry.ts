import { Institution, SourceType } from '@prisma/client';
import { ISourceClient } from './ISourceClient';
import { CanvasSourceClient } from './canvas/CanvasSourceClient';
import { AppError } from '../../utils/errors';

export class SourceRegistry {
  static getClient(institution: Institution): ISourceClient {
    switch (institution.sourceType) {
      case SourceType.canvas:
        return new CanvasSourceClient(institution);
      default:
        throw new AppError(
          `No client implemented for source type: ${institution.sourceType}`,
          500,
          'UNSUPPORTED_SOURCE_TYPE',
        );
    }
  }
}
