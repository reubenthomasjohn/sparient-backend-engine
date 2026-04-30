import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { makeInstitution } from '../../fixtures';
import { CanvasSourceClient } from '../../../src/services/sources/canvas/CanvasSourceClient';
import { CanvasClient } from '../../../src/services/sources/canvas/CanvasClient';
import type { CanvasCourse, CanvasTerm } from '../../../src/types/canvas';

// We mock the constructor so the client can stub at the CanvasClient seam.
// This lets us drive (term, course) shapes directly into getCourses without
// touching axios.
vi.mock('../../../src/services/sources/canvas/CanvasClient');

let mockedClient: DeepMockProxy<CanvasClient>;

beforeEach(() => {
  mockedClient = mockDeep<CanvasClient>();
  vi.mocked(CanvasClient).mockImplementation(() => mockedClient as unknown as CanvasClient);
  // accountId is a property accessed by getCourses' logger call.
  Object.defineProperty(mockedClient, 'accountId', { value: '1', configurable: true });
});

function term(overrides: Partial<CanvasTerm> = {}): CanvasTerm {
  return {
    id: 1,
    name: 'Term',
    start_at: null,
    end_at: null,
    workflow_state: 'active',
    ...overrides,
  };
}

function course(termId: number, overrides: Partial<CanvasCourse> = {}): CanvasCourse {
  return {
    id: 100 + termId,
    name: `Course in term ${termId}`,
    course_code: `C-${termId}`,
    enrollment_term_id: termId,
    workflow_state: 'available',
    ...overrides,
  };
}

async function runWith(opts: { terms: CanvasTerm[]; courses: CanvasCourse[] }) {
  mockedClient.getPaginated.mockResolvedValue(opts.courses);
  mockedClient.getTerms.mockResolvedValue(opts.terms);
  const client = new CanvasSourceClient(makeInstitution());
  return client.getCourses();
}

describe('CanvasSourceClient.getCourses — term filter', () => {
  // Use a fixed "now" via fake timers so date comparisons are deterministic.
  const NOW = new Date('2026-04-29T12:00:00Z');
  const PAST = new Date('2026-01-01T00:00:00Z');
  const FUTURE = new Date('2026-12-31T00:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('treats both-NULL term as always-active (Canvas Default Term)', async () => {
    // Canvas's "Default Term" canonically has both start_at and end_at = null.
    // Per Canvas source: enrollment_term has no presence validation on these,
    // so this is the always-active fallback.
    const result = await runWith({
      terms: [term({ id: 1, start_at: null, end_at: null })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('treats start_at=NULL with future end_at as active (no defined start)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: null, end_at: FUTURE.toISOString() })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('treats end_at=NULL with past start_at as active (open-ended ongoing term)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: PAST.toISOString(), end_at: null })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('treats start_at=NULL with past end_at as INACTIVE (term ended)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: null, end_at: PAST.toISOString() })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(0);
  });

  it('treats end_at=NULL with future start_at as INACTIVE (term not yet started)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: FUTURE.toISOString(), end_at: null })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(0);
  });

  it('excludes a course that points to a term not in the fetched list (orphan)', async () => {
    // Defensive: even though Canvas validates enrollment_term_id presence, a
    // term-id pointing to a deleted/unfetched term must not crash or sneak in.
    const result = await runWith({
      terms: [term({ id: 1, start_at: null, end_at: null })], // active
      courses: [course(999)], // points to nonexistent term
    });
    expect(result).toHaveLength(0);
  });

  it('keeps courses in active terms; drops courses in inactive terms (mixed)', async () => {
    const result = await runWith({
      terms: [
        term({ id: 1, start_at: null, end_at: null }), // default — active
        term({ id: 2, start_at: PAST.toISOString(), end_at: PAST.toISOString() }), // ended
        term({ id: 3, start_at: FUTURE.toISOString(), end_at: FUTURE.toISOString() }), // not started
      ],
      courses: [course(1), course(2), course(3)],
    });
    expect(result.map((c) => c.termId).sort()).toEqual(['1']);
  });

  it('treats start_at exactly equal to now as active (strict >)', async () => {
    // The current logic uses `>` not `>=`, so a term whose start is *exactly*
    // now is considered active. Lock this behaviour in.
    const result = await runWith({
      terms: [term({ id: 1, start_at: NOW.toISOString(), end_at: FUTURE.toISOString() })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('treats end_at exactly equal to now as active (strict <)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: PAST.toISOString(), end_at: NOW.toISOString() })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('requests both "available" and "unpublished" course states (excludes completed/deleted)', async () => {
    // Locks in product decision: unpublished courses are synced (teachers can
    // prep next semester's accessibility before publish); completed/deleted
    // courses are not (past terms have no remediation value).
    await runWith({ terms: [], courses: [] });
    expect(mockedClient.getPaginated).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        state: ['available', 'unpublished'],
        enrollment_type: 'teacher',
      }),
    );
  });
});
