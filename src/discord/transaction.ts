export class PartialApplyError extends Error {
  constructor(
    message: string,
    readonly originalError: unknown,
    readonly rollbackFailures: number,
  ) {
    super(message);
    this.name = 'PartialApplyError';
  }
}

export async function applyWithRollback<T>(
  items: readonly T[],
  apply: (item: T) => Promise<void>,
  rollback: (item: T) => Promise<void>,
): Promise<void> {
  const attempted: T[] = [];
  try {
    for (const item of items) {
      attempted.push(item);
      await apply(item);
    }
  } catch (error) {
    let rollbackFailures = 0;
    for (const item of attempted.reverse()) {
      try { await rollback(item); } catch { rollbackFailures += 1; }
    }
    throw new PartialApplyError('Sequential change failed and rollback was attempted.', error, rollbackFailures);
  }
}
